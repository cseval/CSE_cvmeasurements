"""
Single-photo measurement pipeline.

Photo setup:
  - Stand in a T-pose (arms extended horizontally, hands flat, fingers together,
    palms facing the camera)
  - Tape the printed ArUco marker to the wall at wrist height beside you
  - Camera at chest height, far enough back that your full body fits in frame
  - Keep the marker flat and facing the lens directly (no tilt)

Usage:
    python pipeline.py <image_path>

Example:
    python pipeline.py samples/tpose.jpg
"""

import argparse
import cv2
import mediapipe.python.solutions.pose  as mp_pose
import mediapipe.python.solutions.hands as mp_hands
import numpy as np
from pathlib import Path

from calibrate  import detect_marker
from measure    import measure_height, measure_wingspan, measure_hand_width, wingspan_tips, height_endpoints
from visualize  import draw_diagnostics

POSE_CONF        = 0.7
HAND_CONF        = 0.5
MIN_HAND_CROP_PX = 400   # upsample hand crop to this size for better detection
HAND_PADDING     = 0.3   # fractional padding around hand bounding box

PoseLM = mp_pose.PoseLandmark


def _load_image(path: str) -> np.ndarray:
    """Load JPEG, PNG, or HEIC — returns a BGR numpy array."""
    if Path(path).suffix.lower() in (".heic", ".heif"):
        from pillow_heif import register_heif_opener
        from PIL import Image
        register_heif_opener()
        pil_img = Image.open(path).convert("RGB")
        return cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
    frame = cv2.imread(path)
    if frame is None:
        raise FileNotFoundError(f"Could not read image: {path}")
    return frame


def _crop_hand(frame: np.ndarray, pose_lms, side: str = "right"):
    """
    Crop and upsample the hand region using pose landmarks.
    Returns (crop_rgb, scale_factor, (x0, y0, x1, y1)) where the bounds
    allow converting crop landmark coords back to full-image pixels.
    """
    h, w = frame.shape[:2]

    if side == "right":
        anchors = [PoseLM.RIGHT_WRIST, PoseLM.RIGHT_INDEX,
                   PoseLM.RIGHT_PINKY, PoseLM.RIGHT_THUMB]
    else:
        anchors = [PoseLM.LEFT_WRIST, PoseLM.LEFT_INDEX,
                   PoseLM.LEFT_PINKY, PoseLM.LEFT_THUMB]

    xs = [pose_lms[lm].x for lm in anchors]
    ys = [pose_lms[lm].y for lm in anchors]
    span = max(max(xs) - min(xs), max(ys) - min(ys))

    x0 = max(0, int((min(xs) - span * HAND_PADDING) * w))
    x1 = min(w, int((max(xs) + span * HAND_PADDING) * w))
    y0 = max(0, int((min(ys) - span * HAND_PADDING) * h))
    y1 = min(h, int((max(ys) + span * HAND_PADDING) * h))

    crop = frame[y0:y1, x0:x1]
    if crop.size == 0:
        return None, None, None

    crop_w = x1 - x0
    target = max(MIN_HAND_CROP_PX, crop_w)
    scale  = target / crop_w
    resized = cv2.resize(crop, (0, 0), fx=scale, fy=scale,
                         interpolation=cv2.INTER_CUBIC)
    rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
    return rgb, scale, (x0, y0, x1, y1)


def _hand_width_from_crop(frame: np.ndarray, pose_lms,
                           px_per_cm: float) -> tuple:
    """
    Try MediaPipe Hands on cropped+upsampled hand regions for both hands.
    Returns (width_cm, source_label, crop_tips) where crop_tips maps
    'left'/'right' to the middle fingertip (x, y) in full-image pixels.
    """
    from measure import MIDDLE_TIP
    crop_tips = {}
    width_cm  = None
    source    = None

    for side in ("right", "left"):
        crop_rgb, scale, bounds = _crop_hand(frame, pose_lms, side)
        if crop_rgb is None:
            continue

        crop_h, crop_w = crop_rgb.shape[:2]
        x0, y0, x1, y1 = bounds

        with mp_hands.Hands(
            static_image_mode=True,
            max_num_hands=1,
            min_detection_confidence=HAND_CONF,
        ) as hands:
            out = hands.process(crop_rgb)
            if out.multi_hand_landmarks:
                lms = out.multi_hand_landmarks[0]

                # Convert middle fingertip back to full-image coordinates.
                tip = lms.landmark[MIDDLE_TIP]
                crop_tips[side] = (
                    int(x0 + tip.x * (x1 - x0)),
                    int(y0 + tip.y * (y1 - y0)),
                )

                if width_cm is None:
                    width_cm = measure_hand_width(
                        lms, crop_w, crop_h,
                        px_per_cm * scale,
                    )
                    source = f"MediaPipe Hands (cropped {side} hand)"

    return (round(width_cm, 1) if width_cm else None), source, crop_tips


def run(image_path: str, debug: bool = False, marker_cm: float = 20.0) -> tuple[dict, str | None]:
    frame = _load_image(image_path)
    h, w  = frame.shape[:2]
    rgb   = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

    px_per_cm, marker_corners = detect_marker(frame, marker_cm)
    if px_per_cm is None:
        raise RuntimeError(
            "ArUco marker not detected.\n"
            "  - Run generate_marker.py to create marker/marker_20cm.png\n"
            "  - Print it so the black square is exactly 20 cm x 20 cm\n"
            "  - Place it beside you at wrist height, facing the camera flat"
        )

    results           = {"px_per_cm": round(px_per_cm, 2)}
    warnings          = []
    hand_width_source = None
    pose_lms          = None
    hand_lms          = None
    all_hands_lms     = None
    wingspan_pts      = None

    # Pose: height + wingspan (wingspan may be upgraded below if hands found)
    with mp_pose.Pose(
        static_image_mode=True,
        model_complexity=2,
        min_detection_confidence=POSE_CONF,
    ) as pose:
        out = pose.process(rgb)
        if out.pose_landmarks is None:
            warnings.append("No pose detected — check that your full body is in frame.")
        else:
            pose_lms = out.pose_landmarks.landmark
            results["height_cm"]   = round(measure_height(pose_lms, h, px_per_cm), 1)
            results["wingspan_cm"] = round(measure_wingspan(pose_lms, w, h, px_per_cm), 1)
            wingspan_pts = wingspan_tips(pose_lms, w, h, None)

    # Hands: crop-based detection, no pose fallback
    if pose_lms is not None:
        # First try full-image detection (works if hands are large enough)
        with mp_hands.Hands(
            static_image_mode=True,
            max_num_hands=2,
            min_detection_confidence=HAND_CONF,
        ) as hands:
            out = hands.process(rgb)
            if out.multi_hand_landmarks:
                all_hands_lms = out.multi_hand_landmarks
                hand_lms      = all_hands_lms[0]
                results["hand_width_cm"] = round(
                    measure_hand_width(hand_lms, w, h, px_per_cm), 1
                )
                hand_width_source = "MediaPipe Hands (full image)"

                # Upgrade wingspan to hands-model middle fingertips when both
                # hands are visible -- more accurate than pose index landmarks.
                if len(all_hands_lms) >= 2:
                    results["wingspan_cm"] = round(
                        measure_wingspan(pose_lms, w, h, px_per_cm, all_hands_lms), 1
                    )
                    wingspan_pts = wingspan_tips(pose_lms, w, h, all_hands_lms)

        # Fall back to cropped detection if full-image failed
        if "hand_width_cm" not in results:
            width_cm, source, crop_tips = _hand_width_from_crop(frame, pose_lms, px_per_cm)
            if width_cm is not None:
                results["hand_width_cm"] = width_cm
                hand_width_source = source
            else:
                warnings.append(
                    "Hand span could not be detected — try better lighting or move hands closer."
                )
        else:
            # Full-image detection found hand(s) but may have missed one.
            # Run crop detection anyway to collect fingertips for wingspan.
            _, _, crop_tips = _hand_width_from_crop(frame, pose_lms, px_per_cm)

        # If full-image detection didn't find both hands, use crop fingertips
        # for wingspan instead of the less-accurate pose index fallback.
        if (all_hands_lms is None or len(all_hands_lms) < 2) and len(crop_tips) == 2:
            tips = sorted(crop_tips.values(), key=lambda p: p[0])
            left_pt, right_pt = tips[0], tips[1]
            dx = right_pt[0] - left_pt[0]
            dy = right_pt[1] - left_pt[1]
            results["wingspan_cm"] = round(np.hypot(dx, dy) / px_per_cm, 1)
            wingspan_pts = (left_pt, right_pt)

    # Return endpoint coordinates so the frontend can render draggable handles.
    if pose_lms is not None and 'height_cm' in results:
        crown_pt, heel_pt = height_endpoints(pose_lms, w, h)
        endpoints = {
            'height': {'crown': list(crown_pt), 'heel': list(heel_pt)},
        }
        if wingspan_pts is not None:
            endpoints['wingspan'] = {
                'left':  list(wingspan_pts[0]),
                'right': list(wingspan_pts[1]),
            }
        if hand_lms is not None and 'hand_width_cm' in results:
            thumb = hand_lms.landmark[4]
            pinky = hand_lms.landmark[20]
            endpoints['hand'] = {
                'thumb': [int(thumb.x * w), int(thumb.y * h)],
                'pinky': [int(pinky.x * w), int(pinky.y * h)],
            }
        results['endpoints'] = endpoints
        results['img_width']  = w
        results['img_height'] = h

    if debug:
        import base64
        diag = draw_diagnostics(frame, marker_corners, pose_lms, hand_lms,
                                all_hands_lms, results, wingspan_pts, marker_cm)
        _, buf     = cv2.imencode('.jpg', diag,  [cv2.IMWRITE_JPEG_QUALITY, 85])
        _, raw_buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
        results['debug_image'] = base64.b64encode(buf).decode()
        results['raw_image']   = base64.b64encode(raw_buf).decode()

    if warnings:
        results['warnings'] = warnings

    return results, hand_width_source


def main():
    parser = argparse.ArgumentParser(
        description="Measure height, wingspan, and hand width from one T-pose photo"
    )
    parser.add_argument("image", help="Path to T-pose photo")
    parser.add_argument("--debug", action="store_true",
                        help="Save a diagnostic overlay image alongside the input")
    args = parser.parse_args()

    measurements, hand_source = run(args.image, debug=args.debug)

    if args.debug and 'debug_image' in measurements:
        import base64
        img_bytes = base64.b64decode(measurements.pop('debug_image'))
        out_path = Path(args.image).with_stem(Path(args.image).stem + "_debug").with_suffix(".jpg")
        out_path.write_bytes(img_bytes)
        print(f"Diagnostic image saved to {out_path}")

    print("\nResults:")
    for key, val in measurements.items():
        if key in ("px_per_cm", "warnings"):
            continue
        print(f"  {key}: {val} cm")
    print(f"\n  Scale: {measurements['px_per_cm']} px/cm")
    if hand_source:
        print(f"  Hand span method: {hand_source}")
    for w in measurements.get('warnings', []):
        print(f"  WARNING: {w}")


if __name__ == "__main__":
    main()

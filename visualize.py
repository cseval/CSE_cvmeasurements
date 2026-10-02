"""
Diagnostic overlay for the CV measurement pipeline.

Draws the detected ArUco marker, the pose landmarks used for each
measurement, labelled measurement lines, and a scale bar onto a copy
of the source frame.  Call draw_diagnostics() and save the result with
cv2.imwrite() or PIL.
"""

import cv2
import numpy as np
import mediapipe.python.solutions.pose as mp_pose

from measure import HEAD_OFFSET_RATIO

PoseLM = mp_pose.PoseLandmark

# Colors are BGR.
COLOR_MARKER    = (0,   200,  0)    # green  -- ArUco marker outline
COLOR_HEIGHT    = (200,  80,  0)    # blue   -- height line
COLOR_WINGSPAN  = (0,   140, 220)   # orange -- wingspan line
COLOR_HAND      = (180,   0, 180)   # purple -- hand width line
COLOR_LANDMARK  = (255, 255, 255)   # white  -- landmark dots
COLOR_CROWN     = (0,    80, 255)   # red    -- estimated crown
COLOR_LABEL_BG  = (30,   30,  30)   # near-black label background
COLOR_SCALE     = (220, 220, 220)   # light grey -- scale bar

LINE_THICKNESS  = 3
DOT_RADIUS      = 8
FONT            = cv2.FONT_HERSHEY_SIMPLEX
FONT_SCALE      = 1.1
FONT_THICKNESS  = 2


def _pt(lm, w: int, h: int) -> tuple[int, int]:
    """Convert a normalised landmark to pixel coordinates."""
    return (int(lm.x * w), int(lm.y * h))


def _label(img: np.ndarray, text: str, pos: tuple[int, int],
           color: tuple[int, int, int]) -> None:
    """Draw text with a dark background box for legibility."""
    (tw, th), baseline = cv2.getTextSize(text, FONT, FONT_SCALE, FONT_THICKNESS)
    x, y = pos
    pad = 6
    cv2.rectangle(img,
                  (x - pad, y - th - pad),
                  (x + tw + pad, y + baseline + pad),
                  COLOR_LABEL_BG, cv2.FILLED)
    cv2.putText(img, text, (x, y), FONT, FONT_SCALE, color, FONT_THICKNESS,
                cv2.LINE_AA)


def _draw_marker(img: np.ndarray, corners: np.ndarray, marker_cm: float) -> None:
    """Draw the ArUco marker boundary and corner dots."""
    pts = corners.astype(np.int32).reshape((-1, 1, 2))
    cv2.polylines(img, [pts], isClosed=True, color=COLOR_MARKER,
                  thickness=LINE_THICKNESS)
    for pt in corners:
        cv2.circle(img, (int(pt[0]), int(pt[1])), DOT_RADIUS // 2,
                   COLOR_MARKER, -1)
    # Label near the top-left corner.
    tl = corners[0]
    _label(img, f"ArUco marker ({int(marker_cm)} cm)", (int(tl[0]), int(tl[1]) - 16),
           COLOR_MARKER)


def _draw_height(img: np.ndarray, pose_lms, w: int, h: int,
                 px_per_cm: float, height_cm: float) -> None:
    """Draw the crown-to-heel height line and its landmarks."""
    nose       = pose_lms[PoseLM.NOSE]
    left_heel  = pose_lms[PoseLM.LEFT_HEEL]
    right_heel = pose_lms[PoseLM.RIGHT_HEEL]

    heel_y  = max(left_heel.y, right_heel.y)
    span    = heel_y - nose.y
    crown_y = nose.y - span * HEAD_OFFSET_RATIO

    crown_px = (int(nose.x * w), int(crown_y * h))
    heel_px  = (int(nose.x * w), int(heel_y * h))

    cv2.line(img, crown_px, heel_px, COLOR_HEIGHT, LINE_THICKNESS)

    cv2.circle(img, crown_px, DOT_RADIUS, COLOR_CROWN, -1)
    cv2.circle(img, _pt(pose_lms[PoseLM.LEFT_HEEL],  w, h), DOT_RADIUS,
               COLOR_LANDMARK, -1)
    cv2.circle(img, _pt(pose_lms[PoseLM.RIGHT_HEEL], w, h), DOT_RADIUS,
               COLOR_LANDMARK, -1)
    cv2.circle(img, _pt(nose, w, h), DOT_RADIUS // 2, COLOR_LANDMARK, -1)

    mid_y = (crown_px[1] + heel_px[1]) // 2
    _label(img, f"height  {height_cm:.1f} cm", (crown_px[0] + 12, mid_y),
           COLOR_HEIGHT)


def _draw_wingspan(img: np.ndarray, wingspan_cm: float,
                   left_pt: tuple, right_pt: tuple) -> None:
    """Draw the fingertip-to-fingertip wingspan line using precomputed endpoints."""
    cv2.line(img, left_pt, right_pt, COLOR_WINGSPAN, LINE_THICKNESS)
    cv2.circle(img, left_pt,  DOT_RADIUS, COLOR_LANDMARK, -1)
    cv2.circle(img, right_pt, DOT_RADIUS, COLOR_LANDMARK, -1)

    mid_x = (left_pt[0] + right_pt[0]) // 2
    mid_y = (left_pt[1] + right_pt[1]) // 2
    _label(img, f"wingspan  {wingspan_cm:.1f} cm", (mid_x, mid_y - 16),
           COLOR_WINGSPAN)


def _draw_hand_width(img: np.ndarray, hand_lms, w: int, h: int,
                     hand_width_cm: float) -> None:
    """Draw the thumb tip to pinky tip hand span line."""
    thumb_tip = hand_lms.landmark[4]
    pinky_tip = hand_lms.landmark[20]

    pt_thumb = (int(thumb_tip.x * w), int(thumb_tip.y * h))
    pt_pinky = (int(pinky_tip.x * w), int(pinky_tip.y * h))

    cv2.line(img, pt_thumb, pt_pinky, COLOR_HAND, LINE_THICKNESS)
    cv2.circle(img, pt_thumb, DOT_RADIUS, COLOR_LANDMARK, -1)
    cv2.circle(img, pt_pinky, DOT_RADIUS, COLOR_LANDMARK, -1)

    mid_x = (pt_thumb[0] + pt_pinky[0]) // 2
    mid_y = (pt_thumb[1] + pt_pinky[1]) // 2
    _label(img, f"hand span  {hand_width_cm:.1f} cm", (mid_x, mid_y - 16),
           COLOR_HAND)


def _draw_scale_bar(img: np.ndarray, px_per_cm: float) -> None:
    """Draw a 10 cm scale bar in the bottom-left corner."""
    h, w = img.shape[:2]
    margin   = 40
    bar_cm   = 10
    bar_px   = int(bar_cm * px_per_cm)
    x0, y0   = margin, h - margin
    x1       = x0 + bar_px

    cv2.line(img, (x0, y0), (x1, y0), COLOR_SCALE, LINE_THICKNESS)
    cv2.line(img, (x0, y0 - 12), (x0, y0 + 12), COLOR_SCALE, LINE_THICKNESS)
    cv2.line(img, (x1, y0 - 12), (x1, y0 + 12), COLOR_SCALE, LINE_THICKNESS)
    _label(img, f"{bar_cm} cm", (x0, y0 - 24), COLOR_SCALE)


def draw_diagnostics(
    frame: np.ndarray,
    marker_corners: list | None,
    pose_lms,
    hand_lms,
    all_hands_lms,
    results: dict,
    wingspan_pts: tuple | None = None,
    marker_cm: float = 20.0,
) -> np.ndarray:
    """
    Return a copy of frame with measurement overlays drawn.

    Parameters
    ----------
    frame          : BGR image as returned by cv2 / _load_image
    marker_corners : list of refined (4, 2) float32 corner arrays from
                     detect_marker, or None if no marker was found
    pose_lms       : pose_landmarks.landmark list from MediaPipe, or None
    hand_lms       : single hand landmark object used for hand width, or None
    all_hands_lms  : list of all detected hand landmark objects, or None
    results        : dict with keys px_per_cm, height_cm, wingspan_cm,
                     hand_width_cm (subset is fine)
    wingspan_pts   : (left_pt, right_pt) pixel coords actually used for the
                     wingspan calculation, so the line matches the number
    """
    img = frame.copy()
    h, w = img.shape[:2]
    px_per_cm = results.get("px_per_cm", 1.0)

    if marker_corners:
        for corners in marker_corners:
            _draw_marker(img, corners, marker_cm)

    if pose_lms is not None:
        if "height_cm" in results:
            _draw_height(img, pose_lms, w, h, px_per_cm, results["height_cm"])
        if "wingspan_cm" in results and wingspan_pts is not None:
            _draw_wingspan(img, results["wingspan_cm"], *wingspan_pts)

    if hand_lms is not None and "hand_width_cm" in results:
        _draw_hand_width(img, hand_lms, w, h, results["hand_width_cm"])

    _draw_scale_bar(img, px_per_cm)

    return img

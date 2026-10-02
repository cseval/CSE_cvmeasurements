import numpy as np
import mediapipe.python.solutions.pose as mp_pose

PoseLM = mp_pose.PoseLandmark

# Nose sits roughly 10% of the nose-to-heel span below the crown.
# Empirically derived; adjust if you find systematic over/under-estimation.
HEAD_OFFSET_RATIO = 0.10

# MediaPipe Hands landmark index for the middle finger tip.
# Middle finger is the longest and gives the most accurate wingspan endpoint.
MIDDLE_TIP = 12


def _px_dist(lm_a, lm_b, frame_w: int, frame_h: int) -> float:
    dx = (lm_a.x - lm_b.x) * frame_w
    dy = (lm_a.y - lm_b.y) * frame_h
    return np.hypot(dx, dy)


def measure_height(pose_lms, frame_h: int, px_per_cm: float) -> float:
    """
    Vertical distance from estimated crown to lower heel, in cm.
    Requires a straight-on, full-body photo with both heels visible.
    """
    nose       = pose_lms[PoseLM.NOSE]
    left_heel  = pose_lms[PoseLM.LEFT_HEEL]
    right_heel = pose_lms[PoseLM.RIGHT_HEEL]

    heel_y  = max(left_heel.y, right_heel.y)
    span    = heel_y - nose.y
    crown_y = nose.y - span * HEAD_OFFSET_RATIO

    return ((heel_y - crown_y) * frame_h) / px_per_cm


def height_endpoints(pose_lms, frame_w: int, frame_h: int) -> tuple:
    """Return (crown_pt, heel_pt) pixel coordinates matching measure_height."""
    nose       = pose_lms[PoseLM.NOSE]
    left_heel  = pose_lms[PoseLM.LEFT_HEEL]
    right_heel = pose_lms[PoseLM.RIGHT_HEEL]
    heel_y  = max(left_heel.y, right_heel.y)
    span    = heel_y - nose.y
    crown_y = nose.y - span * HEAD_OFFSET_RATIO
    return (
        (int(nose.x * frame_w), int(crown_y * frame_h)),
        (int(nose.x * frame_w), int(heel_y  * frame_h)),
    )


def wingspan_tips(
    pose_lms,
    frame_w: int,
    frame_h: int,
    all_hands_lms=None,
) -> tuple[tuple[int, int], tuple[int, int]]:
    """
    Return (left_pt, right_pt) pixel coordinates for the wingspan endpoints.
    Always uses middle finger tip (landmark 12) from the hands model when
    available. If only one hand is detected, uses that hand's middle finger
    tip for one side and the pose index tip for the other.
    Falls back to pose index tips when no hands are detected.
    """
    def pose_wrist_to_index(side):
        wrist = pose_lms[PoseLM.LEFT_WRIST  if side == 'left' else PoseLM.RIGHT_WRIST]
        index = pose_lms[PoseLM.LEFT_INDEX  if side == 'left' else PoseLM.RIGHT_INDEX]
        wx, wy = wrist.x * frame_w, wrist.y * frame_h
        ix, iy = index.x * frame_w, index.y * frame_h
        dx, dy = ix - wx, iy - wy
        # Project 8% of the wrist→index length past the index tip to
        # approximate the middle fingertip when the hands model is unavailable.
        return (int(ix + dx * 0.08), int(iy + dy * 0.08))

    if all_hands_lms and len(all_hands_lms) >= 2:
        tips = []
        for hlm in all_hands_lms:
            tip = hlm.landmark[MIDDLE_TIP]
            tips.append((int(tip.x * frame_w), int(tip.y * frame_h)))
        tips.sort(key=lambda p: p[0])
        return tips[0], tips[-1]

    if all_hands_lms and len(all_hands_lms) == 1:
        tip = all_hands_lms[0].landmark[MIDDLE_TIP]
        hand_pt = (int(tip.x * frame_w), int(tip.y * frame_h))
        mid = frame_w / 2
        if hand_pt[0] < mid:
            return hand_pt, pose_wrist_to_index('right')
        else:
            return pose_wrist_to_index('left'), hand_pt

    # Fallback: wrist-to-index vector for both sides
    pt_l = pose_wrist_to_index('left')
    pt_r = pose_wrist_to_index('right')
    return (pt_l, pt_r) if pt_l[0] < pt_r[0] else (pt_r, pt_l)


def measure_wingspan(
    pose_lms,
    frame_w: int,
    frame_h: int,
    px_per_cm: float,
    all_hands_lms=None,
) -> float:
    """
    Fingertip-to-fingertip distance in cm.

    Uses middle finger tips from the hands model when both hands are detected
    (more precise than pose landmarks).  Falls back to pose index fingertips.
    Requires arms extended horizontally at shoulder height.
    """
    left_pt, right_pt = wingspan_tips(pose_lms, frame_w, frame_h, all_hands_lms)
    dx = right_pt[0] - left_pt[0]
    dy = right_pt[1] - left_pt[1]
    return np.hypot(dx, dy) / px_per_cm


def measure_hand_width(hand_lms, frame_w: int, frame_h: int, px_per_cm: float) -> float:
    """
    Thumb tip to pinky tip distance in cm (open hand span).
    Landmark 4  = thumb tip
    Landmark 20 = pinky tip
    """
    thumb_tip = hand_lms.landmark[4]
    pinky_tip = hand_lms.landmark[20]
    return _px_dist(thumb_tip, pinky_tip, frame_w, frame_h) / px_per_cm

"""Schema-agnostic persistence contract for the CV measurement station.

The station API never names a specific target database. A concrete adapter
(chosen via the SCHEMA_PROFILE env var — see persistence/__init__.py) maps
this contract onto whichever lab schema is in play:

  profile "a"  ->  new_lab_pipeline   (NEW Pipeline/new-lab-pipeline-pdr.md)
  profile "b"  ->  cse_db_v2_dev      (NEW Pipeline/sql/01_create_cse_v2_schema.sql)

Rules baked in here (HANDOFF-NFC-REBUILD.md §5 invariants):
  * No PII in any method — a UID is an identifier, never a credential.
  * Capture never requires enrollment; an unenrolled tap still resolves.
  * Every save creates a NEW trial; a prior visit is never overwritten.
  * All measurement values are stored as DECIMAL centimeters; inches/feet
    are a display-time conversion only.
"""
from __future__ import annotations

import re
from abc import ABC, abstractmethod
from datetime import datetime, timezone

# 8-20 hex chars (4-10 bytes), even length because a UID is byte-pair hex.
# Do NOT hard-code 14: an NTAG21x is 7 bytes (14 chars), a Mifare Classic
# is 4 bytes (8 chars), and the chip family on the ordered bracelets is
# still an open project item (handoff §3.3).
UID_RE = re.compile(r"^[0-9A-F]{8,20}$")

# The only marker sizes the station offers (must match generate_marker.ALL_SIZES).
MARKER_SIZES = (12.0, 16.0, 20.0)

# Columns of movement_screen_result (migrations/02) — the §6.1 option (a)
# table, identical shape under both profiles.
RESULT_COLUMNS = (
    "height_cm", "wingspan_cm", "hand_span_cm", "marker_cm", "capture_method",
    "age", "weight",
    "hips_r_hip_er", "hips_r_hip_ir", "hips_l_hip_er", "hips_l_hip_ir",
    "tspine_tspine_rot_l", "tspine_tspine_rot_r",
    "grip_grip_str_r", "grip_grip_str_l",
)


def validate_uid(raw: str, prefix: str = "") -> str:
    """Validate a reader-emitted UID and return the bare uppercase hex.

    `prefix` mirrors the firmware PREFIX setting (e.g. "BR-"): if present
    it is stripped before validation. Anything malformed is a hard error —
    a bad tap must fail loudly, never be stored.
    """
    if not isinstance(raw, str):
        raise ValueError("UID must be a string")
    uid = raw.strip().upper()
    p = (prefix or "").strip().upper()
    if p and uid.startswith(p):
        uid = uid[len(p):]
    if not UID_RE.match(uid):
        raise ValueError(
            "invalid tag UID: expected 8-20 uppercase hex chars (even length)"
            + (f" after prefix {prefix!r}" if p else "")
        )
    if len(uid) % 2 != 0:
        raise ValueError(f"invalid tag UID: odd hex length {len(uid)}")
    return uid


def parse_dt(value) -> datetime | None:
    """Parse an ISO-8601 string (app clocks are local; normalize to UTC)."""
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if dt.tzinfo is not None:
            dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
        return dt
    except (ValueError, TypeError):
        return None


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _dec(v):
    if v in (None, ""):
        return None
    return round(float(v), 2)


def _assess_int(assessment: dict, key: str):
    v = assessment.get(key)
    return None if v in (None, "") else int(v)


def build_result_params(trial_id, cap: dict, assessment: dict) -> list:
    """Ordered parameter list for UPSERT_RESULT_SQL (trial_id + 16 columns).

    The app speaks `hand_width_cm` (pipeline vocabulary); the table stores
    `hand_span_cm`. Accept either key on the wire.
    """
    return [
        trial_id,
        _dec(cap.get("height_cm")),
        _dec(cap.get("wingspan_cm")),
        _dec(cap.get("hand_span_cm", cap.get("hand_width_cm"))),
        _dec(cap.get("marker_cm")),
        cap.get("method") or "cv",
        _assess_int(assessment, "age"),
        _dec(assessment.get("weight")),
        _assess_int(assessment, "hips_r_hip_er"),
        _assess_int(assessment, "hips_r_hip_ir"),
        _assess_int(assessment, "hips_l_hip_er"),
        _assess_int(assessment, "hips_l_hip_ir"),
        _assess_int(assessment, "tspine_tspine_rot_l"),
        _assess_int(assessment, "tspine_tspine_rot_r"),
        _assess_int(assessment, "grip_grip_str_r"),
        _assess_int(assessment, "grip_grip_str_l"),
    ]


def upsert_result_sql() -> str:
    """One result row per trial. Re-saving the same trial (additional-info
    step, or a correction before the first sync) UPDATEs the row instead of
    forking a duplicate. COALESCE keeps fields a second save omitted.

    Uses the MySQL 8.0.19+ `AS new` alias form (VALUES() is deprecated).
    """
    cols = "capture_trial_id, " + ", ".join(RESULT_COLUMNS)
    ph = ", ".join(["%s"] * (len(RESULT_COLUMNS) + 1))
    updates = ",\n".join(f"{c} = COALESCE(new.{c}, {c})" for c in RESULT_COLUMNS)
    return (
        f"INSERT INTO movement_screen_result AS new ({cols}) VALUES ({ph}) "
        f"ON DUPLICATE KEY UPDATE {updates}, updated_at = NOW(3)"
    )


UPSERT_RESULT_SQL = upsert_result_sql()


class PersistenceAdapter(ABC):
    """The full persistence surface the station app needs."""

    profile: str = "abstract"

    @abstractmethod
    def resolve_subject(self, uid: str) -> dict:
        """UID in, opaque subject handle out. NEVER returns identity.

        Returns:
          subject_key : opaque handle (A: anonymous_capture_subject id,
                        B: cse_id) — the only thing the app may carry
          enrolled    : bool — an active tag<->athlete assignment exists
          first_seen  : bool — the subject was created by this call
        """

    @abstractmethod
    def save_capture(self, payload: dict) -> dict:
        """Write capture_session + capture_trial (trial_type=
        'movement_screen') + one movement_screen_result row.

        With payload["trial_ref"] set: update that trial's result row only
        (the additional-info path) — never a new trial.
        """

    @abstractmethod
    def log_scan(self, entry: dict) -> int:
        """Append one row to the station tap audit log — every tap,
        resolved or not, successful capture or not."""

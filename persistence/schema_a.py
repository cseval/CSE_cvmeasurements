"""Schema A adapter — target database `new_lab_pipeline` (PDR §7).

Tables used:
  nfc_tag, nfc_tag_assignment, anonymous_capture_subject,
  capture_session, capture_trial,
  movement_screen_result   (migrations/02 — §6.1 option (a), pending confirm)
  station_tap_log          (migrations/02 — the lab tap log from the NFC
                           station validation protocol. NOT an alias of
                           Schema B's scan_event: it carries station_id /
                           bracelet_uid / tapped_at / tap_round so closed
                           systems join on a timestamp window.)

Env: DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD point at the
new_lab_pipeline database on the Azure MySQL Flexible Server.
"""
from __future__ import annotations

import os

import mysql.connector

from .base import (
    MARKER_SIZES,
    PersistenceAdapter,
    UPSERT_RESULT_SQL,
    build_result_params,
    parse_dt,
    utcnow,
    validate_uid,
)

# Test-mode captures (no subject) hang off this well-known synthetic
# subject so they stay visible and separable in the data. Its token is
# deliberately not valid UID hex, so it can never collide with a real tap.
TEST_SUBJECT_TOKEN = "CVSTATION_TEST"


def _connect() -> mysql.connector.MySQLConnection:
    return mysql.connector.connect(
        host=os.environ["DB_HOST"],
        port=int(os.environ.get("DB_PORT", 3306)),
        database=os.environ["DB_NAME"],
        user=os.environ["DB_USER"],
        password=os.environ["DB_PASSWORD"],
    )


class SchemaAAdapter(PersistenceAdapter):
    profile = "a"

    # ── helpers ────────────────────────────────────────────────────────
    def _upsert_subject(self, cur, uid: str | None) -> tuple[int, bool]:
        """Create-if-new the (nfc_tag, anonymous_capture_subject) pair.

        Per the PDR, subject_token is "usually equal to nfc_tag.tag_uid,
        but abstracted" — we use the bare UID as the token (the tempting
        shortcut the PDR explicitly allows for the NFC method) and set
        capture_method so a future QR/manual method can share the table.
        Returns (subject_id, enrolled).
        """
        if uid is None:
            token, method, tag_id = TEST_SUBJECT_TOKEN, "manual", None
        else:
            cur.execute(
                "INSERT INTO nfc_tag (tag_uid) VALUES (%s) "
                "ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)",
                (uid,),
            )
            tag_id = cur.lastrowid
            token, method = uid, "nfc"

        cur.execute(
            "INSERT INTO anonymous_capture_subject (subject_token, capture_method, nfc_tag_id) "
            "VALUES (%s, %s, %s) "
            "ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)",
            (token, method, tag_id),
        )
        subject_id = cur.lastrowid

        enrolled = False
        if tag_id is not None:
            # nfc_tag_assignment is the ONLY tag<->athlete link; a tap with
            # no active row there is unenrolled — capture proceeds anyway.
            cur.execute(
                "SELECT 1 FROM nfc_tag_assignment "
                "WHERE tag_id = %s AND active_to IS NULL LIMIT 1",
                (tag_id,),
            )
            enrolled = cur.fetchone() is not None
        return subject_id, enrolled

    # ── contract ───────────────────────────────────────────────────────
    def resolve_subject(self, uid: str) -> dict:
        uid = validate_uid(uid)
        conn = _connect()
        cur = conn.cursor()
        try:
            self._upsert_subject(cur, uid)
            cur.execute(
                "SELECT TIMESTAMPDIFF(SECOND, created_at, NOW()) "
                "FROM anonymous_capture_subject WHERE subject_token = %s",
                (uid,),
            )
            row = cur.fetchone()
            first_seen = bool(row and row[0] is not None and row[0] <= 2)
            conn.commit()
            # subject_key is opaque to the app; the app never needs the id
            # to do anything the save path does not already handle.
            cur.execute("SELECT id FROM anonymous_capture_subject WHERE subject_token = %s", (uid,))
            subject_id = cur.fetchone()[0]
            return {
                "subject_key": str(subject_id),
                "enrolled": self._enrolled_for(cur, uid),
                "first_seen": first_seen,
            }
        finally:
            conn.close()

    def _enrolled_for(self, cur, uid: str) -> bool:
        cur.execute(
            "SELECT 1 FROM nfc_tag_assignment a JOIN nfc_tag t ON a.tag_id = t.id "
            "WHERE t.tag_uid = %s AND a.active_to IS NULL LIMIT 1",
            (uid,),
        )
        return cur.fetchone() is not None

    def save_capture(self, payload: dict) -> dict:
        raw_uid = payload.get("raw_uid")
        uid = validate_uid(raw_uid, payload.get("prefix", "")) if raw_uid else None
        st = payload.get("station") or {}
        cap = payload.get("capture") or {}
        assessment = cap.get("assessment") or {}

        marker_cm = float(cap.get("marker_cm") or 20.0)
        if marker_cm not in MARKER_SIZES:
            raise ValueError(f"marker_cm must be one of {list(MARKER_SIZES)}")
        if (cap.get("trial_type") or "movement_screen") != "movement_screen":
            raise ValueError("this station only writes trial_type='movement_screen'")
        if (cap.get("method") or "cv") not in ("cv", "manual"):
            raise ValueError("capture.method must be 'cv' or 'manual'")
        if cap.get("height_cm") in (None, "") and cap.get("wingspan_cm") in (None, "") \
                and cap.get("hand_span_cm", cap.get("hand_width_cm")) in (None, ""):
            raise ValueError("at least one measurement value is required")
        notes = (cap.get("notes") or "")[:255] or None
        validity = 1 if cap.get("validity", 1) else 0
        trial_ts = parse_dt(cap.get("captured_at")) or utcnow()

        event_session_id = st.get("event_session_id")
        if event_session_id in (None, ""):
            event_session_id = None
        else:
            try:
                event_session_id = int(event_session_id)
            except (TypeError, ValueError):
                raise ValueError("station.event_session_id must be an integer")

        conn = _connect()
        cur = conn.cursor()
        try:
            # ── additional-info path: update the existing trial only ──
            if payload.get("trial_ref"):
                trial_id = int(payload["trial_ref"])
                cur.execute(
                    "SELECT id FROM capture_trial WHERE id = %s AND trial_type = 'movement_screen'",
                    (trial_id,),
                )
                if cur.fetchone() is None:
                    raise LookupError(f"trial {trial_id} not found")
                cur.execute(UPSERT_RESULT_SQL, build_result_params(trial_id, cap, assessment))
                conn.commit()
                return {
                    "trial_ref": str(trial_id),
                    "session_ref": None,
                    "action": "updated",
                    "enrolled": None,
                    "test_mode": uid is None,
                }

            # ── create path: session (reuse today's) + NEW trial ──
            subject_id, enrolled = self._upsert_subject(cur, uid)

            now = utcnow()
            cur.execute(
                """SELECT id FROM capture_session
                   WHERE anonymous_capture_subject_id = %s
                     AND capture_date = %s
                     AND ((%s IS NULL AND event_session_id IS NULL) OR event_session_id = %s)
                   ORDER BY id DESC LIMIT 1""",
                (subject_id, now.date(), event_session_id, event_session_id),
            )
            row = cur.fetchone()
            if row:
                session_id = row[0]
            else:
                cur.execute(
                    """INSERT INTO capture_session
                       (anonymous_capture_subject_id, event_session_id, capture_date,
                        lab_location, session_type, source_device, operator)
                       VALUES (%s, %s, %s, %s, 'station_capture', %s, %s)""",
                    (
                        subject_id,
                        event_session_id,
                        now.date(),
                        (st.get("lab_location") or "")[:100] or None,
                        (st.get("source_device") or "cv_app")[:50],
                        (st.get("operator") or "")[:100] or None,
                    ),
                )
                session_id = cur.lastrowid

            # A repeat visit is a repeat trial — never an overwrite.
            cur.execute(
                "SELECT COALESCE(MAX(trial_number), 0) + 1 "
                "FROM capture_trial WHERE capture_session_id = %s",
                (session_id,),
            )
            trial_number = cur.fetchone()[0]
            cur.execute(
                """INSERT INTO capture_trial
                   (capture_session_id, trial_number, trial_type, trial_timestamp, validity_flag, notes)
                   VALUES (%s, %s, 'movement_screen', %s, %s, %s)""",
                (session_id, trial_number, trial_ts, validity, notes),
            )
            trial_id = cur.lastrowid

            cur.execute(UPSERT_RESULT_SQL, build_result_params(trial_id, cap, assessment))
            conn.commit()
            return {
                "trial_ref": str(trial_id),
                "session_ref": str(session_id),
                "action": "created",
                "enrolled": enrolled,
                "test_mode": uid is None,
            }
        finally:
            conn.close()

    def log_scan(self, entry: dict) -> int:
        raw = str(entry.get("raw_scan_value") or "")[:64]
        uid = entry.get("uid")
        uid = validate_uid(uid, entry.get("prefix", "")) if uid else None
        st = entry.get("station") or {}
        station_id = (st.get("source_device") or "cv_app")[:50]
        tapped_at = parse_dt(entry.get("scanned_at")) or utcnow()
        resolved = bool(entry.get("resolved"))
        enrolled = bool(entry.get("enrolled"))

        conn = _connect()
        cur = conn.cursor()
        try:
            # tap_round: per-station, per-day sequence (validation-protocol
            # window-join column).
            cur.execute(
                "SELECT COALESCE(MAX(tap_round), 0) + 1 FROM station_tap_log "
                "WHERE station_id = %s AND DATE(tapped_at) = %s",
                (station_id, tapped_at.date()),
            )
            tap_round = cur.fetchone()[0]
            cur.execute(
                """INSERT INTO station_tap_log
                   (station_id, bracelet_uid, tapped_at, tap_round, raw_scan_value,
                    resolved, enrolled, operator, device_id, capture_batch_id)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (
                    station_id,
                    (uid or raw or "TEST")[:20],
                    tapped_at,
                    tap_round,
                    raw or None,
                    resolved,
                    enrolled,
                    (st.get("operator") or entry.get("operator") or "")[:100] or None,
                    (st.get("device_id") or entry.get("device_id") or "")[:64] or None,
                    (entry.get("capture_batch_id") or "")[:64] or None,
                ),
            )
            scan_id = cur.lastrowid
            conn.commit()
            return scan_id
        finally:
            conn.close()

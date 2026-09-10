"""Schema B adapter — target database `cse_db_v2_dev`.

Tables used (NEW Pipeline/sql/01_create_cse_v2_schema.sql):
  cse_token, token_binding, capture_session, scan_event, station_source,
  capture_trial, movement_screen_result   (migrations/02 — §6.1 option (a),
                                          pending confirm; B's base schema
                                          has no trial table at all)

Notes:
  * Identity here is the abstract cse_token (TC-XXXX-XXXX), NOT the tag.
    A tap resolves through token_binding. An unenrolled tap MINTS AN
    UNCLAIMED token so capture never blocks on enrollment — the claim
    (identity_link) happens later in TC Locker. This is the
    Schema-B-native answer to the handoff's unenrolled-tap requirement,
    and a lost bracelet is a rebind to the same cse_id (history intact).
  * B has no event_session concept; station.event_session_id is ignored.
  * station_source_code is a lookup FK — 'cv_app' is already seeded for
    this app; an unknown code is a 400 with the available list.
  * scan_event is the audit log (raw_scan_value, cse_id nullable,
    resolved flag) — used as-is.
"""
from __future__ import annotations

import os
import random

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

ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"  # no 0/O/1/I look-alikes
DEFAULT_STATION = "cv_app"
TEST_CSE_ID = "TC-TEST-TEST"  # 12 chars, visibly synthetic


def _connect() -> mysql.connector.MySQLConnection:
    return mysql.connector.connect(
        host=os.environ["DB_HOST"],
        port=int(os.environ.get("DB_PORT", 3306)),
        database=os.environ["DB_NAME"],
        user=os.environ["DB_USER"],
        password=os.environ["DB_PASSWORD"],
    )


class SchemaBAdapter(PersistenceAdapter):
    profile = "b"

    # ── helpers ────────────────────────────────────────────────────────
    def _new_cse_id(self, cur) -> str:
        for _ in range(10):
            code = (
                "TC-"
                + "".join(random.choices(ALPHABET, k=4))
                + "-"
                + "".join(random.choices(ALPHABET, k=4))
            )
            cur.execute("SELECT 1 FROM cse_token WHERE cse_id = %s", (code,))
            if cur.fetchone() is None:
                return code
        raise RuntimeError("could not allocate a unique cse_id")

    def _resolve(self, cur, uid: str | None) -> tuple[str, bool, int | None]:
        """UID -> (cse_id, enrolled, binding_id).

        Unknown UIDs mint an UNCLAIMED token so capture proceeds; claim
        happens downstream (TC Locker writes identity_link). Test mode
        uses a well-known synthetic token.
        """
        if uid is None:
            cur.execute("SELECT 1 FROM cse_token WHERE cse_id = %s", (TEST_CSE_ID,))
            if cur.fetchone() is None:
                cur.execute(
                    "INSERT INTO cse_token (cse_id, status, issued_at) VALUES (%s, 'unclaimed', %s)",
                    (TEST_CSE_ID, utcnow()),
                )
            return TEST_CSE_ID, False, None

        cur.execute(
            """SELECT b.cse_id, t.status, b.binding_id
               FROM token_binding b
               JOIN cse_token t ON t.cse_id = b.cse_id
               WHERE b.uid = %s AND b.unbound_at IS NULL
               ORDER BY b.bound_at DESC
               LIMIT 1""",
            (uid,),
        )
        row = cur.fetchone()
        if row:
            return row[0], row[1] == "claimed", row[2]

        cse_id = self._new_cse_id(cur)
        cur.execute(
            "INSERT INTO cse_token (cse_id, status, issued_at) VALUES (%s, 'unclaimed', %s)",
            (cse_id, utcnow()),
        )
        return cse_id, False, None

    # ── contract ───────────────────────────────────────────────────────
    def resolve_subject(self, uid: str) -> dict:
        uid = validate_uid(uid)
        conn = _connect()
        cur = conn.cursor()
        try:
            cse_id, enrolled, binding_id = self._resolve(cur, uid)
            conn.commit()
            return {
                "subject_key": cse_id,
                "enrolled": enrolled,
                "first_seen": binding_id is None,
                "binding_id": binding_id,
            }
        finally:
            conn.close()

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
        station_code = (st.get("source_device") or DEFAULT_STATION)[:24]

        conn = _connect()
        cur = conn.cursor()
        try:
            # ── additional-info path: update the existing trial only ──
            if payload.get("trial_ref"):
                trial_id = int(payload["trial_ref"])
                cur.execute(
                    "SELECT trial_id FROM capture_trial "
                    "WHERE trial_id = %s AND trial_type = 'movement_screen'",
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

            # ── create path ──
            cur.execute("SELECT 1 FROM station_source WHERE station_source_code = %s", (station_code,))
            if cur.fetchone() is None:
                cur.execute(
                    "SELECT station_source_code FROM station_source "
                    "WHERE is_active = 1 ORDER BY station_source_code"
                )
                available = [r[0] for r in cur.fetchall()]
                raise ValueError(
                    f"station {station_code!r} is not in the station_source lookup; available: {available}"
                )

            cse_id, enrolled, binding_id = self._resolve(cur, uid)

            # One row per station visit: reuse the open session for this
            # subject at this station, else open one.
            now = utcnow()
            cur.execute(
                """SELECT session_id FROM capture_session
                   WHERE cse_id = %s AND station_source_code = %s AND closed_at IS NULL
                   ORDER BY opened_at DESC LIMIT 1""",
                (cse_id, station_code),
            )
            row = cur.fetchone()
            if row:
                session_id = row[0]
            else:
                cur.execute(
                    """INSERT INTO capture_session
                       (cse_id, station_source_code, lab_location, opened_at)
                       VALUES (%s, %s, %s, %s)""",
                    (cse_id, station_code, (st.get("lab_location") or "")[:64] or None, now),
                )
                session_id = cur.lastrowid

            cur.execute(
                "SELECT COALESCE(MAX(trial_number), 0) + 1 "
                "FROM capture_trial WHERE session_id = %s",
                (session_id,),
            )
            trial_number = cur.fetchone()[0]
            cur.execute(
                """INSERT INTO capture_trial
                   (session_id, cse_id, trial_number, trial_type, trial_timestamp, validity_flag, notes)
                   VALUES (%s, %s, %s, 'movement_screen', %s, %s, %s)""",
                (session_id, cse_id, trial_number, trial_ts, validity, notes),
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
                "binding_id": binding_id,
            }
        finally:
            conn.close()

    def log_scan(self, entry: dict) -> int:
        raw = str(entry.get("raw_scan_value") or "")[:64] or "UNKNOWN"
        st = entry.get("station") or {}
        station_code = (st.get("source_device") or DEFAULT_STATION)[:24]

        conn = _connect()
        cur = conn.cursor()
        try:
            cur.execute("SELECT 1 FROM station_source WHERE station_source_code = %s", (station_code,))
            if cur.fetchone() is None:
                # The audit log must never be dropped — fall back to the
                # seeded code rather than failing the whole tap.
                station_code = DEFAULT_STATION

            resolved = bool(entry.get("resolved"))
            cse_id = entry.get("subject_key") if resolved else None
            if cse_id:
                cur.execute("SELECT 1 FROM cse_token WHERE cse_id = %s", (cse_id,))
                if cur.fetchone() is None:
                    cse_id, resolved = None, False

            session_id = None
            if cse_id:
                cur.execute(
                    """SELECT session_id FROM capture_session
                       WHERE cse_id = %s AND station_source_code = %s AND closed_at IS NULL
                       ORDER BY opened_at DESC LIMIT 1""",
                    (cse_id, station_code),
                )
                row = cur.fetchone()
                if row:
                    session_id = row[0]

            scanned_at = parse_dt(entry.get("scanned_at")) or utcnow()
            cur.execute(
                """INSERT INTO scan_event
                   (raw_scan_value, cse_id, binding_id, resolved, station_source_code,
                    session_id, device_id, operator, scan_method, scanned_at)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'nfc', %s)""",
                (
                    raw,
                    cse_id,
                    entry.get("binding_id"),
                    resolved,
                    station_code,
                    session_id,
                    (st.get("device_id") or entry.get("device_id") or "")[:64] or None,
                    (st.get("operator") or entry.get("operator") or "")[:128] or None,
                    scanned_at,
                ),
            )
            scan_id = cur.lastrowid
            conn.commit()
            return scan_id
        finally:
            conn.close()

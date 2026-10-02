"""
Data layer for the CV measurement station.

Writes against new_lab_pipeline (the hybrid schema in
sql/01_create_new_lab_pipeline_hybrid.sql). It does not touch the production
database at all — no reads of `player`, `events` or `attendees`, and no writes
to production `lab_movement_screen`.

Two rules this module exists to keep.

1. Raw capture tables never carry athlete_id, player_id or cse_player_id.
   The only table linking a subject to an athlete is subject_identity_binding.

   There is exactly one place below that reads it, and it reads it with EXISTS
   to answer a single yes/no question: is this bracelet bound to anyone yet?
   It never selects athlete_id, and no function in this module returns a name,
   a cse_player_id, or anything else that identifies a person. The station
   operator never learns who they are measuring from this app.

2. CV is READ-ONLY for bracelet/subject setup (schema decision 1).

   nfc_tag, anonymous_capture_subject and subject_tag_binding are owned by
   check-in, admin provisioning and the binder. This module resolves through
   them and never inserts into them. An unknown UID is a workflow error to put
   in front of the operator, not a cue to create rows.

   The reason is a sequencing race rather than tidiness: if CV creates a
   subject on first sight while check-in is mid-flight for the same band, the
   captures land on one subject and the identity binding on another, and the
   athlete later binds their band and sees nothing. Pre-provisioning the
   bracelet inventory (decision 2) is what makes read-only safe — every band in
   the bin already resolves before anyone touches it.
"""

import logging
import os
from contextlib import contextmanager
from datetime import date, datetime, timezone

import mysql.connector
from dotenv import load_dotenv

import artifacts
from nfc import TapRejected, validate

load_dotenv()
log = logging.getLogger(__name__)

TRIAL_TYPE = "movement_screen"

# Plausible human ranges, used only to raise a scale warning. This is the sole
# check available on the operator-selected marker size: the pipeline derives
# px_per_cm by assuming the detected marker is the size the operator picked, so
# picking 20cm while holding a 12cm printout scales every value by 1.67 with no
# error anywhere. There is no second reference object in the frame to catch it,
# so the fallback is noticing that the answer is not a possible human.
PLAUSIBLE = {
    "height_cm": (100.0, 220.0),
    "wingspan_cm": (100.0, 230.0),
    "hand_span_cm": (10.0, 30.0),
}

_MOVEMENT_SCREEN_FIELDS = (
    "age_years", "weight_lb",
    "hip_er_r", "hip_ir_r", "hip_er_l", "hip_ir_l",
    "tspine_rot_l", "tspine_rot_r",
    "grip_str_r", "grip_str_l",
)


# --------------------------------------------------------------- connection

def _connect():
    return mysql.connector.connect(
        host=os.environ["DB_HOST"],
        port=int(os.environ.get("DB_PORT", 3306)),
        database=os.environ.get("DB_NAME", "new_lab_pipeline"),
        user=os.environ["DB_USER"],
        password=os.environ["DB_PASSWORD"],
        autocommit=False,
        time_zone="+00:00",
    )


@contextmanager
def _tx():
    """One transaction. Commits on clean exit, rolls back on anything else."""
    conn = _connect()
    try:
        cur = conn.cursor(dictionary=True)
        yield conn, cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def ping() -> bool:
    with _tx() as (_, cur):
        cur.execute("SELECT 1 AS ok")
        return cur.fetchone()["ok"] == 1


# ------------------------------------------------------------ station lookup

def get_station_source_id(cur, code: str) -> int:
    cur.execute(
        "SELECT `id` FROM `station_source` WHERE `code` = %s AND `active` = 1",
        (code,),
    )
    row = cur.fetchone()
    if not row:
        # Free-text station codes were the thing station_source exists to stop,
        # so an unknown code is an error rather than a row to auto-create.
        raise ValueError(
            f"Unknown station code '{code}'. Add it to station_source rather "
            f"than passing an unregistered code."
        )
    return row["id"]


# ---------------------------------------------------------------- scan log

def _log_scan(cur, *, raw_value, station_source_id, operator, device_label,
              valid_shape, resolved, subject_id=None, binding_id=None,
              tag_id=None, enrolled=None, note=None) -> int:
    """
    Every tap at this station, resolved or not.

    raw_value goes in exactly as the reader typed it. Do not normalize it here
    — a malformed scan is evidence about the hardware, and cleaning it up
    throws that away.
    """
    cur.execute(
        """INSERT INTO `scan_event`
             (`raw_scan_value`, `station_source_id`, `scanned_at`, `operator`,
              `device_label`, `valid_shape`, `resolved`,
              `anonymous_capture_subject_id`, `subject_tag_binding_id`,
              `nfc_tag_id`, `enrolled`, `note`)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
        (raw_value[:64], station_source_id, _utcnow(), operator, device_label,
         1 if valid_shape else 0, 1 if resolved else 0,
         subject_id, binding_id, tag_id,
         None if enrolled is None else (1 if enrolled else 0),
         note[:255] if note else None),
    )
    return cur.lastrowid


# ------------------------------------------------------------ tap resolution

def resolve_subject(raw_value: str, *, station_code: str, operator: str | None,
                    device_label: str | None) -> dict:
    """
    Turn a tap into an anonymous_capture_subject_id. Read-only.

    Resolves nfc_tag -> subject_tag_binding(active) -> anonymous_capture_subject
    and creates NONE of them. Logs a scan_event either way, including — and
    especially — for a scan that never resolves.

    Returns, and this is the entire contract — note what is absent:
        ok             bool
        reason         str | None    operator-readable, on failure
        remedy         str | None    what the operator should actually do
        subject_id     int | None
        subject_token  str | None    opaque, safe to show on screen
        enrolled       bool | None   is the bracelet bound to an athlete yet
        first_capture  bool | None   no capture_session exists for this subject
        scan_event_id  int
        uid_length     int | None    for recording observed chip behaviour

    No name. No cse_player_id. No athlete_id. Not on success, not on failure,
    not in a log line.
    """
    with _tx() as (_, cur):
        station_source_id = get_station_source_id(cur, station_code)
        return _resolve_in_tx(
            cur, raw_value, station_source_id=station_source_id,
            station_code=station_code, operator=operator,
            device_label=device_label,
        )


def _resolve_in_tx(cur, raw_value: str, *, station_source_id: int,
                   station_code: str, operator: str | None,
                   device_label: str | None) -> dict:
    """
    The body of resolve_subject, callable inside an existing transaction.

    Split out so save_capture can resolve a tap and write its trial atomically.
    That matters for the offline path: a station with no network cannot call
    /api/subject/resolve before measuring, so the capture carries the raw UID
    instead and the subject is resolved here, at sync time, in the same
    transaction that creates the trial.
    """
    def unresolved(reason: str, remedy: str, *, valid_shape: bool,
                   tag_id=None, uid_length=None) -> dict:
        """
        Log the tap and hand the operator something they can act on.

        Every one of these writes a scan_event. A band that could not be
        measured has to leave a trace, or the station audit cannot tell
        "nobody tapped" from "the tap went nowhere".
        """
        scan_id = _log_scan(
            cur, raw_value=raw_value, station_source_id=station_source_id,
            operator=operator, device_label=device_label,
            valid_shape=valid_shape, resolved=False, tag_id=tag_id,
            note=reason,
        )
        return {
            "ok": False, "reason": reason, "remedy": remedy,
            "subject_id": None, "subject_token": None, "enrolled": None,
            "first_capture": None, "scan_event_id": scan_id,
            "uid_length": uid_length,
        }

    try:
        uid = validate(raw_value)
    except TapRejected as exc:
        return unresolved(
            exc.reason,
            "Tap again, holding the band flat on the reader.",
            valid_shape=False,
        )

    # --- the tag itself. Read-only: an unknown UID is a provisioning gap.
    cur.execute(
        "SELECT `id`, `status` FROM `nfc_tag` WHERE `tag_uid` = %s", (uid,)
    )
    tag = cur.fetchone()
    if not tag:
        return unresolved(
            "Bracelet not recognised — this band has not been provisioned.",
            "Provision it in the check-in app (Admin, Provision bands), then "
            "tap again. Do not substitute another band.",
            valid_shape=True, uid_length=len(uid),
        )

    tag_id = tag["id"]

    # Mirrors the check-in app's tag_inactive rule. A band pulled from service
    # should not quietly keep accruing captures.
    if (tag["status"] or "issued") in ("lost", "retired"):
        return unresolved(
            f"This bracelet is marked {tag['status']}.",
            "Issue the athlete a different band at the desk.",
            valid_shape=True, tag_id=tag_id, uid_length=len(uid),
        )

    # --- the durable subject, reached through the binding. Also read-only.
    cur.execute(
        """SELECT `id`, `anonymous_capture_subject_id`
             FROM `subject_tag_binding`
            WHERE `nfc_tag_id` = %s AND `active_to` IS NULL""",
        (tag_id,),
    )
    binding = cur.fetchone()
    if not binding:
        return unresolved(
            "Bracelet is known but has no active subject binding.",
            "Re-provision this band in the check-in app. Measuring now would "
            "attach the data to nothing.",
            valid_shape=True, tag_id=tag_id, uid_length=len(uid),
        )

    subject_id = binding["anonymous_capture_subject_id"]
    binding_id = binding["id"]

    cur.execute(
        "SELECT `subject_token` FROM `anonymous_capture_subject` WHERE `id` = %s",
        (subject_id,),
    )
    subject_row = cur.fetchone()
    if not subject_row:
        # A binding pointing at a missing subject is a broken FK, not a
        # workflow problem. Surface it rather than inventing a subject.
        return unresolved(
            "Bracelet resolves to a subject that does not exist.",
            "Stop and report this band — the database is inconsistent.",
            valid_shape=True, tag_id=tag_id, uid_length=len(uid),
        )
    subject_token = subject_row["subject_token"]

    # --- is this bracelet bound to an athlete yet?
    #
    # EXISTS, deliberately. This is the only read of subject_identity_binding
    # in the whole app and it must stay a boolean. Identity binding is OPTIONAL
    # for capture: an anonymously-issued band measures perfectly well and gets
    # claimed later. The flag exists so staff can reconcile before the athlete
    # leaves, not so the station can gate on it.
    #
    # The OR mirrors the check-in app's own active-binding lookup, which
    # matches on either the tag or the subject.
    cur.execute(
        """SELECT EXISTS(
             SELECT 1 FROM `subject_identity_binding`
              WHERE `status` = 'active'
                AND (`anonymous_capture_subject_id` = %s OR `nfc_tag_id` = %s)
           ) AS bound""",
        (subject_id, tag_id),
    )
    enrolled = bool(cur.fetchone()["bound"])

    # Replaces the old new_subject flag, which meant "CV just created this".
    # CV creates nothing now, so the useful signal is whether any station has
    # captured against this subject before.
    cur.execute(
        """SELECT NOT EXISTS(
             SELECT 1 FROM `capture_session`
              WHERE `anonymous_capture_subject_id` = %s
           ) AS first_capture""",
        (subject_id,),
    )
    first_capture = bool(cur.fetchone()["first_capture"])

    scan_id = _log_scan(
        cur, raw_value=raw_value, station_source_id=station_source_id,
        operator=operator, device_label=device_label,
        valid_shape=True, resolved=True, subject_id=subject_id,
        binding_id=binding_id, tag_id=tag_id, enrolled=enrolled,
    )

    return {
        "ok": True, "reason": None, "remedy": None, "subject_id": subject_id,
        "subject_token": subject_token, "enrolled": enrolled,
        "first_capture": first_capture, "scan_event_id": scan_id,
        "uid_length": len(uid),
    }


# ------------------------------------------------------------- capture write

def _scale_warning(values: dict) -> str | None:
    """Flag any value outside a plausible human range. See PLAUSIBLE above."""
    bad = []
    for key, (lo, hi) in PLAUSIBLE.items():
        v = values.get(key)
        if v is None:
            continue
        if not (lo <= float(v) <= hi):
            bad.append(f"{key}={v} outside {lo}-{hi}cm")
    if not bad:
        return None
    return (
        "Implausible value(s): " + "; ".join(bad)
        + ". Check that the printed marker matches the selected marker size."
    )[:255]


def _get_or_create_session(cur, *, subject_id, station_source_id,
                           event_session_id, lab_location, session_type,
                           sport, operator) -> int:
    """
    One capture_session per subject per station per day (uniquely constrained).

    A second measurement on the same day is a new TRIAL in this session; a
    visit next week is a new session. INSERT IGNORE then SELECT rather than
    SELECT then INSERT, so two operators saving at once cannot both decide the
    session does not exist yet.
    """
    today = date.today()
    cur.execute(
        """INSERT IGNORE INTO `capture_session`
             (`anonymous_capture_subject_id`, `event_session_id`, `station_source_id`,
              `capture_date`, `lab_location`, `sport`, `session_type`, `operator`)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
        (subject_id, event_session_id, station_source_id, today,
         lab_location, sport, session_type, operator),
    )
    if cur.lastrowid:
        return cur.lastrowid
    cur.execute(
        """SELECT `id` FROM `capture_session`
            WHERE `anonymous_capture_subject_id` = %s
              AND `station_source_id` = %s AND `capture_date` = %s""",
        (subject_id, station_source_id, today),
    )
    return cur.fetchone()["id"]


def save_capture(*, station_code: str, client_ref: str, subject_id: int | None = None,
                 raw_uid: str | None = None,
                 height_cm=None, wingspan_cm=None, hand_span_cm=None,
                 measurement_method="cv", height_method=None,
                 wingspan_method=None, hand_span_method=None,
                 marker_cm=None, px_per_cm=None, cv_warnings=None,
                 event_session_id=None, lab_location=None, session_type=None,
                 sport=None, operator=None, notes=None, device_label=None,
                 scan_event_id=None) -> dict:
    """
    Write one movement-screen trial.

    Every save creates a NEW capture_trial. It never updates an earlier one —
    that is the fix for the old build's upsert-onto-the-latest-row behaviour,
    which silently destroyed longitudinal history whenever an athlete was
    measured twice across a season.

    client_ref makes the write idempotent. The station queues locally and
    retries in the background, so this WILL be called more than once for the
    same trial whenever wifi drops mid-request. A repeat call returns the
    original ids with duplicate=True instead of writing a second trial.

    Identify the subject with EITHER:

      subject_id  the station reached /api/subject/resolve while the athlete
                  was standing there, which is the normal online path
      raw_uid     the station had no network at tap time, so it held the raw
                  scan locally and the subject is resolved HERE, in the same
                  transaction that creates the trial

    The raw_uid path is what lets a station run through a total network
    outage. Requiring an online resolve before measuring would break
    invariant 2 at the worst possible moment, since venue wifi fails during
    the opening rush, which is exactly when a line of athletes is waiting.
    """
    if not client_ref:
        raise ValueError("client_ref is required — it is what makes a retry safe")
    if bool(subject_id) == bool(raw_uid):
        raise ValueError("pass exactly one of subject_id or raw_uid")

    with _tx() as (_, cur):
        station_source_id = get_station_source_id(cur, station_code)

        # Idempotency check first, before anything is created.
        cur.execute(
            """SELECT ct.`id` AS capture_trial_id, ct.`capture_session_id`,
                      ct.`trial_number`, lms.`id` AS movement_screen_id
                 FROM `capture_trial` ct
                 LEFT JOIN `lab_movement_screen` lms
                        ON lms.`capture_trial_id` = ct.`id`
                WHERE ct.`client_ref` = %s""",
            (client_ref,),
        )
        existing = cur.fetchone()
        if existing:
            return {**existing, "duplicate": True, "scale_warning": None,
                    "subject_token": None, "resolved_offline": False}

        # Deferred resolution for a capture taken offline. Note this also
        # writes the scan_event, so a tap taken during an outage still lands
        # in the audit log once the station reconnects — late, but never lost.
        subject_token = None
        resolved_offline = False
        if raw_uid:
            resolution = _resolve_in_tx(
                cur, raw_uid, station_source_id=station_source_id,
                station_code=station_code, operator=operator,
                device_label=device_label,
            )
            if not resolution["ok"]:
                # The station already showed the operator a measurement, so
                # losing it now would be worse than storing it unattached.
                # Raise instead: the queue parks the record as stalled with
                # this reason, and the CSV export still has every value.
                #
                # This is the path an unprovisioned band takes when the station
                # was offline at tap time — the band could not be checked
                # against the database while the athlete was standing there, so
                # the measurement is held rather than guessed at. Carrying the
                # remedy through means the stalled row tells staff what to do.
                raise ValueError(
                    f"Offline tap could not be resolved: {resolution['reason']} "
                    f"{resolution.get('remedy') or ''}".strip()
                )
            subject_id = resolution["subject_id"]
            subject_token = resolution["subject_token"]
            scan_event_id = resolution["scan_event_id"]
            resolved_offline = True

        session_id = _get_or_create_session(
            cur, subject_id=subject_id, station_source_id=station_source_id,
            event_session_id=event_session_id, lab_location=lab_location,
            session_type=session_type, sport=sport, operator=operator,
        )

        cur.execute(
            """SELECT COALESCE(MAX(`trial_number`), 0) + 1 AS next
                 FROM `capture_trial` WHERE `capture_session_id` = %s""",
            (session_id,),
        )
        trial_number = cur.fetchone()["next"]

        cur.execute(
            """INSERT INTO `capture_trial`
                 (`capture_session_id`, `trial_number`, `trial_type`,
                  `trial_timestamp`, `validity_flag`, `client_ref`)
               VALUES (%s, %s, %s, %s, 1, %s)""",
            (session_id, trial_number, TRIAL_TYPE, _utcnow(), client_ref),
        )
        trial_id = cur.lastrowid

        values = {
            "height_cm": height_cm,
            "wingspan_cm": wingspan_cm,
            "hand_span_cm": hand_span_cm,
        }
        warning = _scale_warning(values)

        # notes lives here rather than on capture_trial: the contract's
        # measurement field mapping puts it in this table's audit group,
        # alongside cv_warnings and recorded_at.
        cur.execute(
            """INSERT INTO `lab_movement_screen`
                 (`capture_trial_id`, `height_cm`, `wingspan_cm`, `hand_span_cm`,
                  `measurement_method`, `height_method`, `wingspan_method`,
                  `hand_span_method`, `marker_cm`, `px_per_cm`, `scale_warning`,
                  `cv_warnings`, `notes`, `recorded_at`)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (trial_id, height_cm, wingspan_cm, hand_span_cm,
             measurement_method, height_method, wingspan_method,
             hand_span_method, marker_cm, px_per_cm, warning,
             "\n".join(cv_warnings) if cv_warnings else None,
             notes[:500] if notes else None, _utcnow()),
        )
        screen_id = cur.lastrowid

        # Close the loop on the tap that produced this trial, so a tap left
        # with capture_trial_id NULL at the end of a shift really does mean
        # "scanned but produced no data" rather than "we never linked it".
        if scan_event_id:
            cur.execute(
                """UPDATE `scan_event` SET `capture_trial_id` = %s
                    WHERE `id` = %s AND `capture_trial_id` IS NULL""",
                (trial_id, scan_event_id),
            )

        return {
            "capture_trial_id": trial_id,
            "capture_session_id": session_id,
            "trial_number": trial_number,
            "movement_screen_id": screen_id,
            "duplicate": False,
            "scale_warning": warning,
            # Present only on the offline path, so the station can replace the
            # placeholder it showed the operator with the real subject token.
            "subject_token": subject_token,
            "resolved_offline": resolved_offline,
        }


def save_additional(movement_screen_id: int, fields: dict) -> int:
    """
    Fill in the manually-measured assessment fields on an existing trial's
    result row. Only whitelisted columns, and only non-None values.
    """
    updates = {
        k: v for k, v in fields.items()
        if k in _MOVEMENT_SCREEN_FIELDS and v is not None
    }
    if not updates:
        return 0

    set_clause = ", ".join(f"`{k}` = %s" for k in updates)
    with _tx() as (_, cur):
        cur.execute(
            f"""UPDATE `lab_movement_screen`
                   SET {set_clause}, `updated_at` = %s
                 WHERE `id` = %s""",
            (*updates.values(), _utcnow(), movement_screen_id),
        )
        return cur.rowcount


def record_artifact(*, capture_trial_id: int, capture_session_id: int,
                    subject_token: str, kind: str, content: bytes) -> dict | None:
    """
    Store a photo and register it in file_artifact.

    A storage failure is logged and swallowed. The measurement is the
    deliverable; losing a photo must not lose the trial, and the operator has
    an athlete standing in front of them.
    """
    stored = artifacts.store(subject_token, capture_trial_id, kind, content)
    if not stored.get("stored"):
        log.error("Artifact not stored for trial %s (%s)", capture_trial_id, kind)
        return None

    with _tx() as (_, cur):
        cur.execute(
            """INSERT INTO `file_artifact`
                 (`capture_session_id`, `capture_trial_id`, `file_path`,
                  `file_type`, `byte_size`, `sha256`, `retention_class`, `purge_after`)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
            (capture_session_id, capture_trial_id, stored["file_path"],
             stored["file_type"], stored["byte_size"], stored["sha256"],
             "athlete_photo", stored["purge_after"]),
        )
        return {"file_artifact_id": cur.lastrowid, "file_path": stored["file_path"]}


# -------------------------------------------------------- setup-screen reads

def list_stations() -> list[dict]:
    """Active stations, for the setup screen's station picker."""
    with _tx() as (_, cur):
        cur.execute(
            """SELECT `code`, `label`, `is_closed_system`
                 FROM `station_source` WHERE `active` = 1 ORDER BY `label`"""
        )
        return cur.fetchall()


def list_event_sessions(limit: int = 40) -> list[dict]:
    """
    Recent event sessions, for the setup screen.

    Reads Layer 1 only, and Layer 1 holds no PII by construction — event names
    and lab locations, never an athlete. This is not a roster and it is not a
    way back to one.
    """
    with _tx() as (_, cur):
        cur.execute(
            """SELECT es.`id`, es.`session_date`, es.`location`, es.`lab`,
                      e.`name` AS event_name
                 FROM `event_session` es
                 LEFT JOIN `event` e ON e.`id` = es.`event_id`
                ORDER BY es.`session_date` DESC, es.`id` DESC
                LIMIT %s""",
            (limit,),
        )
        return [
            {**r, "session_date": r["session_date"].isoformat() if r["session_date"] else None}
            for r in cur.fetchall()
        ]


# ------------------------------------------------------------------- audit

def station_audit(station_code: str, on_date: date | None = None) -> dict:
    """
    The data-quality view for one station on one day.

    This is the concrete answer to the old pipeline's "little ability to audit
    data quality": a station that scanned but produced no data shows up here
    as a number instead of as nothing at all. The station UI shows these
    counts so staff can reconcile before athletes leave the building.

    Returns counts and the raw scan values behind them — no identity.
    """
    on_date = on_date or date.today()
    with _tx() as (_, cur):
        station_source_id = get_station_source_id(cur, station_code)

        cur.execute(
            # unprovisioned is split out from unresolved deliberately. Under
            # read-only resolution it is the signal that matters most on a
            # shift: a band in someone's hand that the lab cannot measure.
            # Lumping it in with malformed reads would bury it.
            """SELECT
                 COUNT(*)                                          AS taps,
                 SUM(`valid_shape` = 0)                            AS malformed,
                 SUM(`resolved` = 0)                               AS unresolved,
                 SUM(`valid_shape` = 1 AND `resolved` = 0)         AS unprovisioned,
                 SUM(`resolved` = 1 AND `enrolled` = 0)            AS unenrolled,
                 SUM(`resolved` = 1 AND `capture_trial_id` IS NULL) AS no_data
               FROM `scan_event`
              WHERE `station_source_id` = %s AND DATE(`scanned_at`) = %s""",
            (station_source_id, on_date),
        )
        counts = {k: int(v or 0) for k, v in cur.fetchone().items()}

        # The taps that need a human. Capped — this is a station-side nudge,
        # not a reporting tool.
        cur.execute(
            """SELECT `id`, `raw_scan_value`, `scanned_at`, `valid_shape`,
                      `resolved`, `enrolled`, `capture_trial_id`, `note`
                 FROM `scan_event`
                WHERE `station_source_id` = %s AND DATE(`scanned_at`) = %s
                  AND (`valid_shape` = 0 OR `resolved` = 0
                       OR `enrolled` = 0 OR `capture_trial_id` IS NULL)
                ORDER BY `scanned_at` DESC
                LIMIT 100""",
            (station_source_id, on_date),
        )
        needs_review = [
            {**r, "scanned_at": r["scanned_at"].isoformat()}
            for r in cur.fetchall()
        ]

        return {"date": on_date.isoformat(), "counts": counts,
                "needs_review": needs_review}

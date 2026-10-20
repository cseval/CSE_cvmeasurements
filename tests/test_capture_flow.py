"""
End-to-end exercise of the anonymous capture path against a real database.

Run against a scratch database, never production capture:

    DB_HOST=127.0.0.1 DB_NAME=new_lab_pipeline DB_USER=... DB_PASSWORD=... \
      python tests/test_capture_flow.py

It covers the behaviours the station depends on and that a unit test on its
own would not catch, because most of them are enforced by the schema rather
than by Python:

  1. CV is READ-ONLY for setup: an unprovisioned band is refused and creates
     no tag, no subject and no binding. A provisioned band resolves.
  2. The same tap resolves to the SAME subject, not a second one.
  3. subject_token is never the bracelet UID.
  4. An unclaimed band still captures, and reports enrolled=False. Identity
     binding is optional for capture and must never gate it.
  5. A malformed scan is logged, not raised, and does not create a subject.
  6. Two saves in a day are two TRIALS in one session — never an overwrite,
     and exactly one capture_session row with trial_numbers 1 and 2. The
     session key gained sport and movement on 2026-10-20, and CV must write
     '' for both: a NULL in a MySQL unique key is distinct from every other
     NULL, which would turn every save into its own session.
  7. A retried save with the same client_ref does not duplicate the trial.
  8. Measurements round-trip in decimal centimetres.
  9. An implausible value raises a scale warning.
 10. A replacement bracelet rebinds to the same subject, keeping history.
 11. The audit view surfaces taps that produced no data.
 12. Nothing identity-shaped appears in any response.
 13. A capture taken with no network carries the raw scan instead of a
     subject id, and resolves to the same subject a later online tap would.
"""

import os
import sys
import uuid
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import db  # noqa: E402
from nfc import validate, TapRejected  # noqa: E402

PASS, FAIL = "PASS", "FAIL"
results = []


def check(name, condition, detail=""):
    results.append((PASS if condition else FAIL, name, detail if not condition else ""))


def uid_for(seed):
    """A unique 14-char (7-byte NTAG-shaped) UID starting with the NXP 04 byte."""
    return ("04" + uuid.uuid4().hex.upper())[:14]


def provision(uid, chip="NTAG215"):
    """
    Stand in for the check-in app's admin provisioning screen.

    CV cannot create these rows any more — that is the behaviour under test —
    so the fixture has to. This writes the three setup rows the real
    provisioning flow writes, idempotently, so a re-run against the same
    scratch database does not collide on nfc_tag.tag_uid.

    Returns (tag_id, subject_id).
    """
    with db._tx() as (_, cur):
        cur.execute("SELECT `id` FROM `nfc_tag` WHERE `tag_uid` = %s", (uid,))
        row = cur.fetchone()
        if row:
            tag_id = row["id"]
        else:
            cur.execute(
                "INSERT INTO `nfc_tag` (`tag_uid`, `chip_type`, `tag_type`) "
                "VALUES (%s, %s, 'bracelet')",
                (uid, chip),
            )
            tag_id = cur.lastrowid

        cur.execute(
            "SELECT `anonymous_capture_subject_id` AS sid FROM `subject_tag_binding` "
            "WHERE `nfc_tag_id` = %s AND `active_to` IS NULL",
            (tag_id,),
        )
        row = cur.fetchone()
        if row:
            return tag_id, row["sid"]

        token = "TC-" + uuid.uuid4().hex[:4].upper() + "-" + uuid.uuid4().hex[:4].upper()
        cur.execute(
            "INSERT INTO `anonymous_capture_subject` (`subject_token`, `capture_method`) "
            "VALUES (%s, 'nfc')",
            (token,),
        )
        subject_id = cur.lastrowid
        cur.execute(
            "INSERT INTO `subject_tag_binding` "
            "(`anonymous_capture_subject_id`, `nfc_tag_id`, `medium`, `created_by`) "
            "VALUES (%s, %s, 'nfc_bracelet', 'test-provisioning')",
            (subject_id, tag_id),
        )
        return tag_id, subject_id


def main():
    station = "cv_app"

    # -------------------------------------------------------------------- 1
    # The headline behaviour: a well-formed UID that nobody provisioned is
    # refused, and CV writes none of the three setup tables. Checked against
    # the database directly, because "the function returned ok=False" would
    # still pass if it had inserted a row on the way out.
    uid_ghost = uid_for("ghost")
    ghost = db.resolve_subject(uid_ghost, station_code=station, operator="tester",
                               device_label="ipad-test-01")
    check("an unprovisioned band is refused", ghost["ok"] is False, str(ghost))
    check("the refusal says the band is not provisioned",
          ghost["reason"] and "provision" in ghost["reason"].lower(), str(ghost["reason"]))
    check("the refusal tells the operator what to do",
          bool(ghost["remedy"]), str(ghost.get("remedy")))
    check("a refused tap is still logged", ghost["scan_event_id"] > 0)
    with db._tx() as (_, cur):
        cur.execute("SELECT COUNT(*) AS n FROM `nfc_tag` WHERE `tag_uid` = %s", (uid_ghost,))
        check("CV created no nfc_tag for an unprovisioned band",
              cur.fetchone()["n"] == 0)
        cur.execute(
            """SELECT COUNT(*) AS n FROM `scan_event`
                WHERE `raw_scan_value` = %s AND `valid_shape` = 1 AND `resolved` = 0""",
            (uid_ghost,),
        )
        check("the refused tap is logged as valid-shape but unresolved",
              cur.fetchone()["n"] >= 1)

    # A band known to the lab but with no active binding must also refuse,
    # rather than quietly minting a subject to hang the capture on.
    uid_unbound = uid_for("unbound")
    with db._tx() as (_, cur):
        cur.execute("INSERT INTO `nfc_tag` (`tag_uid`, `tag_type`) VALUES (%s, 'bracelet')",
                    (uid_unbound,))
    unbound = db.resolve_subject(uid_unbound, station_code=station, operator="tester",
                                 device_label="ipad-test-01")
    check("a band with no active binding is refused", unbound["ok"] is False, str(unbound))
    with db._tx() as (_, cur):
        cur.execute(
            "SELECT COUNT(*) AS n FROM `subject_tag_binding` stb "
            "JOIN `nfc_tag` t ON t.`id` = stb.`nfc_tag_id` WHERE t.`tag_uid` = %s",
            (uid_unbound,),
        )
        check("CV created no binding for an unbound band", cur.fetchone()["n"] == 0)

    # A retired band stops capturing, mirroring the check-in app's rule.
    uid_retired = uid_for("retired")
    provision(uid_retired)
    with db._tx() as (_, cur):
        cur.execute("UPDATE `nfc_tag` SET `status` = 'retired' WHERE `tag_uid` = %s",
                    (uid_retired,))
    retired = db.resolve_subject(uid_retired, station_code=station, operator="tester",
                                 device_label="ipad-test-01")
    check("a retired band is refused", retired["ok"] is False, str(retired))

    # ---------------------------------------------------------------- 1b & 3
    uid_a = uid_for("a")
    _, provisioned_subject = provision(uid_a)
    r1 = db.resolve_subject(uid_a, station_code=station, operator="tester",
                            device_label="ipad-test-01")
    check("a provisioned band resolves", r1["ok"], str(r1))
    check("it resolves to the provisioned subject, not a new one",
          r1["subject_id"] == provisioned_subject,
          f"{provisioned_subject} vs {r1['subject_id']}")
    check("a never-captured band reports first_capture=True",
          r1["first_capture"] is True, str(r1["first_capture"]))
    check("subject_token is opaque, not the UID",
          r1["subject_token"] != uid_a and uid_a not in r1["subject_token"],
          f"token={r1['subject_token']} uid={uid_a}")
    check("subject_token uses the TC- prefix", r1["subject_token"].startswith("TC-"),
          r1["subject_token"])
    check("uid length recorded as observed", r1["uid_length"] == 14, str(r1["uid_length"]))

    # -------------------------------------------------------------------- 2
    r2 = db.resolve_subject(uid_a, station_code=station, operator="tester",
                            device_label="ipad-test-01")
    check("same tap resolves to the same subject",
          r2["subject_id"] == r1["subject_id"], f"{r1['subject_id']} vs {r2['subject_id']}")

    # -------------------------------------------------------------------- 4
    check("an unclaimed band reports enrolled=False", r1["enrolled"] is False,
          str(r1["enrolled"]))

    # -------------------------------------------------------------------- 12
    forbidden = {"first_name", "last_name", "athlete_id", "player_id",
                 "cse_player_id", "name", "email", "dob"}
    check("resolve response carries no identity keys",
          not (forbidden & set(r1.keys())), str(set(r1.keys()) & forbidden))

    # -------------------------------------------------------------------- 5
    bad = db.resolve_subject("NOT-A-UID!!", station_code=station,
                             operator="tester", device_label="ipad-test-01")
    check("malformed scan returns ok=False rather than raising", bad["ok"] is False)
    check("malformed scan creates no subject", bad["subject_id"] is None)
    check("malformed scan is still logged", bad["scan_event_id"] > 0)
    check("malformed scan gives an operator-readable reason",
          bad["reason"] and len(bad["reason"]) > 10, str(bad["reason"]))

    # odd-length read, the truncated-tap case
    try:
        validate("04ABCDE")
        odd_ok = False
    except TapRejected as exc:
        odd_ok = "Odd length" in exc.reason
    check("odd-length scan is rejected as a truncated read", odd_ok)

    # 8-char Mifare-family UID must be accepted, not length-gated to 14
    short_uid = "1265B4FC"
    provision(short_uid, chip="MifareClassic1K")
    r_short = db.resolve_subject(short_uid, station_code=station,
                                 operator="tester", device_label="ipad-test-01")
    check("8-char (4-byte) UID is accepted", r_short["ok"], str(r_short))

    # ---------------------------------------------------------------- 6 & 8
    ref1 = f"test-{uuid.uuid4()}"
    s1 = db.save_capture(
        subject_id=r1["subject_id"], station_code=station, client_ref=ref1,
        height_cm=170.25, wingspan_cm=172.50, hand_span_cm=19.30,
        measurement_method="cv", marker_cm=20.0, px_per_cm=8.125,
        operator="tester", lab_location="CSE Lab", scan_event_id=r1["scan_event_id"],
    )
    check("first save creates a trial", s1["capture_trial_id"] > 0)
    check("first trial is number 1", s1["trial_number"] == 1, str(s1["trial_number"]))
    check("first save is not flagged duplicate", s1["duplicate"] is False)
    check("plausible values raise no scale warning", s1["scale_warning"] is None,
          str(s1["scale_warning"]))

    ref2 = f"test-{uuid.uuid4()}"
    s2 = db.save_capture(
        subject_id=r1["subject_id"], station_code=station, client_ref=ref2,
        height_cm=170.80, wingspan_cm=173.10, hand_span_cm=19.40,
        measurement_method="cv_adjusted", marker_cm=20.0, px_per_cm=8.130,
        operator="tester", scan_event_id=r2["scan_event_id"],
    )
    check("second save in a day reuses the session",
          s2["capture_session_id"] == s1["capture_session_id"],
          f"{s1['capture_session_id']} vs {s2['capture_session_id']}")
    check("second save creates trial 2, not an overwrite",
          s2["trial_number"] == 2 and s2["capture_trial_id"] != s1["capture_trial_id"],
          str(s2))

    # -------------------------------------------------------------------- 7
    s1_again = db.save_capture(
        subject_id=r1["subject_id"], station_code=station, client_ref=ref1,
        height_cm=999.0,  # deliberately different: a retry must not overwrite
        operator="tester",
    )
    check("retried client_ref returns the original trial",
          s1_again["capture_trial_id"] == s1["capture_trial_id"], str(s1_again))
    check("retried client_ref is flagged duplicate", s1_again["duplicate"] is True)

    # -------------------------------------------------------------------- 8
    with db._tx() as (_, cur):
        cur.execute(
            "SELECT `height_cm`, `wingspan_cm`, `hand_span_cm`, `px_per_cm` "
            "FROM `lab_movement_screen` WHERE `capture_trial_id` = %s",
            (s1["capture_trial_id"],),
        )
        stored = cur.fetchone()
    check("height stored as decimal cm", float(stored["height_cm"]) == 170.25, str(stored))
    check("wingspan keeps sub-inch precision", float(stored["wingspan_cm"]) == 172.50,
          str(stored["wingspan_cm"]))

    # ------------------------------------------------------------------ 6b
    # The same claim as 6, but asked of the database rather than of the return
    # values. Those could agree with each other and still be wrong about what
    # was written.
    #
    # This is also the regression test for CV writing NULL into sport or
    # movement. MySQL treats each NULL in a unique key as distinct, so a NULL
    # would silently disable the dedupe and this would see two session rows.
    with db._tx() as (_, cur):
        cur.execute(
            """SELECT `id`, `sport`, `movement` FROM `capture_session`
                WHERE `anonymous_capture_subject_id` = %s
                  AND `capture_date` = %s""",
            (r1["subject_id"], db.lab_today()),
        )
        sessions = cur.fetchall()
        cur.execute(
            "SELECT `trial_number` FROM `capture_trial` "
            "WHERE `capture_session_id` = %s ORDER BY `trial_number`",
            (s1["capture_session_id"],),
        )
        numbers = [r["trial_number"] for r in cur.fetchall()]

    check("two saves in a day land in exactly ONE capture_session",
          len(sessions) == 1, f"{len(sessions)} rows: {sessions}")
    check("that session holds trial_numbers 1 and 2",
          numbers == [1, 2], str(numbers))
    check("CV writes '' for sport and movement, never NULL",
          bool(sessions) and sessions[0]["sport"] == ""
          and sessions[0]["movement"] == "",
          str(sessions[0] if sessions else None))

    # ------------------------------------------------------------------ 6c
    # Same subject, same station, same day, different SPORT — a different
    # session. This is what the five-column key exists for, and it is the only
    # thing that exercises the fallback SELECT's new sport/movement
    # predicates: match on the first three columns only and this returns the
    # '' session instead of creating the softball one.
    #
    # "Softball" rather than "softball" on purpose: the value is part of a key,
    # so it is stripped and lowercased before it is written or matched.
    s_sport = db.save_capture(
        subject_id=r1["subject_id"], station_code=station,
        client_ref=f"test-{uuid.uuid4()}",
        height_cm=170.0, operator="tester", sport="  Softball  ",
    )
    check("a different sport on the same day is a different session",
          s_sport["capture_session_id"] != s1["capture_session_id"],
          f"{s_sport['capture_session_id']} vs {s1['capture_session_id']}")
    check("the new session's trial numbering restarts at 1",
          s_sport["trial_number"] == 1, str(s_sport["trial_number"]))

    with db._tx() as (_, cur):
        cur.execute("SELECT `sport`, `movement` FROM `capture_session` WHERE `id` = %s",
                    (s_sport["capture_session_id"],))
        sport_row = cur.fetchone()
    check("sport is stored stripped and lowercased",
          sport_row["sport"] == "softball" and sport_row["movement"] == "",
          str(sport_row))

    # And a second softball save that day must rejoin that session, not make a
    # third one — the fallback SELECT has to FIND the row it just failed to
    # insert, which is the half of the change most likely to regress.
    s_sport2 = db.save_capture(
        subject_id=r1["subject_id"], station_code=station,
        client_ref=f"test-{uuid.uuid4()}",
        height_cm=170.5, operator="tester", sport="softball",
    )
    check("a second save for that sport rejoins the same session",
          s_sport2["capture_session_id"] == s_sport["capture_session_id"],
          f"{s_sport2['capture_session_id']} vs {s_sport['capture_session_id']}")
    check("and becomes trial 2 of it", s_sport2["trial_number"] == 2,
          str(s_sport2["trial_number"]))
    check("px_per_cm retained for rescaling", float(stored["px_per_cm"]) == 8.125,
          str(stored["px_per_cm"]))

    # -------------------------------------------------------------------- 9
    s3 = db.save_capture(
        subject_id=r1["subject_id"], station_code=station,
        client_ref=f"test-{uuid.uuid4()}",
        height_cm=284.6,  # what a 12cm print measured as 20cm looks like
        wingspan_cm=288.0, hand_span_cm=32.2,
        marker_cm=20.0, px_per_cm=4.875, operator="tester",
    )
    check("implausible values raise a scale warning", bool(s3["scale_warning"]),
          str(s3["scale_warning"]))
    check("scale warning names the marker as the likely cause",
          s3["scale_warning"] and "marker" in s3["scale_warning"].lower(),
          str(s3["scale_warning"]))

    # ------------------------------------------------------------------- 6b
    add = db.save_additional(s1["movement_screen_id"], {
        "age_years": 16, "weight_lb": 141.5, "hip_er_r": 42.0, "grip_str_l": 31.5,
        "not_a_column": 1,  # must be ignored, not written or raised
    })
    check("additional info updates the trial's result row", add == 1, str(add))
    with db._tx() as (_, cur):
        cur.execute(
            "SELECT `age_years`, `weight_lb`, `grip_str_l`, `updated_at` "
            "FROM `lab_movement_screen` WHERE `id` = %s",
            (s1["movement_screen_id"],),
        )
        extra = cur.fetchone()
    check("assessment values round-trip",
          extra["age_years"] == 16 and float(extra["weight_lb"]) == 141.5
          and float(extra["grip_str_l"]) == 31.5, str(extra))
    check("updated_at is stamped", extra["updated_at"] is not None)

    # ------------------------------------------------------------------- 10
    # Replace the bracelet: unbind, bind a new tag to the SAME subject, and
    # confirm the earlier trials are still reachable from that subject.
    uid_replacement = uid_for("replacement")
    with db._tx() as (_, cur):
        cur.execute(
            """UPDATE `subject_tag_binding` SET `active_to` = UTC_TIMESTAMP(3),
                      `unbind_reason` = 'lost'
                WHERE `anonymous_capture_subject_id` = %s AND `active_to` IS NULL""",
            (r1["subject_id"],),
        )
        cur.execute("INSERT INTO `nfc_tag` (`tag_uid`, `chip_type`) VALUES (%s, 'NTAG215')",
                    (uid_replacement,))
        new_tag_id = cur.lastrowid
        cur.execute(
            """INSERT INTO `subject_tag_binding`
                 (`anonymous_capture_subject_id`, `nfc_tag_id`) VALUES (%s, %s)""",
            (r1["subject_id"], new_tag_id),
        )

    r_rebind = db.resolve_subject(uid_replacement, station_code=station,
                                  operator="tester", device_label="ipad-test-01")
    check("replacement bracelet resolves to the original subject",
          r_rebind["subject_id"] == r1["subject_id"],
          f"{r1['subject_id']} vs {r_rebind['subject_id']}")
    check("the rebound band is not reported as a first capture",
          r_rebind["first_capture"] is False, str(r_rebind["first_capture"]))
    with db._tx() as (_, cur):
        cur.execute(
            """SELECT COUNT(*) AS n FROM `capture_trial` ct
                 JOIN `capture_session` cs ON cs.`id` = ct.`capture_session_id`
                WHERE cs.`anonymous_capture_subject_id` = %s""",
            (r1["subject_id"],),
        )
        n_trials = cur.fetchone()["n"]
    check("capture history survives the rebinding", n_trials >= 3, f"{n_trials} trials")

    # ------------------------------------------------------------------- 11
    # A tap that produced no data: resolve, then never save.
    uid_orphan = uid_for("orphan")
    provision(uid_orphan)
    db.resolve_subject(uid_orphan, station_code=station, operator="tester",
                       device_label="ipad-test-01")
    audit = db.station_audit(station, date.today())
    check("audit counts today's taps", audit["counts"]["taps"] > 0, str(audit["counts"]))
    check("audit surfaces the tap that produced no data",
          audit["counts"]["no_data"] >= 1, str(audit["counts"]))
    check("audit counts the malformed scan", audit["counts"]["malformed"] >= 1,
          str(audit["counts"]))
    check("audit counts unclaimed taps", audit["counts"]["unenrolled"] >= 1,
          str(audit["counts"]))
    check("audit surfaces unprovisioned bands separately from bad reads",
          audit["counts"]["unprovisioned"] >= 1, str(audit["counts"]))
    check("the unprovisioned band is in the review list",
          any(r["raw_scan_value"] == uid_ghost for r in audit["needs_review"]),
          "refused band missing from needs_review")
    check("audit review list carries the raw scan value",
          any(r["raw_scan_value"] == "NOT-A-UID!!" for r in audit["needs_review"]),
          "malformed raw value not preserved verbatim")
    review_keys = set().union(*(set(r.keys()) for r in audit["needs_review"])) \
        if audit["needs_review"] else set()
    check("audit rows carry no identity keys", not (forbidden & review_keys),
          str(forbidden & review_keys))

    # unknown station is an error, not an auto-created row
    try:
        db.station_audit("not_a_real_station")
        unknown_ok = False
    except ValueError:
        unknown_ok = True
    check("an unregistered station code is rejected", unknown_ok)


    # ------------------------------------------------- 13: the offline path
    # A station with no network cannot resolve a tap before measuring, so the
    # capture carries the raw scan and the subject is resolved at sync time.
    # This is the path that lets a shift survive the opening-rush wifi outage.
    # Pre-provisioning is what makes the offline path safe under read-only
    # resolution: the band already resolves before anyone touches it, so a
    # station with no network can measure and sync later without CV ever
    # needing to invent a subject.
    uid_offline = uid_for("offline")
    provision(uid_offline)
    s_off = db.save_capture(
        station_code=station, client_ref=f"test-{uuid.uuid4()}",
        raw_uid=uid_offline, height_cm=165.0, wingspan_cm=166.5,
        hand_span_cm=18.2, marker_cm=20.0, px_per_cm=8.0,
        operator="tester", device_label="ipad-test-01",
    )
    check("an offline capture resolves its subject at save time",
          s_off["capture_trial_id"] > 0 and s_off["resolved_offline"] is True, str(s_off))
    check("the offline save returns the minted subject token",
          bool(s_off["subject_token"]) and s_off["subject_token"].startswith("TC-"),
          str(s_off["subject_token"]))

    # The deferred tap must still reach the audit log — late, but never lost.
    with db._tx() as (_, cur):
        cur.execute(
            """SELECT se.`resolved`, se.`capture_trial_id`
                 FROM `scan_event` se
                 JOIN `nfc_tag` nt ON nt.`id` = se.`nfc_tag_id`
                WHERE nt.`tag_uid` = %s""",
            (uid_offline,),
        )
        off_scan = cur.fetchone()
    check("an offline tap still lands in the scan log",
          off_scan is not None and off_scan["resolved"] == 1, str(off_scan))
    check("the offline tap is linked to the trial it produced",
          off_scan and off_scan["capture_trial_id"] == s_off["capture_trial_id"],
          str(off_scan))

    # Tapping the same bracelet later, online, must reach the SAME subject —
    # otherwise an outage silently forks an athlete's history.
    r_off_online = db.resolve_subject(uid_offline, station_code=station,
                                      operator="tester", device_label="ipad-test-01")
    check("a later online tap reaches the same subject",
          r_off_online["subject_token"] == s_off["subject_token"],
          f"{s_off['subject_token']} vs {r_off_online['subject_token']}")

    # An offline capture of a band nobody provisioned must stall, not invent a
    # subject at sync time. The measurement is held with a reason attached —
    # losing it would be worse, attributing it would be far worse.
    try:
        db.save_capture(
            station_code=station, client_ref=f"test-{uuid.uuid4()}",
            raw_uid=uid_for("offline-ghost"), height_cm=170.0, operator="tester",
        )
        stall_ok = False
        stall_detail = "unprovisioned offline capture was accepted"
    except ValueError as exc:
        stall_ok = "provision" in str(exc).lower()
        stall_detail = str(exc)
    check("an offline capture of an unprovisioned band stalls with a reason",
          stall_ok, stall_detail)

    # A retried offline capture must not create a second subject or trial.
    ref_off = f"test-{uuid.uuid4()}"
    a = db.save_capture(station_code=station, client_ref=ref_off,
                        raw_uid=uid_offline, height_cm=165.0, operator="tester")
    b = db.save_capture(station_code=station, client_ref=ref_off,
                        raw_uid=uid_offline, height_cm=165.0, operator="tester")
    check("a retried offline capture does not duplicate the trial",
          a["capture_trial_id"] == b["capture_trial_id"] and b["duplicate"] is True,
          f"{a['capture_trial_id']} vs {b['capture_trial_id']}")

    # Guard rails on the two identification modes.
    for kwargs, label in [
        ({}, "neither subject_id nor raw_uid"),
        ({"subject_id": r1["subject_id"], "raw_uid": uid_offline}, "both at once"),
    ]:
        try:
            db.save_capture(station_code=station, client_ref=f"test-{uuid.uuid4()}",
                            height_cm=170.0, operator="tester", **kwargs)
            ok = False
        except ValueError:
            ok = True
        check(f"save_capture rejects {label}", ok)

    # A malformed offline scan must fail loudly rather than store an
    # unattached trial. The queue parks it and the CSV still holds the values.
    try:
        db.save_capture(station_code=station, client_ref=f"test-{uuid.uuid4()}",
                        raw_uid="NOT-A-UID!!", height_cm=170.0, operator="tester")
        bad_off = False
    except ValueError:
        bad_off = True
    check("a malformed offline scan is rejected at sync, not stored loose", bad_off)

    # ------------------------------------------------------------------ done
    width = max(len(n) for _, n, _ in results) + 2
    failed = 0
    for status, name, detail in results:
        print(f"{status:4}  {name:<{width}} {detail}")
        if status == FAIL:
            failed += 1
    print(f"\n{len(results) - failed}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

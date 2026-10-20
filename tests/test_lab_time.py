"""
Lab-local date handling.

Rows store UTC instants; calendar dates do not come from UTC. Denver is UTC-6
in summer and UTC-7 in winter, so the UTC date rolls over at 18:00 or 17:00
local — in the middle of an evening session. Before this was fixed:

  - capture_date labelled evening sessions with tomorrow's date
  - capture_session is UNIQUE on (subject, station, capture_date, sport,
    movement) and CV writes '' for the last two, so an athlete measured at
    17:55 and again at 18:05 was silently split into two sessions
  - the station audit defaulted to the UTC date AND filtered on
    DATE(scanned_at), so after 18:00 it reported zero taps — at exactly the
    hour staff use it to catch unprovisioned bands before athletes leave
  - a capture queued through an outage was dated when the queue drained

Unlike test_capture_flow.py this needs no database, so it runs anywhere.
"""

from datetime import date, datetime, timedelta, timezone

import pytest

import db


def U(*args) -> datetime:
    """A naive UTC datetime, the shape this module stores and passes around."""
    return datetime(*args)


# --------------------------------------------------------------- lab dates

@pytest.mark.parametrize("utc_instant, expected, why", [
    (U(2026, 7, 16, 0, 30), date(2026, 7, 15), "18:30 MDT is still the 15th"),
    (U(2026, 7, 15, 23, 55), date(2026, 7, 15), "17:55 MDT, before UTC rollover"),
    (U(2026, 7, 16, 0, 5), date(2026, 7, 15), "18:05 MDT, after UTC rollover"),
    (U(2026, 1, 16, 0, 30), date(2026, 1, 15), "17:30 MST is still the 15th"),
    (U(2026, 7, 16, 5, 59), date(2026, 7, 15), "23:59 local, last minute of the day"),
    (U(2026, 7, 16, 6, 1), date(2026, 7, 16), "00:01 local, a real rollover"),
])
def test_lab_date(utc_instant, expected, why):
    assert db._lab_date(utc_instant) == expected, why


def test_either_side_of_the_utc_rollover_is_one_session():
    """The bug that mattered: one athlete, one evening, two capture_sessions."""
    before = db._lab_date(U(2026, 7, 15, 23, 55))   # 17:55 MDT
    after = db._lab_date(U(2026, 7, 16, 0, 5))      # 18:05 MDT
    assert before == after


# -------------------------------------------------------------- day bounds

def test_dst_days_are_not_24_hours():
    """
    Local midnight plus one DAY, not plus 24 HOURS. Getting this wrong loses or
    double-counts an hour of scans twice a year.
    """
    start, end = db._lab_day_bounds_utc(date(2026, 11, 1))   # fall back
    assert end - start == timedelta(hours=25)

    start, end = db._lab_day_bounds_utc(date(2026, 3, 8))    # spring forward
    assert end - start == timedelta(hours=23)


def test_bounds_are_half_open_and_agree_with_lab_date():
    start, end = db._lab_day_bounds_utc(date(2026, 7, 15))
    assert db._lab_date(start) == date(2026, 7, 15)
    assert db._lab_date(end - timedelta(seconds=1)) == date(2026, 7, 15)
    assert db._lab_date(end) == date(2026, 7, 16)


# ------------------------------------------------------------- captured_at

def test_a_queued_capture_keeps_its_own_time():
    """The whole point: synced late, dated when it happened."""
    taken = db._utcnow() - timedelta(hours=14)
    assert db._coerce_captured_at(taken) == taken


def test_saturday_evening_synced_sunday_morning_stays_saturday():
    saturday_2000_mdt = U(2026, 7, 16, 2, 0)
    assert db._lab_date(db._coerce_captured_at(saturday_2000_mdt)) == date(2026, 7, 15)


def test_missing_captured_at_falls_back_to_server_time():
    assert abs((db._coerce_captured_at(None) - db._utcnow()).total_seconds()) < 5


def test_aware_input_is_normalised_to_naive_utc():
    aware = datetime(2026, 7, 16, 0, 30, tzinfo=timezone.utc)
    assert db._coerce_captured_at(aware) == U(2026, 7, 16, 0, 30)


def test_device_sends_its_own_offset():
    """An iPad in Denver sends -06:00, not Z. It must land on the same day."""
    local = datetime(2026, 7, 15, 18, 30, tzinfo=timezone(timedelta(hours=-6)))
    assert db._lab_date(db._coerce_captured_at(local)) == date(2026, 7, 15)


def test_a_wildly_wrong_device_clock_is_clamped():
    """
    The past is accepted — that is the outage case. The future is not: a device
    a year ahead would file a trial under a session nobody will ever look at.
    """
    far_future = db._utcnow() + timedelta(days=400)
    assert abs((db._coerce_captured_at(far_future) - db._utcnow()).total_seconds()) < 5


def test_ordinary_clock_skew_is_tolerated():
    skewed = db._utcnow() + timedelta(minutes=30)
    assert db._coerce_captured_at(skewed) == skewed


# ------------------------------------------------------------------ config

def test_lab_timezone_is_resolvable_and_not_utc():
    """
    A deploy with no tzdata, or a typo in LAB_TIMEZONE, degrades to something
    that looks like it works until an evening session proves otherwise.
    """
    assert db.lab_today() == db._lab_date()
    jan = db._lab_date(U(2026, 1, 15, 23, 0))
    assert jan == date(2026, 1, 15), "zone resolved to UTC — tzdata missing?"

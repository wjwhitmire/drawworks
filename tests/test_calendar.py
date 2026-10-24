"""Dates and work calendars."""

import pytest

from fieldsched.errors import SchedError
from fieldsched.timecal import (Calendar, civil_from_days, compile_calendar, days_from_civil, fmt_dt, fmt_fixed,
                                full_day_calendar, parse_dt, round_div, weekday)

LUNCH = {"id": "c", "name": "Lunch", "hpd": 480,
         "week": [[] if d in (0, 6) else [[480, 720], [780, 1020]] for d in range(7)],
         "exceptions": {"2026-11-26": [], "2026-11-28": [[480, 720]]}}


def T(s):
    return parse_dt(s)


def test_civil_round_trip_and_weekdays():
    for y, m, d in [(1970, 1, 1), (2000, 2, 29), (2026, 11, 26), (2100, 3, 1), (1900, 1, 1), (1899, 12, 30)]:
        assert civil_from_days(days_from_civil(y, m, d)) == (y, m, d)
    assert weekday(days_from_civil(2026, 11, 26)) == 4  # a Thursday
    assert weekday(days_from_civil(1969, 12, 28)) == 0  # a Sunday before the epoch
    assert days_from_civil(1899, 12, 30) + 46352 == days_from_civil(2026, 11, 26)


@pytest.mark.parametrize("s,ok", [("2026-02-29", False), ("2028-02-29", True), ("2026-13-01", False), ("2026-1-5 7:05", True),
                                  ("2026-01-05T24:00", True), ("2026-01-05T24:01", False), ("x", False), ("2026-01-05T08:00:59.9", True)])
def test_parse_dates(s, ok):
    if ok:
        parse_dt(s)
    else:
        with pytest.raises(SchedError):
            parse_dt(s)
    assert fmt_dt(parse_dt("2026-01-05T24:00")) == "2026-01-06T00:00"


def test_snap_add_sub_with_lunch_and_holidays():
    c = compile_calendar(LUNCH)
    # a 6 hour task from Monday 08:00 skips lunch and finishes 15:00
    assert fmt_dt(c.add_work(T("2026-11-23T08:00"), 360)) == "2026-11-23T15:00"
    # 8 hours finish at 17:00 the same day, not 08:00 the next
    assert fmt_dt(c.add_work(T("2026-11-23T08:00"), 480)) == "2026-11-23T17:00"
    # from Wednesday 17:00, 4 hours lands Friday 08:00 + 4 h (Thursday is a holiday)
    assert fmt_dt(c.add_work(T("2026-11-25T17:00"), 240)) == "2026-11-27T12:00"
    # a Saturday exception with a morning shift
    assert fmt_dt(c.add_work(T("2026-11-27T17:00"), 120)) == "2026-11-28T10:00"
    assert fmt_dt(c.snap_fwd(T("2026-11-23T12:30"))) == "2026-11-23T13:00"
    assert fmt_dt(c.snap_fwd(T("2026-11-23T17:00"))) == "2026-11-24T08:00"
    assert fmt_dt(c.snap_back(T("2026-11-24T08:00"))) == "2026-11-23T17:00"
    assert fmt_dt(c.snap_back(T("2026-11-23T12:30"))) == "2026-11-23T12:00"
    assert fmt_dt(c.snap_back(T("2026-11-30T00:00"))) == "2026-11-28T12:00"
    # backward: 8 h before Monday 17:00 is Monday 08:00; 9 h before is the previous Saturday shift
    assert fmt_dt(c.sub_work(T("2026-11-30T17:00"), 480)) == "2026-11-30T08:00"
    assert fmt_dt(c.sub_work(T("2026-11-30T17:00"), 540)) == "2026-11-28T11:00"
    assert c.work_between(T("2026-11-23T08:00"), T("2026-11-30T08:00")) == 4 * 480 + 240
    assert c.work_between(T("2026-11-30T08:00"), T("2026-11-23T08:00")) == -(4 * 480 + 240)
    assert c.work_between(T("2026-11-23T17:00"), T("2026-11-24T08:00")) == 0
    for t0 in range(T("2026-11-20T00:00"), T("2026-12-02T00:00"), 97):
        for m in (1, 59, 240, 481, 2000):
            f = c.add_work(t0, m)
            assert c.work_between(t0, f) == m
            s = c.sub_work(f, m)
            assert c.work_between(s, f) == m


def test_full_day_and_no_work():
    h = full_day_calendar()
    assert fmt_dt(h.add_work(T("2026-01-01T16:00"), 480)) == "2026-01-02T00:00"
    with pytest.raises(SchedError) as e:
        Calendar("x", "Empty", [[] for _ in range(7)], {}, 480)
    assert e.value.code == "no_work"
    c = compile_calendar({"id": "c", "name": "One day", "hpd": 480, "week": [[], [[480, 960]], [], [], [], [], []],
                          "exceptions": {}})
    assert fmt_dt(c.add_work(T("2026-01-01T08:00"), 960)) == "2026-01-12T16:00"


def test_integer_rounding_helpers():
    assert round_div(5, 2) == 3 and round_div(-5, 2) == -3 and round_div(4, 3) == 1
    assert fmt_fixed(1200, 480, 2) == "2.50" and fmt_fixed(-240, 480, 1) == "-0.5" and fmt_fixed(1, 3, 0) == "0"

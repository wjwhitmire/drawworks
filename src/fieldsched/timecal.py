"""Dates, times and work calendars.

Every instant is an integer count of minutes since 1970-01-01 00:00 on a plain wall clock with no
time zone and no daylight saving, which is how schedule files store dates. Every duration, lag and
float is an integer count of working minutes on a named calendar. Integer arithmetic keeps the
Python library and the browser core in exact agreement.

A calendar has a work week (seven lists of [start, finish] minute-of-day intervals, index 0 is
Sunday, the order both schedule file formats use) and exceptions (a date with its own list of
intervals; an empty list is a holiday).

Two kinds of instant matter in CPM arithmetic. A start-type instant is the beginning of a working
minute (08:00 on Monday). A finish-type instant is the end of one (16:00 on Monday). An activity of
eight hours that starts at Monday 08:00 finishes at Monday 16:00, not at Tuesday 08:00, the way both
desktop schedulers display it. snap_fwd moves an instant to the next start-type instant, snap_back
to the previous finish-type instant.
"""

from __future__ import annotations

import re
from bisect import bisect_left

from .errors import SchedError

DAY = 1440
MAX_SCAN_DAYS = 366 * 60  # a calendar search that runs past 60 years means the calendar has no work


def days_from_civil(y: int, m: int, d: int) -> int:
    """Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant's algorithm)."""
    y -= m <= 2
    era = (y if y >= 0 else y - 399) // 400
    yoe = y - era * 400
    doy = (153 * (m + (-3 if m > 2 else 9)) + 2) // 5 + d - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def civil_from_days(z: int):
    z += 719468
    era = (z if z >= 0 else z - 146096) // 146097
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    y = yoe + era * 400
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    d = doy - (153 * mp + 2) // 5 + 1
    m = mp + (3 if mp < 10 else -9)
    return (y + (m <= 2), m, d)


def weekday(day: int) -> int:
    """0 = Sunday ... 6 = Saturday. 1970-01-01 was a Thursday."""
    return (day + 4) % 7


_DT = re.compile(r"^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*$")


def valid_ymd(y, m, d):
    if not (1 <= m <= 12 and 1 <= d <= 31 and 1900 <= y <= 2200):
        return False
    return civil_from_days(days_from_civil(y, m, d)) == (y, m, d)


def parse_dt(s, field="date"):
    """'2026-11-02', '2026-11-02T08:00', '2026-11-02 08:00:00' -> minutes. Seconds are dropped."""
    if not isinstance(s, str):
        raise SchedError("bad_date", f"{field}: expected a date, got {type(s).__name__}.")
    m = _DT.match(s)
    if not m:
        raise SchedError("bad_date", f'{field}: "{s[:30]}" is not a date (use YYYY-MM-DD HH:MM).')
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    hh = int(m.group(4) or 0)
    mi = int(m.group(5) or 0)
    if not valid_ymd(y, mo, d) or hh > 24 or mi > 59 or (hh == 24 and mi != 0):
        raise SchedError("bad_date", f'{field}: "{s[:30]}" is not a real date.')
    return days_from_civil(y, mo, d) * DAY + hh * 60 + mi


def fmt_dt(t):
    if t is None:
        return None
    day, mod = divmod(t, DAY)
    y, m, d = civil_from_days(day)
    return f"{y:04d}-{m:02d}-{d:02d}T{mod // 60:02d}:{mod % 60:02d}"


def fmt_day(day):
    y, m, d = civil_from_days(day)
    return f"{y:04d}-{m:02d}-{d:02d}"


def parse_day(s, field="date"):
    t = parse_dt(s, field)
    if t % DAY:
        raise SchedError("bad_date", f"{field}: a date without a time is expected.")
    return t // DAY


def parse_hm(s, field="time"):
    m = re.match(r"^\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*$", s or "")
    if not m or int(m.group(1)) > 24 or int(m.group(2)) > 59:
        raise SchedError("bad_time", f'{field}: "{str(s)[:20]}" is not a time of day.')
    v = int(m.group(1)) * 60 + int(m.group(2))
    if v > DAY:
        raise SchedError("bad_time", f'{field}: "{s}" is past midnight.')
    return v


def fmt_hm(v):
    return f"{v // 60:02d}:{v % 60:02d}"


def norm_intervals(ivs, field="intervals"):
    """Sort and merge [[s, f], ...] minute-of-day intervals; refuse empty or reversed ones."""
    out = []
    if not isinstance(ivs, list):
        raise SchedError("bad_calendar", f"{field}: expected a list of [start, finish] pairs.")
    if len(ivs) > 48:
        raise SchedError("bad_calendar", f"{field}: more than 48 work periods in a day.")
    for iv in ivs:
        if (not isinstance(iv, list) or len(iv) != 2 or any(type(x) is not int for x in iv)
                or not (0 <= iv[0] < iv[1] <= DAY)):
            raise SchedError("bad_calendar", f"{field}: each work period is [start, finish] in minutes, 0 to 1440, start before finish.")
        out.append([iv[0], iv[1]])
    out.sort()
    merged = []
    for s, f in out:
        if merged and s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], f)
        else:
            merged.append([s, f])
    return merged


class Calendar:
    """A compiled calendar. week: 7 interval lists (0 = Sunday). exc: {day number: intervals}."""

    __slots__ = ("id", "name", "week", "exc", "hpd", "_wk", "_pre", "_exd", "_exp")

    def __init__(self, cid, name, week, exc, hpd):
        self.id = cid
        self.name = name
        self.week = week
        self.exc = exc
        self.hpd = hpd
        if sum(f - s for day in week for s, f in day) == 0:
            raise SchedError("no_work", f'Calendar "{name}" has no working time in its work week.')
        # cumulative working time for O(log n) spans: whole weeks, a weekday prefix counted from
        # day 0 (a Thursday) and the running total of each exception's difference from its weekday
        dw = [sum(f - s for s, f in week[i]) for i in range(7)]
        self._wk = sum(dw)
        self._pre = [0] * 8
        for i in range(7):
            self._pre[i + 1] = self._pre[i] + dw[(4 + i) % 7]
        self._exd = sorted(exc)
        self._exp = [0]
        for d in self._exd:
            self._exp.append(self._exp[-1] + sum(f - s for s, f in exc[d]) - dw[(d + 4) % 7])

    def ivs(self, day):
        e = self.exc.get(day)
        return e if e is not None else self.week[(day + 4) % 7]

    def day_work(self, day):
        return sum(f - s for s, f in self.ivs(day))

    def snap_fwd(self, t):
        """Earliest start-type instant at or after t."""
        d, mod = divmod(t, DAY)
        for _ in range(MAX_SCAN_DAYS):
            for s, f in self.ivs(d):
                if f > mod:
                    return d * DAY + max(s, mod)
            d += 1
            mod = 0
        raise SchedError("no_work", f'Calendar "{self.name}" has no working time after {fmt_dt(t)}.')

    def snap_back(self, t):
        """Latest finish-type instant at or before t."""
        d, mod = divmod(t, DAY)
        if mod == 0:
            d -= 1
            mod = DAY
        for _ in range(MAX_SCAN_DAYS):
            for s, f in reversed(self.ivs(d)):
                if s < mod:
                    return d * DAY + min(f, mod)
            d -= 1
            mod = DAY
        raise SchedError("no_work", f'Calendar "{self.name}" has no working time before {fmt_dt(t)}.')

    def add_work(self, t, m):
        """The instant m working minutes after t (a finish-type instant). m = 0 returns t."""
        if m <= 0:
            if m < 0:
                return self.sub_work(t, -m)
            return t
        d, mod = divmod(t, DAY)
        for _ in range(MAX_SCAN_DAYS):
            for s, f in self.ivs(d):
                if f <= mod:
                    continue
                start = max(s, mod)
                avail = f - start
                if m <= avail:
                    return d * DAY + start + m
                m -= avail
            d += 1
            mod = 0
        raise SchedError("no_work", f'Calendar "{self.name}": a duration runs past 60 years.')

    def sub_work(self, t, m):
        """The instant m working minutes before t (a start-type instant). m = 0 returns t."""
        if m <= 0:
            if m < 0:
                return self.add_work(t, -m)
            return t
        d, mod = divmod(t, DAY)
        if mod == 0:
            d -= 1
            mod = DAY
        for _ in range(MAX_SCAN_DAYS):
            for s, f in reversed(self.ivs(d)):
                if s >= mod:
                    continue
                end = min(f, mod)
                avail = end - s
                if m <= avail:
                    return d * DAY + end - m
                m -= avail
            d -= 1
            mod = DAY
        raise SchedError("no_work", f'Calendar "{self.name}": a duration runs past 60 years.')

    def cum(self, t):
        """Working minutes from day 0 to t (negative before it); spans are differences of this."""
        d, m = divmod(t, DAY)
        q, r = divmod(d, 7)
        w = q * self._wk + self._pre[r] + self._exp[bisect_left(self._exd, d)]
        if m:
            for s, f in self.ivs(d):
                if s < m:
                    w += min(f, m) - s
        return w

    def work_between(self, a, b):
        """Working minutes in [a, b); negative when b is before a."""
        if abs(b - a) > MAX_SCAN_DAYS * DAY:
            raise SchedError("no_work", "A span of more than 60 years cannot be measured.")
        return self.cum(b) - self.cum(a)


def full_day_calendar():
    return Calendar("__24h", "24 hour", [[[0, DAY]] for _ in range(7)], {}, DAY)


def compile_calendar(c):
    """A validated calendar record -> Calendar."""
    week = [norm_intervals(c["week"][i], f'calendar "{c["name"]}" day {i}') for i in range(7)]
    exc = {}
    for k, v in c.get("exceptions", {}).items():
        exc[parse_day(k, f'calendar "{c["name"]}" exception')] = norm_intervals(v, f'calendar "{c["name"]}" exception {k}')
    return Calendar(c["id"], c["name"], week, exc, c["hpd"])


def standard_week(start=480, finish=960, days=(1, 2, 3, 4, 5)):
    return [[[start, finish]] if i in days else [] for i in range(7)]


def round_div(n, d):
    """n / d rounded half away from zero, integers only."""
    if d < 0:
        n, d = -n, -d
    q = (2 * abs(n) + d) // (2 * d)
    return q if n >= 0 else -q


def fmt_fixed(n, d, places=2):
    """n / d as a decimal string with `places` digits, rounded half away from zero, integers only."""
    scale = 10 ** places
    v = round_div(n * scale, d)
    sign = "-" if v < 0 else ""
    v = abs(v)
    if places == 0:
        return f"{sign}{v}"
    return f"{sign}{v // scale}.{v % scale:0{places}d}"

# Drawworks

Field Tools No. 18. A free, open-source critical path (CPM) scheduler that runs entirely in your browser. It opens Primavera P6 XER files and Microsoft Project XML (MSPDI) files, schedules them with a full forward and backward pass, and writes them back out, so a planner who is sent a schedule can read it, update it and return it without a license for either desktop tool.

The product name lives in one constant (`src/fieldsched/brand.py` and `web/src/core/00_brand.js`). The name is a rig's hoisting drum, which pays out line against time.

Live tool: https://wjwhitmire.github.io/drawworks/

It was built with drilling programs in mind as much as construction: rig moves, 24-hour rig calendars beside 5-day office calendars, hour-level durations, and longest-path tracing through mixed calendars all work the way a well planner expects.

## Quick start

**In the browser.** Open the page. It starts with an invented land well program (labeled as example data). Use File to open an `.xer`, `.xml` or `.json` file; the format is detected from the file's content. Everything stays on your device: schedules autosave to this browser's IndexedDB, and every export is written locally.

**As a Python library and command line** (Python 3.10 or newer, no runtime dependencies):

```
pip install -e .[dev]
fieldsched example drill --out drill.json
fieldsched schedule drill.json
fieldsched check drill.json
fieldsched convert drill.json --to xer --out drill.xer
fieldsched convert sample.xer --to mspdi --out sample.xml
fieldsched convert sample.xer --to pdf --page tabloid --out gantt.pdf
fieldsched fidelity sample.xer
```

```python
from fieldsched.files import open_and_schedule
out = open_and_schedule(open("sample.xer", "rb").read())
print(out["sched"]["finish"], out["fidelity"])
```

## Working the way P6 and Project users expect

| Habit | Here |
|---|---|
| Activity table beside the Gantt chart, grouped by WBS | Activities view; collapse and expand WBS bands |
| Column layouts | Layout menu: Classic schedule, Progress, Baseline variance, Logic, Early/late and float, Resources, Constraints and calendars |
| Activity details pane | General, Status, Relationships, Resources, Notes tabs |
| F9 to schedule | F9 (the schedule also recalculates after every change) |
| Insert / Delete | Insert adds an activity after the selected one, linked finish to start; Delete removes it and links its predecessors to its successors |
| Edit in the grid | F2 or Enter edits a cell; arrows and Tab move; typing a start or finish sets a start or finish on or after constraint |
| Predecessor column like Project | Type `A1000, A1010SS+2d, A1020 FF-4h` in the Predecessors column (Logic layout) |
| Ctrl+Z / Ctrl+Y | Undo and redo every change, including imports of fixes, updates and leveling |
| Zoom the timescale | Ctrl+= and Ctrl+- (quarters, months, weeks, days, hours) |
| Activity IDs counting by 10 | New activities take the next ID after the highest (A1000, A1010, ...) |
| Row height and column widths | View, Rows: Comfortable (44 px, the default), Standard (32 px) or Dense (24 px); on a touch screen rows stay 44 px. Drag a column edge to resize it; double-click the edge to fit its content |

The skin is our own, a "pen plot" look: every bar state has its own pattern as well as its color (critical solid, near critical hatched, other activities open, completed work solid ink, in-progress ink up to the data date, then the remaining state), so the chart still reads in gray print or for color-blind readers. Each view leads with one key answer in a flag at the right of the view bar: the project finish (Activities), the longest path length (Network), the buckets over a resource's limit (Resources) and the checks passing (Check). Names, colors, fonts and icons are our own; no icons, artwork, help text or trademarks from either product are used. Competitor names appear only to say which files the tool reads and writes.

## What is automated (and always visible and undoable)

- **Recalculation** after every edit, with the time it took in the status bar.
- **Schedule check** runs after every recalculation. Its metrics are the DCMA 14-point schedule assessment with the published limits (see Method), followed by out-of-sequence progress. Findings name each activity or link: open ends, dangling starts and finishes, leads, long lags, start-to-finish links, hard constraints, negative and high float, high duration, actual dates after the data date, a longest path that does not reach back to the data date, and out-of-sequence progress. Findings carry a suggested fix where one is safe (link an open end to the project's start or finish milestone; turn a lead into a start-to-start link; soften a hard constraint; turn a deadline constraint on the last activity into the must-finish-by date). Fixes apply one at a time or all at once and undo as one step.
- **Update progress**: pick a new data date; activities planned to start or finish before it are proposed as started or finished on their planned dates, and in-progress work is proposed with the planned work left after the new data date. Every proposal says why. Untick what did not happen and apply.
- **Resource leveling suggestion**: a serial method that delays activities until every resource fits its maximum units, listing each delay and whether it stays within float, with a preview that draws each leveled bar as a dashed outline beside its current bar. Applying adds start-on-or-after constraints, which undo removes.
- **Import** detects XER, Project XML or a native backup from the content, picks the exported project from a multi-project XER (or asks), and reports how many dates stored in the file agree with this tool's calculation.
- **History** (status bar, or Edit, History) lists every change with who or what made it (you, or the tool acting for you), the reason in one sentence and what the recalculation did to the finish. Undo to here reverses a step and everything after it. Every automatic change also raises a message with Undo for six seconds.
- **Loops** are refused when an edit would create one (the message names the cycle). A loop that arrives in an imported file shows a banner naming the cycle with a button to remove each link in it.

## Method

Times are integer minutes on a wall clock (no time zones, as in the files). Durations, lags and float are integer working minutes on the relevant calendar. Python and JavaScript share the same integer arithmetic, and the parity test checks that they agree exactly.

**Calendars.** Each calendar has a work week of work periods per day (Sunday first, as both file formats store it) and dated exceptions (an empty day is a holiday). Hours per day only converts minutes to days for display. A task of 8 hours starting 08:00 finishes 16:00 the same day: early start is moved to the next working minute (`snap_fwd`), early finish is `add_work(ES, D)`, and finish-type instants are the ends of work periods.

**Forward pass** (for remaining duration D, lag L counted on the lag calendar):

```
FS:  ES >= lag(pred.EF, L)        SS:  ES >= lag(pred.ES, L)
FF:  EF >= lag(pred.EF, L)        SF:  EF >= lag(pred.ES, L)
ES = snap_fwd(max(project start, data date, constraints, FS and SS terms, sub_work(FF and SF terms, D)))
EF = add_work(ES, D)
```

**Backward pass** from the latest early finish (or the must-finish-by date):

```
FS:  LF <= lag'(succ.LS, L)       SS:  LS <= lag'(succ.LS, L)
FF:  LF <= lag'(succ.LF, L)       SF:  LS <= lag'(succ.LF, L)
LF = snap_back(min(anchor, constraints, FS and FF terms, add_work(SS and SF terms, D)))
LS = sub_work(LF, D)
```

where `lag` moves forward by L working minutes (back for a negative lag) and `lag'` is its inverse. Lags count on the predecessor's calendar by default; the options are successor's, 24 hour and project calendar. An elapsed lag from a Project XML file counts on a 24 hour calendar.

**Float.** Total float = `work_between(EF, LF)` (finish float, the default) or `work_between(ES, LS)` (start float) or the smaller, on the activity's calendar. Free float = the smallest slack to any successor, measured on the activity's calendar; with no successors it equals total float. A relationship is driving when its slack, measured on the successor's calendar, is zero or less.

**Critical path.** Critical means total float at or below the threshold (default 0), or, as an option, on the longest path: traced back from the latest-finishing open activity through driving relationships. With mixed calendars these differ, which is why drilling schedules usually use the longest path; the drilling example does.

**Constraints.** SNET pushes ES; FNET pushes EF; SNLT pulls LS; FNLT pulls LF; MSO and MFO ("start on", "finish on") do both, logic winning forward; mandatory start and finish set early and late dates to the date over logic; ALAP displays the activity later by its free float while its float and the critical path use its early dates.

**Progress.** Complete activities keep their actual dates and carry no float. In-progress activities keep their actual start and schedule the remaining duration from the data date (remaining early start). With retained logic the remaining work also waits for unfinished FS predecessors and honors FF and SF links; with progress override it ignores predecessors. A relationship is out of sequence when the successor's progress came before the predecessor's end plus lag allowed. Percent complete is by duration `(OD - RD) / OD`, physical (entered), or units `actual / (actual + units x RD)`.

**Schedule check (DCMA 14-point).** Shares are of incomplete activities or of relationships not between two complete activities. 1 logic (open ends) at most 5%; 2 leads 0%; 3 lags at most 5%; 4 relationship types at least 90% finish to start; 5 hard constraints (start on, finish on, start on or before, finish on or before, mandatory) at most 5%; 6 total float over 44 working days at most 5%; 7 negative float 0%; 8 baseline duration (original duration when there is no baseline) over 44 working days at most 5%; 9 actual dates after the data date 0%; 10 activities of a day or longer with no resource, reported without a limit, as the assessment gives none; 11 missed activities (baseline finish before the data date, finished late or not at all) at most 5%; 12 critical path test: the longest path must run through driving links back to an activity that starts at the data date; 13 critical path length index `(CPL + float to the target) / CPL` at least 0.95, with CPL the working time from the data date to the finish on the project calendar and the target the must-finish-by date, or the latest baseline finish; 14 baseline execution index (activities finished / activities whose baseline finish has passed) at least 0.95. 11, 13 and 14 need the active baseline and show "not applicable" without one. The 44 day limits are settings in working minutes (44 days of 8 hours unless changed).

**Baselines.** Up to 20 snapshots of start, finish and duration per activity. Variance is baseline minus current in working time, so a negative finish variance means late (the P6 sign convention).

**Resources.** Assignments carry units per hour, budgeted and actual quantity. The histogram spreads remaining quantity over working minutes between remaining early start and early finish (or late dates) and actual quantity between actual start and actual finish (or the data date). A period is over-allocated when more than the maximum units are in use at the same moment.

**Verification.**
- `tests/test_cpm.py` works textbook networks by hand in the comments and checks every date and float: a classic eight-activity activity-on-node network, a precedence network with SS and FF lags, negative lags with a start-to-finish link, mixed 5-day and 7-day calendars under each lag calendar option, each constraint type, retained logic versus progress override, ALAP, milestones and loops.
- `tests/files/sample_p6.xer` (Windows-1252, P6-style calendar data, an unknown table, an extra field, a cross-project link) and `tests/files/sample_msp.xml` (base and derived calendars, both exception styles, summary tasks) were written by hand for a five-activity fit-out with a holiday and an SS lag. Their stored early, late and float values were worked by hand; the import agrees with all 36 in each.
- Round trips: both examples written to XER and to Project XML and read back schedule to the same dates, with every stored date and float agreeing (142 and 140 values for the drilling example), and the XER writer reproduces its own file byte for byte. Tests also cover the XER table order and references, every schedule option code, LF-only files, tabs and characters outside Windows-1252 in names, extra and missing tables, and a 20,000-activity file.
- The XER and Project XML exports of both examples were also read with MPXJ, an independent open-source schedule file library: no errors, and every early, late and float value, lag, constraint, calendar and schedule option came back as written. The Project XML element order was checked against the order in the published schema.
- `tests/test_workflows.py` checks each DCMA metric's limit and works the critical path test, CPLI, missed activities and BEI on small networks by hand.
- `web/parity.test.mjs` replays 662 cases from the Python library against the JavaScript core (157,851 exact comparisons), including 70 random projects with four calendars, every relationship and constraint type, progress and out-of-sequence links, and byte-identical PDFs.

Sources for the rules and formats: the DCMA 14-point assessment as published in the Defense Contract Management Agency's Earned Value Management System Program Analysis Pamphlet (DCMA-EA PAM 200.1); precedence diagramming as taught in standard planning texts (for example Chris Hendrickson, *Project Management for Construction*, chapter 10, free online); Microsoft's published MSPDI schema (PredecessorLink Type 0 = FF, 1 = FS, 2 = SF, 3 = SS; LinkLag in tenths of a minute; LagFormat and ConstraintType codes; the Task element order); the XER record structure (%T, %F, %R, %E) and calendar data layout as described publicly by planners and in MPXJ's documentation (which notes that XER files are Windows-1252 unless a byte order mark says otherwise).

## Files

| | Read | Write |
|---|---|---|
| Primavera P6 XER | PROJECT, CALENDAR, SCHEDOPTIONS, PROJWBS, TASK, TASKPRED, RSRC, RSRCRATE, TASKRSRC; other tables and fields ignored and listed | CURRTYPE, PROJECT, CALENDAR, SCHEDOPTIONS, PROJWBS, RSRC, RSRCRATE, TASK, TASKPRED, TASKRSRC in P6's order (tables without rows left out), Windows-1252, CRLF |
| Microsoft Project XML (MSPDI) | Calendars (with base calendar inheritance, both exception styles), summary tasks as WBS, tasks, links with every lag format, resources, assignments, baseline 0 | All of the above in schema order |
| CSV | | Activity table with dates, float, predecessors, baseline variance |
| PDF | | Vector Gantt chart laid out like a drawing sheet (finish at the top, table and chart on one row grid, driving relationship lines, legend and title block), tabloid, letter, A3 or A4 landscape, paginated so a WBS band always prints on the same page as its first activities |
| JSON | Native backup | Native backup |

Notes on fidelity: level of effort and WBS summary activities import as tasks; secondary constraints are dropped; cross-project links are skipped; Project XML has one kind of milestone (imported as a finish milestone) and its must-start-on and must-finish-on are mandatory (imported as mandatory constraints); recurring calendar exceptions and alternate work weeks in Project XML are not imported; Project XML percent lags become working time; elapsed lags become working lags in XER, which has none; Project XML has one hours-per-day figure for the whole file, so a calendar with a different day length shows its durations in that file's days.

**The XER export has not been imported into Primavera P6.** It is written to be as conservative as the public descriptions of the format allow: P6's table order, field names and codes; schedule options in SCHEDOPTIONS; activities on project calendars and resources on a shared resource calendar; dates as `YYYY-MM-DD HH:MM`; hours with a dot decimal; Windows-1252 with CRLF line ends. It reads back here and in MPXJ without errors, but P6's importer is the only real test. Check the first import of an exported file in P6 (dates, float and calendars) before relying on it, and please report what you find. Characters outside Windows-1252 are written as `?`, and the export says how many.

## Limits

- Files up to 64 MB; up to 100,000 activities and 400,000 relationships.
- No resource leveling inside the calculation (suggestions only), no costs or earned value, no level of effort activities, no multiple open projects or cross-project links, no time zones or daylight saving.
- The PDF draws only driving relationships on the critical path, not every link.
- Schedules live in this browser's IndexedDB. Clearing site data removes them; export a JSON backup to keep a copy.

## Development

```
pip install -e .[dev]
pytest -q                                  # 114 tests (the browser tests need Playwright and Chromium); TESTING.md has the full function test
python tests/make_vectors.py               # reference vectors and the example data for the page
node web/parity.test.mjs                   # JavaScript core against the vectors
python web/build_pages.py                  # web/app.html and docs/index.html (GitHub Pages, PWA)
```

The page is built from `web/src`: `core/*.js` is pure functions with no DOM or network access (the parity test refuses any), `ui/*.js` is the interface. The Pages build adds a strict Content-Security-Policy (script hashes only, no connections) and a service worker that caches the app shell.

## License

MIT. Copyright (c) 2026 Will Whitmire.

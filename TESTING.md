# Testing

This is the record of a full function test of Drawworks: every view, menu item, toolbar button, dialog, keyboard shortcut, file format, export, setting, automation, the command line and the library, exercised on the page as GitHub Pages serves it.

## How the test was run

- **Published form.** `git archive HEAD` unpacked to a temporary folder, the publish step's placeholders filled (`https://wjwhitmire.github.io/drawworks/`, `wjwhitmire`, `https://github.com/wjwhitmire/drawworks`), and `docs/` served under `/drawworks/` on localhost, as Pages serves it. `web/app.html` was also opened over `file://`.
- **Headless Chromium** (Playwright) at 1280 px and at 400 px with touch, in light and dark. Every step recorded what was done, what was expected and what happened, and the run failed on any page error, Content-Security-Policy violation, request outside the site, sideways scroll or touch target under 44 px. Most steps ran on an instrumented copy (the interface script unwrapped so the test can read the schedule's state, with the policy relaxed for that); a separate run of the main workflow used the real policy.
- **Downloads were opened and checked**: XER and Project XML read back by this library and by MPXJ 16.10 (an independent open-source schedule file library), CSV parsed, every PDF page size rendered with pdfium, the JSON backup reopened.
- **Numbers** were checked against hand calculations (`tests/test_hand_audit.py`) and against MPXJ's PrimaveraScheduler, an independent implementation of P6's scheduling rules (`tests/crosscheck_mpxj.py`).
- **Hostile input**: mutation fuzzing of every file reader in both cores (4,000 mutated XER, Project XML and JSON files each), plus empty, truncated, binary, entity, deeply nested, wrong-type and unicode files through the page, and bad values in every form field.

## Results

251 recorded browser checks cover every item in the tables below; all pass. Two touch-target readings on the Resources view were false alarms (visually hidden selects kept for screen readers, clipped to nothing) and were checked on screenshots.

### Bugs found and fixed

| Severity | Bug | Fix |
|---|---|---|
| Medium | A predecessor typed with a positive lag in the Predecessors column (`A1010SS+2d`, the form the README shows) was refused: "+2d is not a duration". | The leading plus is accepted. Test: `test_published.py`. |
| Medium | A cell editor was destroyed when the table redrew under it (scrolling, or a phone keyboard resizing the page), committing half-typed text and raising a page error ("Failed to execute removeChild"). | No redraw from scroll or resize while a cell is being edited, and a blur caused by a redraw finishes after it. Test: `test_published.py`. |
| Medium | Deleting the open schedule in Schedules on this device brought it back: switching away saved it again. | The deleted schedule is detached before the switch. Test: `test_published.py`. |
| Low | A mutated XER (a `%F` line repeated mid-table, then a line without a marker) crashed the Python reader with a KeyError and put the text "undefined" into a field in the browser. | Both cores start the joined field from empty. Tests: `test_hand_audit.py` and a new parity case. |
| Low | Start-up waited forever when the browser never answered the IndexedDB open (headless Chromium does this at times for pages opened from a file; found while testing Scaleline's single-file page). | The open gives up after 5 seconds and the schedule opens without storage, with "Not saved (storage unavailable)" in the status bar. Test: `test_published.py`. |
| Low | The toolbar Undo button passed its click event as the "quiet" flag, so the status bar did not say what was undone (Ctrl+Z did). | Fixed. Test: `test_published.py`. |
| Low | The keyboard shortcut sheet left out Ctrl+P, Ctrl+Shift+Z and Page Up / Page Down. | Listed. Test: `test_published.py`. |

### Decisions automated

| Decision point | Before | After |
|---|---|---|
| Which project to open from a multi-project XER | A chooser every time | The project the file marks as exported opens at once; the report says why and offers "Open this one instead" for the others. The chooser appears only when the file marks none or several. |
| New data date in Update progress | Always the current data date plus 7 days | Today (its first working minute) when today is later than the data date, with the reason under the field; otherwise a week on, also explained |
| First resource on the Resources view | "No resources yet. Use Resources to add them" (a dead end) | An "Add a resource" button right there that adds one and opens the resource table |
| Hard constraint findings in the schedule check | "has a MSO constraint", fix "Change to SNET" | "has a start on constraint (MSO)", fix "Change to start on or after" |
| Already automatic, checked | | File format detected from content; recalculation and the schedule check after every edit; new activity linked finish to start; delete bridges logic; one-click fixes; progress proposals with reasons; leveling suggestions with a preview; defaults in every dialog (New schedule creates with no input) |

## Function inventory

Result: P = passed in the published page (or by the named test), with the check made.

### Views and panes

| Item | Check | Result |
|---|---|---|
| Activities: table and Gantt on one scroll | example opens, rows and bars drawn, finish flag | P |
| Network view | 600-activity cap message, boxes and links, Enter opens the activity | P |
| Resources view: histogram, Early/Late, Day/Week, resource picker | each control redraws, hand-checked quantities | P |
| Leveling suggestion: preview, untick, apply, undo | applied as start on or after constraints, one undo | P |
| Check view: 14 DCMA metrics, findings, Apply all, per-finding fix, Go to | counts checked by hand | P |
| Key answer flag per view | finish, longest path, over the limit, checks passing | P |
| Activity details: General, Status, Relationships, Resources, Notes, hide | every field edited, bad values refused | P |
| Table/Gantt pane switch (phone) | tap | P |
| WBS bands: chevrons, expand all, collapse all | rows hidden and shown | P |
| Layouts (7) and filters (7 plus each WBS element and resource) | columns and rows | P |
| Find box and Esc to clear | rows filtered | P |
| Status bar: data date, finish, count, critical, save state, History | values shown | P |
| Banner for a logic loop with a button per link | loop refused on edit; a JSON file with A to B to A opens with the banner, and its Remove button clears it | P |
| Method and limits panel | opens from Help | P |

### Menus and toolbar

| Item | Result |
|---|---|
| File: Schedules on this device (open, delete, examples, new, open a file), Open a file, New schedule, Delete all data | P |
| File and toolbar Export: P6 XER, Project XML, CSV, Copy as CSV (clipboard or copy dialog), Gantt chart PDF, JSON backup | P |
| Edit: Undo, Redo, History, Add activity, Delete activity, Find activity | P |
| View: four views, three row densities, relationship lines, float bars, baseline bars, activity details, expand and collapse WBS, Fit all columns, zoom in and out, theme | P |
| Project: Schedule, Project and schedule options, Calendars, WBS, Resources, Baselines | P |
| Tools: Update progress, Resource leveling suggestion, Schedule check, Apply all suggested fixes | P |
| Help: Keyboard shortcuts, Method and limits, Network use | P |
| Toolbar: Schedule, Add, Delete, Undo, Redo, Update, Baseline, Level, Layout, Filter, Find, Zoom out, Zoom in, Export, More (phone) | P |
| Theme button (device, light, dark) and phone menu button | P |
| Column edge drag and double-click fit; table splitter drag and arrow keys | P |

### Dialogs and form rules

| Dialog | Rules checked | Result |
|---|---|---|
| New schedule | blank name gets a default; empty start refused; four calendars | P |
| Project and schedule options | non-numbers refused; data date, must finish by, critical and float definitions applied | P |
| Calendars | bad work period, hours per day, exception line, February 30 and a week with no work refused; new and delete | P |
| Resources | negative maximum refused; add, edit, remove | P |
| WBS | a parent loop refused; add, parent, remove (children move up) | P |
| Baselines | save, make active, delete; variance columns | P |
| Update progress | proposals with reasons, untick, earlier or empty date explained, apply, one undo | P |
| Gantt chart PDF | four page sizes, baseline, links and filter options | P |
| File opened report | stored dates agreeing (36 of 36 in both samples), tables read, notes, differences | P |
| Keyboard shortcuts, Network use, Delete all data, Copy this text, Find (phone), Choose a project | P |
| Cell edits: ID (blank and duplicate refused), name (markup kept as text), durations (negative and text refused), %, start and finish (constraints), actual dates (cleared), predecessors (lags, unknown ID and loops refused) | P |

### Keyboard

F9, Insert, Delete, F2, Enter, typing to start an edit, Esc, arrows, Tab, Shift+Tab, Page Up, Page Down, Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z, Ctrl+= and Ctrl+-, Ctrl+O, Ctrl+F, Ctrl+P, menu arrows and Esc: all P.

### Files

| Item | Result |
|---|---|
| Import XER, Project XML and JSON, format from content | P |
| Multi-project XER (exported project opened, others offered) | P (`test_published.py`) |
| Hostile imports: empty, garbage, truncated XER, entity bomb, 5,000-deep JSON, wrong types, PNG | refused with a message, schedule unchanged: P |
| Export XER: CRLF, Windows-1252, read back here and by MPXJ with no errors | P |
| Export Project XML: parses, read back here and by MPXJ | P |
| Export CSV: one row per activity, header | P |
| Export PDF: tabloid, letter, A3, A4 landscape, rendered | P |
| JSON backup reopens | P |
| Round trip of own XER with dates agreeing | P |

### Storage, network, PWA, framing

| Item | Result |
|---|---|
| Autosave and reload | P |
| Delete all data (example only after reload) | P |
| No network requests, one gate with no features (refusal path covered by `test_browser.py`) | P |
| Content-Security-Policy: no violations in the strict run | P |
| Service worker: offline start after the first visit | P (`test_published.py`) |
| Manifest: name, icons, relative start URL; registration on https only | P |
| Page framed by another page: app not mounted, notice shown | P |
| `web/app.html` over `file://`: runs, imports, keeps the schedule; its only request is the web font stylesheet | P |
| Phone 400 px with touch, light and dark: no sideways scroll, touch targets 44 px, dense rows stay 44 px on touch | P |

### Command line

`example drill|build [--out]`, `schedule`, `check`, `fidelity`, `convert --to json|xer|mspdi|csv|pdf [--out] [--page letter|a4|tabloid|a3]` (PDF and XER bytes to stdout unchanged), a missing file, an unknown format, an empty file and a fuzzed file: all P, with exit code 2 and a one-line error for bad input.

### Library (Python and JavaScript)

Calendars (`compile_calendar`, `add_work`, `sub_work`, `work_between`, `snap_fwd`, `snap_back`, `standard_week`, date parsing and formatting), `validate_project`, `schedule` (forward and backward pass, float, longest path, constraints, ALAP, progress, out of sequence), `wbs_rollup`, `tree_rows`, `propose_update`, `apply_update`, `take_baseline`, `variance`, `histogram`, `leveling_suggestions`, `apply_leveling`, `check`, `apply_fix`, `open_ends`, `read_xer`, `write_xer`, `parse_tables`, `parse_clndr_data`, `read_mspdi`, `write_mspdi`, `parse_duration`, `open_file`, `compare_stored`, `export_csv`, `render_pdf`: covered by the pytest suite and by 663 parity cases (157,877 exact comparisons) between the two cores.

## Correctness checks

- **Hand-worked** (`tests/test_hand_audit.py`): a network with FS+2d, FF+1d, SS+2d and SF links and a start on or after constraint whose driving date falls at the end of a day, on a calendar with a lunch hour (every early and late date, total and free float, the critical set); a resource histogram with two overlapping assignments (24 and 16 unit-hours, 3 units at once, the 8 unit-hour limit, the week total); the leveling delay and whether it is within float; Update progress proposals; the DCMA counts on a ten-activity network (open ends, leads, lags, relationship types at exactly 90%, hard constraints, resources, the critical path test).
- **Against MPXJ's PrimaveraScheduler** (`tests/crosscheck_mpxj.py`), 80 random networks per calendar with every relationship type and lags from -4h to +2d: 3,655 of 3,655 values agree on each single calendar (five day with a lunch hour and holidays, six day, 24 hour), and 1,375 of 1,375 in each of three more runs that start in a leap year February, before a year end and before a daylight saving weekend. The differences that remain have known causes:
  - Two calendars mixed: 55 of 3,655 differ. Each case examined is an instant that is the same working time on one calendar but not on the other (a finish at 12:00 before a lunch hour seen by a successor that works through lunch), or an MPXJ result whose finish is before its start.
  - With constraints: 8 of 80 networks differ. Every case examined is an MPXJ result that breaks its own logic (a finish before its start on a start on or after constraint, or a start before its finish-to-start predecessor's finish); the same situations are worked by hand in `test_hand_audit.py`.
  - Progressed schedules: about 94% agree. The differences are relationships into or out of activities that are already in progress or complete, where P6's own behavior is not published and MPXJ's model of it differs from the rules in the README.
  - The drilling example's finish milestone on the office calendar: P6 rules (and MPXJ) take its late date as the end of the previous working day before a holiday, so 24 hour rig work before it shows 30 hours of negative float; this tool takes the next working minute and shows positive float, which is the slack the rig work really has. The README discusses mixed calendar float.

## How to rerun

```
pip install -e .[dev] playwright
pytest -q                                   # 114 tests, including the published page test
python tests/make_vectors.py && node web/parity.test.mjs
python tests/crosscheck_mpxj.py --cp "/path/to/mpxj/lib/*" --runs 80 --cal 5   # needs Java and MPXJ
```

`tests/test_published.py` copies the tracked `docs/` folder, fills the publish placeholders, serves it under `/drawworks/` and walks the main workflows with the real Content-Security-Policy, so a fault that only shows on the published page fails the suite.

## Test counts

| | Before | After |
|---|---|---|
| pytest | 103 | 114 |
| Parity cases (comparisons) | 662 (157,851) | 663 (157,877) |

## Known limits of this test

- The XER export has still not been imported into Primavera P6 itself; MPXJ reads it without errors.
- Install prompts, real phones and real clipboards were not tested; touch was emulated in Chromium.
- Service worker registration is limited to https by design, so offline start was checked by registering the worker by hand on localhost.

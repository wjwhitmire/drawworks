// ---------------------------------------------------------------- method notes and start-up
const METHOD = [
  ["What it does", [
    "Critical path scheduling in the browser: activities with durations in hours or days, a work breakdown structure, calendars with work periods, holidays and exceptions, finish-to-start, start-to-start, finish-to-finish and start-to-finish relationships with positive or negative lags, constraints, progress against a data date, baselines, resources and histograms.",
    "It opens Primavera P6 XER files and Microsoft Project XML (MSPDI) files, detecting the format from the file's content, and writes both back, plus CSV, a Gantt chart PDF and its own JSON backup. Everything happens on this device.",
  ]],
  ["Forward and backward pass", [
    "Forward pass, for an activity with remaining duration D: FS sets early start at or after the predecessor's early finish plus lag; SS early start at or after the predecessor's early start plus lag; FF early finish at or after the predecessor's early finish plus lag; SF early finish at or after the predecessor's early start plus lag. Early start moves to the next working minute on the activity's calendar and early finish is early start plus D working minutes.",
    "Backward pass mirrors it from the latest early finish (or the must-finish-by date): FS late finish at or before the successor's late start minus lag, SS late start at or before the successor's late start minus lag, FF late finish at or before the successor's late finish minus lag, SF late start at or before the successor's late finish minus lag.",
    "Lags count working time on the predecessor's calendar by default (option: successor's, 24 hour or project calendar). A negative lag is a lead. An elapsed lag from a Project XML file counts on a 24 hour calendar.",
    "Total float is late finish minus early finish (option: start float, or the smaller of the two), in working time on the activity's calendar. Free float is the smallest slack to any successor; an activity without successors gets its total float. Critical means total float at or below the threshold (default zero) or, as an option, on the longest path: traced back from the latest-finishing activity through driving relationships.",
  ]],
  ["Dates and calendars", [
    "A task of 8 hours that starts at 08:00 finishes at 16:00 the same day, not 08:00 the next morning. Dates that differ only by non-working time on the activity's calendar are the same in working time, so float between them is zero.",
    "Start milestones sit at the next working minute after their driving date; finish milestones keep the finish time of their driver.",
  ]],
  ["Constraints", [
    "Start on or after and finish on or after push early dates; start on or before and finish on or before pull late dates (negative float shows when they cannot be met). Start on and finish on do both, with logic still winning forward. Mandatory start and finish set early and late dates to the date over logic. As late as possible shows the activity later by its free float; its float and the critical path use its early dates.",
    "Typing a start in the table sets a start on or after constraint and typing a finish sets a finish on or after constraint, as desktop schedulers do; both can be undone.",
  ]],
  ["Progress", [
    "Complete activities keep their actual dates and carry no float. In-progress activities keep their actual start and schedule their remaining duration from the data date. With retained logic the remaining work also waits for unfinished finish-to-start predecessors; with progress override it ignores its predecessors. Out-of-sequence links are listed in the schedule check.",
    "Percent complete is by duration (from remaining duration), physical (entered) or units (actual quantity over actual plus remaining). Update progress rolls the data date forward and proposes actual dates and remaining durations from the plan, with a reason for each; nothing changes until you apply, and undo reverses the whole update.",
  ]],
  ["Resources and leveling", [
    "Assignments place units per hour on each working day of the activity. The histogram shows actual and remaining quantity per day or week, the available quantity, and periods where more than the maximum units are in use at once.",
    "The leveling suggestion is a serial method: activities in logic order, earliest early start first, each placed at the earliest moment its resources fit. It only suggests: a preview draws each leveled bar as a dashed outline beside its current bar, and applying adds start on or after constraints that one undo removes.",
  ]],
  ["Files", [
    "XER: reads PROJECT, CALENDAR, SCHEDOPTIONS, PROJWBS, TASK, TASKPRED, RSRC, RSRCRATE and TASKRSRC; other tables and fields are kept out of the way and listed. Text is read as UTF-8 when it is valid UTF-8, otherwise as Windows-1252; exports are written in Windows-1252. Level of effort and WBS summary activities come in as tasks, secondary constraints are dropped, and cross-project links are skipped, each with a note.",
    "Project XML: reads calendars with base calendar inheritance and both styles of exception, summary tasks as WBS, tasks, links with all lag formats, resources and assignments, and baseline 0. Must start on and must finish on come in as mandatory constraints. Files with a DOCTYPE or entity declarations are refused. Recurring exceptions and alternate work weeks are not imported.",
    "After an import the dates stored in the file are compared with this tool's calculation and the agreement is reported.",
    "The XER export follows the published layout as closely as it can: P6's table order, field names and codes, Windows-1252 text with CRLF line ends, schedule options in SCHEDOPTIONS, project calendars for activities and a shared resource calendar for resources. It reads back cleanly here and in an independent open-source XER reader, but it has not been imported into P6 itself; check a first import before relying on it. Characters outside Windows-1252 are written as \"?\" and the export says how many.",
    "Elapsed lags do not survive XER (P6 counts every lag on a calendar), and start milestones do not survive Project XML, which has one kind of milestone. Project XML has one hours-per-day figure for the whole file, so durations on a calendar with a different day length show in that file's days.",
  ]],
  ["Schedule check", [
    "The metrics are the DCMA 14-point assessment with its published limits: logic (open ends) at most 5% of incomplete activities, no leads, lags on at most 5% of relationships, at least 90% finish-to-start, hard constraints on at most 5%, total float over 44 working days on at most 5%, no negative float, baseline (or original) duration over 44 working days on at most 5%, no actual dates after the data date, activities without resources (reported, no limit), missed activities at most 5% of those whose baseline finish has passed, a critical path that runs unbroken back to the data date, a critical path length index of 0.95 or more and a baseline execution index of 0.95 or more. Out-of-sequence progress is listed after the fourteen.",
    "The 44 day limits are working minutes in Schedule options (44 days of 8 hours unless changed). Missed activities and the baseline execution index need the active baseline; the critical path length index measures the critical path from the data date to the finish against the must-finish-by date, or the latest baseline finish when there is none.",
  ]],
  ["History and undo", [
    "Every change is one undoable step, listed in History with who or what made it (you, or the tool acting for you, such as the finish-to-start link added with a new activity or the links that bridge a deleted one), the reason in one sentence, and what the recalculation did to the finish. Undo to here reverses a step and everything after it. Read-only steps such as a file opened or a schedule run are listed with nothing to undo.",
  ]],
  ["Gantt chart PDF", [
    "A vector PDF on white paper at tabloid, letter, A3 or A4 landscape: title and project finish at the top, the activity table and chart on one row grid with WBS bands, a two-tier timescale with data date and finish flags, driving relationship lines, and a legend and title block across the bottom. Each bar state keeps its own pen pattern (solid, hatched, open, ink), so a gray print still reads.",
  ]],
  ["Limits", [
    "Files up to 64 MB and 100,000 activities. No resource leveling inside the schedule itself (suggestions only), no costs or earned value, no level of effort activities, no multiple projects at once, no time zones or daylight saving (dates are wall-clock times, as in the files).",
    "Schedules are stored in this browser's IndexedDB. Clearing site data removes them; export a JSON backup to keep a copy.",
  ]],
];
function renderMethod() {
  const b = clear($("methodBody"));
  for (const [h, ps] of METHOD) { b.append(el("h3", { text: h })); for (const p of ps) b.append(el("p", { text: p })); }
}

async function main() {
  // the Pages build marks the page when another site frames it; the app is then not mounted at all
  if (document.documentElement.hasAttribute("data-framed")) return;
  renderMethod();
  wireShell();
  try { APP.db = await idbOpen(); } catch (e) { APP.db = null; }
  const theme = await kvGet("theme", "");
  if (theme) document.documentElement.dataset.theme = theme;
  themeIcon();
  APP.density = await kvGet("density", "comfortable");
  if (!DENSITY.some(([k]) => k === APP.density)) APP.density = "comfortable";
  $("app").dataset.density = APP.density;
  APP.colw = await kvGet("colw", {}) || {};
  APP.layout = await kvGet("layout", "classic");
  if (!LAYOUTS[APP.layout]) APP.layout = "classic";
  APP.zoom = Math.max(0, Math.min(ZOOMS.length - 1, await kvGet("zoom", 2)));
  APP.tw = await kvGet("tw", 742);
  APP.links = await kvGet("links", true);
  APP.float = await kvGet("float", true);
  APP.baseline = await kvGet("baseline", true);
  APP.details = await kvGet("details", true);
  APP.projects = await kvGet("projects", []);
  const cur = await kvGet("current", "");
  let p = null;
  if (cur) { try { const raw = await dbGet("projects", cur); if (raw) { p = C.validate_project(raw); APP.key = cur; } } catch (e) { p = null; } }
  if (!p) {
    p = exampleProject("drill");
    APP.key = newKey();
  }
  APP.p = p;
  recalc();
  const first = APP.rows.find((r) => r.kind === "a" && APP.s && APP.s.acts[r.id].status !== "complete");
  APP.sel = first ? first.id : null;
  setPane("table");
  const v = await kvGet("view", "acts");
  showView(["acts", "net", "res", "check"].includes(v) ? v : "acts");
  if (APP.sel) { cursor.i = APP.rowIndex.get(APP.sel) || 0; selectAct(APP.sel, "gantt"); }
  logNote("Opened " + APP.p.name, APP.p.label ? "The example opens on first use. " + APP.p.label : "Reopened from this device's storage, where it was saved after the last change.");
  await saveNow();
  document.body.dataset.ready = "1";
}
main();

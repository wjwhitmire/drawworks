# Security

## What the tool does with your data

- No network requests of any kind. The page loads no scripts, fonts or images from other hosts in its GitHub Pages build, whose Content-Security-Policy allows only the page's own hashed scripts and sets `connect-src 'none'`. A headless browser test opens the page, imports files, exports files and walks every view while recording requests: it fails on any request outside the page's own origin.
- Network features would have to pass through one gate function (`net()` in `web/src/ui/80_net.js`). The list of features is empty, so the gate refuses everything.
- Schedules are stored only in this browser's IndexedDB. File > Delete all data removes every schedule and preference, including the one that is open; the headless test checks that only the example that opens afterwards is stored. Every export is written on the device.
- The GitHub Pages build refuses to run inside another site's frame (Pages cannot send a header that forbids framing): a framed page shows only a notice with a link that opens the scheduler in its own tab, so a hidden frame cannot be used to trick clicks such as Delete all data. A headless test loads the page in a frame to confirm it.
- No eval, no `new Function`, no inline event-handler attributes; user text reaches the page only through `textContent` and attribute values.

## Hostile files

- Every file is capped at 64 MB before it is read. XER files are capped at 2 million rows, XML at 3 million elements and 64 levels of nesting, projects at 100,000 activities and 400,000 relationships.
- The XML reader is our own and strict: any DOCTYPE or ENTITY declaration is refused, so a file cannot define expanding entities ("billion laughs") or point at outside files. Only the five XML entities and numeric character references are decoded; anything else is an error.
- XER tables and rows are held in prototype-free objects, so a table or field named `__proto__` is an ordinary key.
- Every imported value is checked against strict field rules (known keys, length caps, real dates, whole minutes in range, references that resolve) before it is used; a failed check changes nothing.
- CSV exports prefix any cell that starts with `=`, `+`, `-`, `@`, tab or carriage return with an apostrophe so spreadsheets do not run it as a formula. A cell that is only a number (such as a negative float of `-2.50`) is left as a number.
- The Python command line reads only the file named on its command line and writes only to standard output or the `--out` path. No pickle, no eval, no shell calls.

## Reporting an issue

Open a GitHub issue titled "Security" with a description and steps to reproduce. For anything sensitive, use GitHub's private vulnerability reporting on this repository instead of a public issue.

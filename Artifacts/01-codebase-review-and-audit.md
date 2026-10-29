# 01 — Codebase Review & Audit

## 1. Architectural Strengths

Gr8r Studio is a zero-dependency vanilla ES module SPA built with Vite. Every user action or preference mutation invokes `render()` (`src/shell/render.js`), which runs `applyPrefs()` (`src/core/theme.js`) and reconstructs `#app` and `#layer` from template literals.

### Why this architecture is ideal for i18n & RTL:

1. **Zero Reactive Plumbing Required for Language Switching:** Because `render()` rebuilds all HTML strings synchronously on every state change, changing `S.prefs.lang` and calling `render()` immediately re-evaluates every label, date, and layout direction across the entire app without stale component trees.
2. **Language-Agnostic Focus & Scroll Preservation:**
   - Focus restoration (`focusKey()` in `src/shell/render.js`) relies on element IDs and `data-*` attributes (`FKEYS = ['a', 'id', 'r', 'tab', 'pop', ...]`), not visible text content.
   - Scroll restoration (`[data-keep]` in `src/shell/render.js`) uses route and entity IDs (`c:${u.route}:${u.params.id}`), remaining completely unaffected by translation or RTL direction changes.
3. **Centralized Preference Application:** `applyPrefs()` in `src/core/theme.js` already syncs `S.prefs` onto `document.documentElement` before every render pass.

---

## 2. Identified Bottlenecks & Audit Results

### A. Static English Vocabulary Evaluated at Module Import Time

Several modules define arrays and lookup maps at top-level import time with hardcoded English `.name` strings:

- **`src/core/constants.js`:**
  - `STATUSES` (`Backlog`, `To Do`, `In Progress`, `Review`, `Done`) and `ST` map.
  - `PRIOS` (`Urgent`, `High`, `Medium`, `Low`, `No priority`) and `PR` map.
  - `LABELS` (`Design`, `Frontend`, `Backend`, `Research`, `Content`, `Bug`, `QA`, `Growth`) and `LB` map.
  - `PSTAT` (`Planning`, `In Progress`, `At Risk`, `On Hold`, `Completed`).
  - `ROLES` (`Owner`, `Admin`, `Member`, `Guest`).
  - `TEAMS_SEED` (`Design`, `Engineering`, `Marketing`, `Product`).
- **`src/core/store.js`:**
  - `DEFAULT_PREFS.lang` is stored as `'English (US)'` instead of a standard BCP-47 locale tag (`'en-US'`, `'fa-IR'`).
  - `NO_TEAM` has hardcoded `name: 'No team'`.
- **`src/shell/render.js`:**
  - `ROUTE_NAMES` (`Home`, `Inbox`, `My Tasks`, etc.) is a static object evaluated once.
- **`src/pages/settings.js`:**
  - `SET_NAV` navigation groups and section titles are static arrays.
- **`src/overlays/modals.js`:**
  - `SHORTCUTS` groups and descriptions are static arrays.

### B. Physical CSS Properties Breaking RTL Layouts

The stylesheets (`src/styles/*.css`, `src/styles/views/*.css`, `src/styles/pages/*.css`) use physical horizontal properties (`left`, `right`) instead of CSS Logical Properties (`inline-start`, `inline-end`):

- **`src/styles/shell.css`:**
  - `.side { border-right: 1px solid var(--border); }` — Sidebar border stays on the right in RTL when the grid column moves to the right.
  - `.ws { text-align: left; }` and `.sitem { text-align: left; }` — Sidebar items stay left-aligned in RTL.
  - `.sitem .ct`, `.sitem .sdot`, `.sitem .hov`, `.topsearch .kbd`, `.ph .acts` use `margin-left: auto` — Pushes badges and action toolbars to the wrong side in RTL.
  - `.sub { padding-left: 14px; margin-left: 8px; border-left: 1px solid var(--border); }` — Project sub-navigation tree indents from the left instead of the right in RTL.
  - `.topbar { padding: 0 12px 0 var(--gutter); }` — Asymmetric horizontal padding.
- **`src/styles/overlays.css`:**
  - `.drawer { right: 0; border-left: 1px solid var(--border); box-shadow: -18px 0 40px -24px ... }` — Drawer always anchors to the physical right edge instead of `inset-inline-end: 0`, and `drawerIn` animates from `translateX(48px)`.
  - `.modal-h .ibtn { margin-left: auto; }` — Close button stays on the physical right instead of inline-end.
- **`src/styles/panels.css`:**
  - `.stat { text-align: left; }` and `.stat + .stat { border-left: 1px solid var(--border); }` — Dividers between stat cards draw on the wrong side in RTL.
  - `.panel-h .acts { margin-left: auto; }` — Panel header actions fail to push to the inline end.
- **`src/styles/responsive.css`:**
  - `.side { left: 0; transform: translateX(-100%); }` — Mobile navigation drawer slides from the physical left even in RTL.
  - `.list-wrap { padding-left: var(--gutter); }` — Asymmetric padding on mobile lists.

### C. Hardcoded English Dates, Relative Times & ASCII Numerals

- **`src/core/utils.js`:**
  - `MON`, `MONL`, `WD`, `WDL` are hardcoded English arrays (`['Jan', 'Feb', ...]`, `['Sun', 'Mon', ...]`).
  - `fmtDate(s, long)` manually concatenates `MON[d.getMonth()]` and `d.getDate()` using Gregorian getters (`getFullYear()`, `getMonth()`, `getDate()`).
  - `relDate(s)` returns hardcoded `'Today'`, `'Tomorrow'`, `'Yesterday'`, or `WD[...]`.
  - `ago(ts)` concatenates `'just now'`, `m + 'm ago'`, `h + 'h ago'`, `d + 'd ago'`.
  - `dayBucket(ts)` returns `'Today'`, `'Yesterday'`, `'This week'`, `'Earlier'`.
- **`src/shell/render.js`:**
  - `countUp()` matches `/^(\d+)(%?)$/` and renders ASCII digits (`Math.round(to * e) + suf`), which skips localized Persian numerals (`۰-۹`).
- **`src/views/calendar.js` & `src/overlays/popovers.js` (`miniCal`):**
  - Month grid calculation (`new Date(cur.getFullYear(), cur.getMonth(), 1)`) is coupled to the Gregorian calendar and cannot display Solar Hijri (Jalali) months for Farsi users without calendar-aware helpers.

### D. JavaScript Horizontal Coordinate & Pointer Math

- **`src/overlays/popovers.js` (`openPop`, `placePop`) & `src/ui/select.js` (`selectMenu.open`):**
  - Popovers record `x: r.left` and clamp against `x + w > innerWidth - 8`. In RTL, dropdowns should align their inline-start (right) edge with `r.right` (`r.right - w`) and overflow toward the left.
- **`src/actions/drag-drop.js`:**
  - Table column resizing (`[data-rsz]`, lines 202–235) computes `w = Math.max(64, w0 + ev.clientX - x0)`. In RTL, columns grow leftward, so `ev.clientX - x0` must be inverted (`(ev.clientX - x0) * -1`).
  - Timeline bar dragging (`[data-bar]`, lines 236–269) uses `style.left` and `dx = ev.clientX - x0`.
- **`src/views/timeline.js`:**
  - Gantt chart bars, weekend columns, grid lines, and SVG dependency curves (`<path d="...">`) use physical `left` coordinates and left-to-right day offsets.

### E. Directional Icons & Persian Keyboard Shortcuts

- **`src/core/icons.js`:**
  - Directional icons (`chevron-right`, `chevron-left`, `panel-left`, `arrow-left`, `arrow-right`) are rendered as static SVGs without horizontal mirroring in RTL.
- **`src/actions/keyboard.js`:**
  - Shortcuts inspect `e.key` (e.g. `e.key.toLowerCase() === 'k'`). When a user switches their OS input language to Persian (Farsi), pressing the physical `K` key produces `e.key === 'ن'`, and single-key shortcuts (`N`, `P`, `C`, `F`, `G`) produce Persian characters, breaking keyboard navigation unless `e.code` (`KeyK`, `KeyN`, etc.) is checked as a fallback.

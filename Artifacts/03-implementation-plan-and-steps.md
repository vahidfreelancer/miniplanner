# 03 — Phased Implementation Plan & Step-by-Step Checklist

## Phase 1: Foundation — i18n Core, Locale Dictionaries & Store Migration

### Step 1.1: Create `src/core/i18n.js`

- Define `LOCALES` metadata (`en-US`, `fa-IR`, etc.) with `dir`, `cal`, `weekStart`, and `digits`.
- Implement `t(key, vars)` with `{param}` interpolation and `Intl.PluralRules` support.
- Implement cached `Intl` formatters:
  - `fmtNum(val, options)`
  - `fmtCurrency(val, currency)`
  - `fmtRel(diff, unit)` via `Intl.RelativeTimeFormat(locale, { numeric: 'auto' })`
- Export `isRTL()`, `currentLocale()`, `currentCalendar()`, and `setLocale(code)`.

### Step 1.2: Create Translation Catalogs (`src/locales/en-US.js` & `src/locales/fa-IR.js`)

- Organize keys by namespace:
  - `common.*` (Save, Cancel, Delete, Edit, Close, Search, More, None, Loading…)
  - `nav.*` (Home, Inbox, My Tasks, Favorites, Notifications, Overview, Projects, Tasks, Calendar, Timeline, Members, Teams, Activity, Archive, Settings)
  - `status.*` (`backlog`: `پس‌زمینه / بک‌لاگ`, `todo`: `برای انجام`, `progress`: `در حال انجام`, `review`: `در حال بررسی`, `done`: `انجام‌شده`)
  - `priority.*` (`urgent`: `فوری`, `high`: `بالا`, `medium`: `متوسط`, `low`: `پایین`, `none`: `بدون اولویت`)
  - `labels.*`, `pstat.*`, `roles.*`
  - `drawer.*`, `modals.*`, `popovers.*`, `palette.*`
  - `views.board.*`, `views.list.*`, `views.table.*`, `views.calendar.*`, `views.timeline.*`, `views.files.*`
  - `pages.home.*`, `pages.inbox.*`, `pages.overview.*`, `pages.projects.*`, `pages.members.*`, `pages.settings.*`, `pages.auth.*`
  - `toasts.*`

### Step 1.3: Migrate Preferences & Reactive Constants

- **`src/core/store.js`:**
  - Change `DEFAULT_PREFS.lang` to `'en-US'`.
  - Add `DEFAULT_PREFS.calendar = 'auto'` (`'auto'`, `'gregory'`, `'persian'`).
  - In `load()`, map legacy saved language names (e.g. `'English (US)'` → `'en-US'`, `'فارسی'` → `'fa-IR'`).
- **`src/core/constants.js` & `src/shell/render.js`:**
  - Replace static `.name` strings in `STATUSES`, `PRIOS`, `LABELS`, `PSTAT`, `TEAMS_SEED`, and `ROUTE_NAMES` with getters calling `t()`.
- **`src/core/theme.js` & `src/main.js`:**
  - Remove hardcoded `document.documentElement.lang = 'en'` in `src/main.js`.
  - In `applyPrefs()`, set `document.documentElement.lang` and `document.documentElement.dir = isRTL() ? 'rtl' : 'ltr'`.

---

## Phase 2: Typography, CSS Logical Properties & RTL Layout

### Step 2.1: Add `Vazirmatn` Font & RTL Tokens

- **`index.html`:** Add Google Fonts link for `Vazirmatn:wght@400;500;600;700`.
- **`src/styles/tokens.css` & `src/styles/base.css`:**
  - Define `--dir: 1` on `:root` and `--dir: -1` on `:root[dir='rtl']`.
  - Override `--font` on `:root[lang^='fa']` and `:root[dir='rtl']` to prioritize `'Vazirmatn'`.
  - Reset `letter-spacing: 0` and `text-transform: none` for `:root[dir='rtl']`.
  - Add `dir: ltr; unicode-bidi: isolate;` on `.mono`, `kbd`, `.kbd`.

### Step 2.2: Convert Physical CSS to Logical Properties

Update the following files systematically:

1. **`src/styles/shell.css`:**
   - `.side`: `border-right` → `border-inline-end`
   - `.ws`, `.sitem`: `text-align: left` → `text-align: start`
   - `.sitem .ct`, `.sitem .sdot`, `.sitem .hov`, `.topsearch .kbd`, `.ph .acts`: `margin-left: auto` → `margin-inline-start: auto`
   - `.sitem .fav`: `margin-left: 4px` → `margin-inline-start: 4px`
   - `.sub`: `padding-left: 14px; margin-left: 8px; border-left: 1px solid var(--border)` → `padding-inline-start: 14px; margin-inline-start: 8px; border-inline-start: 1px solid var(--border)`
   - `.topbar`: `padding: 0 12px 0 var(--gutter)` → `padding-inline: var(--gutter) 12px`
2. **`src/styles/panels.css`:**
   - `.panel-h .acts`: `margin-left: auto` → `margin-inline-start: auto`
   - `.stat`: `text-align: left` → `text-align: start`
   - `.stat + .stat`: `border-left` → `border-inline-start`
3. **`src/styles/overlays.css`:**
   - `.modal-h .ibtn`: `margin-left: auto` → `margin-inline-start: auto`
   - `.drawer`: `right: 0; border-left: 1px solid var(--border)` → `inset-inline-end: 0; border-inline-start: 1px solid var(--border)`
   - `.drawer.full`: `right: 50%; transform: translateX(50%)` → `inset-inline-end: 50%; transform: translateX(calc(50% * var(--dir)))`
   - `@keyframes drawerIn`: `transform: translateX(calc(48px * var(--dir)))`
   - `.pop .mi .r`, `.pop .mi .ck`: `margin-left: auto` → `margin-inline-start: auto`
4. **`src/styles/views/*.css` (`list.css`, `board.css`, `table.css`, `calendar.css`, `timeline.css`, `projects-files.css`):**
   - Convert cell borders, sticky columns, resize handles (`[data-rsz]`), and group header margins to logical properties.
5. **`src/styles/pages/settings.css` & `src/styles/pages/auth.css`:**
   - `.set-nav`: `border-right` → `border-inline-end`
6. **`src/styles/responsive.css`:**
   - `.side`: `left: 0; transform: translateX(-100%)` → `inset-inline-start: 0; transform: translateX(calc(-100% * var(--dir)))`
   - `.list-wrap`: `padding-left: var(--gutter)` → `padding-inline-start: var(--gutter)`

### Step 2.3: Directional Icon Mirroring

- **`src/core/icons.js`:** Tag directional icons in `ic()` with `.i-dir`.
- **`src/styles/base.css`:** Add `:root[dir='rtl'] svg.i.i-dir { transform: scaleX(-1); }`.

---

## Phase 3: Calendar, Date & Numeral Localization

### Step 3.1: Create `src/core/calendar-math.js` for Gregorian & Jalali (Solar Hijri)

- Implement helper functions that operate on standard `Date` objects while respecting `currentCalendar()` (`'gregory'` vs `'persian'`):
  - `getCalParts(date)` → `{ year, month, day }` in active calendar.
  - `startOfCalMonth(date)` → `Date` corresponding to day `1` of the current Gregorian or Jalali month.
  - `addCalMonths(date, delta)` → `Date` shifted by `delta` months in the active calendar.
  - `getMonthTitle(date)` → localized month + year string (e.g., `'آبان ۱۴۰۵'` or `'October 2026'`).
  - `getWeekdayNames(short)` → localized weekday names starting from `S.prefs.weekStart`.

### Step 3.2: Refactor `src/core/utils.js`

- Update `fmtDate(s, long)` to use `Intl.DateTimeFormat(currentLocale(), { calendar: currentCalendar(), ... })`.
- Update `relDate(s)` and `ago(ts)` to use `fmtRel()` (`Intl.RelativeTimeFormat`).
- Update `dayBucket(ts)` to return `t('date.today')`, `t('date.yesterday')`, `t('date.thisWeek')`, `t('date.earlier')`.

### Step 3.3: Update Calendar View & Date Picker Popover

- **`src/views/calendar.js` & `src/overlays/popovers.js` (`miniCal`):**
  - Replace `new Date(cur.getFullYear(), cur.getMonth(), 1)` with `startOfCalMonth(cur)`.
  - Replace `d.getDate()` cell label with `fmtNum(getCalParts(d).day)`.
  - Replace month comparison `d.getMonth() !== cur.getMonth()` with `getCalParts(d).month !== getCalParts(cur).month`.
- **`src/actions/actions.js` (`calNav`, `popMonth`):**
  - Step months using `addCalMonths(cur, delta)`.

---

## Phase 4: JavaScript Positioning, Drag-and-Drop & Keyboard Shortcuts

### Step 4.1: RTL Popover & Select Menu Positioning

- **`src/overlays/popovers.js` (`openPop`, `placePop`) & `src/ui/select.js` (`selectMenu.open`):**
  - Record both `r.left` and `r.right` on trigger rect.
  - When `isRTL()` is true, default horizontal anchor to `r.right - w` (aligning the inline-start/right edges) and clamp within `[8, innerWidth - w - 8]`.

### Step 4.2: RTL Pointer Math (`src/actions/drag-drop.js` & `src/views/timeline.js`)

- **Table Column Resize (`src/actions/drag-drop.js`):**
  - Compute `const dir = isRTL() ? -1 : 1; const w = Math.max(64, w0 + (ev.clientX - x0) * dir);`.
- **Timeline View (`src/views/timeline.js`):**
  - Wrap `.tl-scroll` with `dir="ltr"` (or mirror coordinates via `inset-inline-start`) so chronological Gantt bars and SVG Bézier dependency arrows remain geometrically consistent with drag deltas.

### Step 4.3: Layout-Independent Keyboard Shortcuts (`src/actions/keyboard.js`)

- Add physical key-code fallback (`e.code`) so shortcuts (`⌘K`, `N`, `P`, `[`, `G`+`H`, etc.) work when the user's keyboard layout is set to Persian (`fa`).

---

## Phase 5: Template Localization, BiDi Polish & Verification

### Step 5.1: Template String Replacement & `dir="auto"` Attributes

- Replace remaining inline strings in:
  - `src/shell/layout.js`, `src/shell/view-engine.js`, `src/components/task-list.js`
  - `src/pages/*.js` (`home.js`, `overview.js`, `my-tasks.js`, `tasks.js`, `inbox.js`, `notifications.js`, `favorites.js`, `projects.js`, `members.js`, `activity.js`, `search.js`, `errors.js`, `project.js`, `settings.js`, `auth.js`)
  - `src/views/*.js` (`board.js`, `table.js`, `calendar.js`, `timeline.js`, `files.js`, `project-overview.js`)
  - `src/overlays/*.js` (`drawer.js`, `modals.js`, `popovers.js`, `context-menu.js`, `palette.js`)
  - `src/features/*.js` (`teams.js`, `subtasks.js`, `archive.js`)
- Add `dir="auto"` to user-editable fields and `dir="ltr"` to URL/email/code inputs.

### Step 5.2: Quality Assurance & Verification Checklist

- [ ] `npm run lint` and `npm run build` pass with zero warnings/errors.
- [ ] Switching language to **فارسی (Farsi)** in `Settings → Language` immediately flips `html[dir="rtl"][lang="fa-IR"]` without page reload.
- [ ] Sidebar appears on the right; Task Drawer slides in from the left; Mobile nav slides in from the right.
- [ ] Popovers, context menus, and `<select>` dropdowns align to the right edge of triggers and stay within viewport bounds.
- [ ] Dates render in Solar Hijri (`۶ آبان ۱۴۰۵`) and numbers/stats render in Persian numerals (`۰-۹`).
- [ ] Mixed Persian + English task titles and comments render cleanly without BiDi punctuation scrambling.
- [ ] Keyboard shortcuts (`⌘K`, `N`, `P`, `[`) work while the OS keyboard layout is set to Persian.

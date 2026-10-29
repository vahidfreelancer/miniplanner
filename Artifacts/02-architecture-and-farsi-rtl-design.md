# 02 — Technical Architecture & Farsi/RTL Design

## 1. Zero-Dependency i18n Engine (`src/core/i18n.js`)

To preserve MiniPlanner's fast startup, zero external runtime dependencies, and synchronous `render()` loop, we design a dedicated `src/core/i18n.js` module powered by native `Intl` APIs.

### Locale Registry

```js
export const LOCALES = {
  'en-US': {
    id: 'en-US',
    label: 'English (US)',
    nativeLabel: 'English (US)',
    dir: 'ltr',
    cal: 'gregory',
    weekStart: 1, // Monday
    digits: 'latn',
  },
  'en-GB': {
    id: 'en-GB',
    label: 'English (UK)',
    nativeLabel: 'English (UK)',
    dir: 'ltr',
    cal: 'gregory',
    weekStart: 1,
    digits: 'latn',
  },
  'fa-IR': {
    id: 'fa-IR',
    label: 'Persian (Farsi)',
    nativeLabel: 'فارسی (ایران)',
    dir: 'rtl',
    cal: 'persian', // Solar Hijri (Jalali)
    weekStart: 6, // Saturday (شنبه)
    digits: 'arabext', // ۰۱۲۳۴۵۶۷۸۹
  },
  'ar-SA': {
    id: 'ar-SA',
    label: 'Arabic',
    nativeLabel: 'العربية',
    dir: 'rtl',
    cal: 'gregory',
    weekStart: 6,
    digits: 'arab',
  },
  'de-DE': {
    id: 'de-DE',
    label: 'German',
    nativeLabel: 'Deutsch',
    dir: 'ltr',
    cal: 'gregory',
    weekStart: 1,
    digits: 'latn',
  },
  'es-ES': {
    id: 'es-ES',
    label: 'Spanish',
    nativeLabel: 'Español',
    dir: 'ltr',
    cal: 'gregory',
    weekStart: 1,
    digits: 'latn',
  },
  'fr-FR': {
    id: 'fr-FR',
    label: 'French',
    nativeLabel: 'Français',
    dir: 'ltr',
    cal: 'gregory',
    weekStart: 1,
    digits: 'latn',
  },
  'ja-JP': {
    id: 'ja-JP',
    label: 'Japanese',
    nativeLabel: '日本語',
    dir: 'ltr',
    cal: 'gregory',
    weekStart: 0,
    digits: 'latn',
  },
};
```

### Translation Lookup & Pluralization (`t()`)

- **Key Resolution:** Flat or nested dot-keys (`t('nav.home')`, `t('drawer.overdueBy', { count: 3 })`).
- **Pluralization via `Intl.PluralRules`:**
  - Dictionary entries can be strings or plural maps `{ one: '{count} day', other: '{count} days' }`.
  - In Farsi (`fa-IR`), `Intl.PluralRules('fa-IR').select(n)` resolves to `'other'` (or `'one'`/`'other'`), and `{count}` is automatically formatted using localized Persian digits (`۳ روز`).
- **Fallback Chain:** Active locale dictionary → `en-US` dictionary → human-readable key fallback.

### Reactive Vocabulary Getters in `src/core/constants.js`

Instead of rewriting every `ST[t.status].name` or `PR[t.priority].name` call across 30+ files, define `name` via getters on the vocabulary objects:

```js
export const STATUSES = [
  {
    id: 'backlog',
    get name() {
      return t('status.backlog');
    },
  },
  {
    id: 'todo',
    get name() {
      return t('status.todo');
    },
  },
  {
    id: 'progress',
    get name() {
      return t('status.progress');
    },
  },
  {
    id: 'review',
    get name() {
      return t('status.review');
    },
  },
  {
    id: 'done',
    get name() {
      return t('status.done');
    },
  },
];
```

Every template reading `ST[s].name`, `PR[p].name`, `LB[l].name`, or `PSTAT[st].name` will automatically receive the translated label on every `render()`.

---

## 2. RTL & Bidirectional (BiDi) Layout Strategy

### A. Document Root State (`src/core/theme.js`)

In `applyPrefs()`:

1. Resolve locale meta from `LOCALES[S.prefs.lang] || LOCALES['en-US']`.
2. Set `document.documentElement.lang = meta.id`.
3. Set `document.documentElement.dir = meta.dir` (`'rtl'` or `'ltr'`).
4. Set `document.documentElement.dataset.dir = meta.dir`.

### B. CSS Logical Properties Conversion Table

All stylesheets are updated using standard CSS Logical Properties (supported in 100% of modern evergreen browsers):

| Legacy Physical Property         | Logical Replacement                                             | Primary Affected Selectors                                                                                      |
| :------------------------------- | :-------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------- |
| `margin-left: auto`              | `margin-inline-start: auto`                                     | `.sitem .ct`, `.sitem .sdot`, `.sitem .hov`, `.topsearch .kbd`, `.ph .acts`, `.modal-h .ibtn`, `.panel-h .acts` |
| `margin-right: X`                | `margin-inline-end: X`                                          | Toolbar badges, breadcrumbs, avatar stacks                                                                      |
| `padding-left` / `padding-right` | `padding-inline-start` / `padding-inline-end`                   | `.topbar`, `.sub`, `.list-wrap`, `.tlist`, `.perm-t th/td`                                                      |
| `border-left` / `border-right`   | `border-inline-start` / `border-inline-end`                     | `.side`, `.sub`, `.stat + .stat`, `.drawer`, `.set-nav`, `.wcol`                                                |
| `left: 0` / `right: 0`           | `inset-inline-start: 0` / `inset-inline-end: 0`                 | `.drawer`, `.side` (mobile), `.skip`, `.topbar` notification dot                                                |
| `text-align: left` / `right`     | `text-align: start` / `end`                                     | `.ws`, `.sitem`, `.stat`, `.perm-t th/td`, `.strength + span`                                                   |
| `border-radius: 6px 0 0 6px`     | `border-start-start-radius: 6px; border-end-start-radius: 6px;` | Workspace URL prefix/input in `settings.js`                                                                     |

### C. Directional Motion Variable (`--dir`)

In `src/styles/tokens.css`:

```css
:root {
  --dir: 1;
}
:root[dir='rtl'] {
  --dir: -1;
}
```

- **Drawer entrance (`src/styles/overlays.css`):**
  `transform: translateX(calc(48px * var(--dir)))` — slides in from the left edge when in RTL, and from the right edge in LTR.
- **Mobile Sidebar (`src/styles/responsive.css`):**
  `inset-inline-start: 0; transform: translateX(calc(-100% * var(--dir)))` — slides in from the right edge in RTL.

### D. BiDi Text Isolation (`dir="auto"` and `dir="ltr"`)

Farsi teams constantly mix Persian sentences with Latin words (e.g., `طراحی UI صفحه Login در Figma` or task keys like `WEB-104`):

1. **User Content (`dir="auto"`):** Apply `dir="auto"` on task titles (`.ttl`, `#d-title`), comments (`.cbox textarea`, comment bodies), rich text descriptions (`#d-desc`), project descriptions, and toast messages so paragraphs align according to their first strong directional character.
2. **Technical Identifiers (`dir="ltr"`):** Apply `dir: ltr; unicode-bidi: isolate;` in CSS to `.mono`, `.kbd`, `kbd`, task keys (`WEB-104`), email addresses, URL inputs (`#ws-url`), and recovery/2FA codes so they never scramble in RTL context.

### E. Directional Icon Mirroring (`src/core/icons.js`)

Define the set of directional icons that represent horizontal flow or navigation:

```js
export const RTL_MIRROR_ICONS = new Set(['chevron-right', 'chevron-left', 'panel-left', 'arrow-right', 'arrow-left', 'corner-down-right', 'log-out', 'reply']);
```

In `ic(name, size, cls)`, automatically append `' i-dir'` when `RTL_MIRROR_ICONS.has(name)`.
In `src/styles/base.css`:

```css
:root[dir='rtl'] svg.i.i-dir {
  transform: scaleX(-1);
}
:root[dir='rtl'] .sitem .chev.open {
  transform: scaleX(-1) rotate(90deg);
}
```

_(Note: Checkmarks `check`, `circle-check`, clocks, and brand logos are **never** mirrored.)_

---

## 3. Farsi (Persian) Specific Design

### A. Persian Typography (`Vazirmatn`)

- **Font Pairing:** `Vazirmatn` is the industry-standard modern geometric Persian/Arabic UI typeface that matches `Geist`'s clean proportions and weights (`400`, `500`, `600`).
- **Font Loading:** Inject `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;600;700&display=swap" />` in `index.html` (or lazily in `applyPrefs()` when `dir === 'rtl'`).
- **Persian Script CSS Adjustments (`src/styles/tokens.css` & `src/styles/base.css`):**
  ```css
  :root[lang^='fa'],
  :root[dir='rtl'] {
    --font: 'Vazirmatn', 'Geist', ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif;
  }
  :root[dir='rtl'] body {
    line-height: 1.6;
    font-feature-settings: normal;
  }
  :root[dir='rtl'] .ph h1,
  :root[dir='rtl'] h2.sec,
  :root[dir='rtl'] .sgroup-h,
  :root[dir='rtl'] .eyebrow,
  :root[dir='rtl'] .stat .v {
    letter-spacing: 0;
    text-transform: none;
  }
  ```
  _Why:_ Negative letter-spacing (`-0.022em`) causes cursive Persian glyphs to overlap or detach at connection points, and `letter-spacing: 0.07em` on uppercase eyebrows disconnects joined Persian letters.

### B. Persian Numerals (`fmtNum`)

- Provide `fmtNum(n, opts)` in `src/core/i18n.js` using a cached `Intl.NumberFormat(locale, opts)`.
- In `fa-IR`, `fmtNum(1240)` outputs `'۱٬۲۴۰'` and `fmtNum(85) + '%'` (or `Intl.NumberFormat('fa-IR', { style: 'percent' })`) outputs `'۸۵٪'`.
- Update `countUp()` in `src/shell/render.js` so dashboard KPI animations format each frame with `fmtNum(Math.round(to * e))`.

### C. Solar Hijri (Jalali) Calendar & Date Formatting (`src/core/calendar-math.js`)

- **Internal Representation:** Keep all task `due`, `start`, and event dates stored as ISO-8601 Gregorian strings (`YYYY-MM-DD`, e.g., `'2026-10-28'`). This guarantees data portability when switching languages.
- **Display Formatting (`fmtDate` in `src/core/utils.js`):**
  - Use `Intl.DateTimeFormat(locale, { calendar: activeCalendar, month: 'short', day: 'numeric', year: ... })`.
  - For `fa-IR` with the Persian calendar, `'2026-10-28'` formats automatically as `'۶ آبان'` (short) or `'۶ آبان ۱۴۰۵'` (long).
- **Jalali Grid Arithmetic (`src/core/calendar-math.js`):**
  - While `Intl.DateTimeFormat` formats any `Date` into Jalali parts (`year`, `month`, `day`), building a 35/42-cell month grid in `src/views/calendar.js` and `miniCal()` (`src/overlays/popovers.js`) requires knowing:
    1. Which Gregorian `Date` corresponds to day `1` of the current Jalali month.
    2. How many days (`29`, `30`, or `31`) are in that Jalali month.
    3. Stepping `±1` Jalali month when clicking Previous/Next month in the calendar header.
  - We include a compact, zero-dependency Jalali/Gregorian converter (~45 lines of pure math using `Intl.DateTimeFormat('en-US-u-ca-persian')` part extraction + day offset) so both `calendar.js` and `miniCal()` work identically in Gregorian and Jalali modes.

### D. Persian Keyboard Layout Compatibility (`src/actions/keyboard.js`)

When a user's OS keyboard layout is set to **Persian**, pressing physical shortcut keys emits Persian characters in `e.key` (e.g., pressing physical `K` emits `'ن'`, physical `N` emits `'د'`, physical `[` emits `'ج'`).

- **Solution:** Add a helper `keyMatch(e, char)` in `src/actions/keyboard.js` that checks both `e.key.toLowerCase() === char` and `e.code === 'Key' + char.toUpperCase()` (or `BracketLeft` / `BracketRight` for `[` / `]`).
- This ensures `⌘K`, `N` (New task), `P` (New project), `[` (Collapse sidebar), and `G` then `H` work seamlessly even while typing in Farsi.

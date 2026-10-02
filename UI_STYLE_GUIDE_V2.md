# Triple Crown Sports — Brand & UI System

**Essence:** SHOW GREATNESS
**Aesthetic:** Ballpark Scoreboard — confident, data-dense, championship-grade
**Stack:** React 18 + plain CSS custom properties (no UI library)

> This is the single source of truth for every Triple Crown app. Colors, type,
> and voice below come straight from the *TCS Brand Standards*. When something in
> an app conflicts with this doc, the doc wins — file a migration note (§13).

---

## 1. Brand Foundation

Every screen is a chance to Show Greatness. The interface should feel like a
professionally run event: precise, prepared, and never sloppy in the details.

### Voice

Clear, direct, thoughtful, sincere. We're the best at what we do, so we speak
with confidence — never more or less than the truth. Success is the sum of the
smallest details, so every label, button, and message is deliberate.

### Tone in the product

| We Are | We Are Not |
|---|---|
| Honest, Direct, Focused | Vague, Indirect, Detached |
| Great, Amazing, Memorable | Ordinary, Low-tier, Forgettable |
| Professional, Organized, Intentional | Disorganized, Lazy, Indifferent |
| Innovative, Balanced, Fun | Weak, Mean-spirited, Disrespectful |

### Voice in the UI (microcopy rules)

Translate the brand voice into concrete copy. These override generic defaults.

| Surface | Do | Don't |
|---|---|---|
| **Buttons** | Confident action verbs tied to the job: `Build Showcase`, `Export Schedule`, `Compute Availability` | Generic `Submit`, `OK`, `Go` |
| **Empty states** | Point to the next action: `No games scheduled yet. Build your first showcase.` | Apologetic dead-ends: `Nothing here :(` |
| **Errors** | Direct, honest, no blame, always a way forward: `Availability hasn't been computed yet — run the ETL step first.` | Vague or accusatory: `Invalid input` / `You did that wrong` |
| **Success** | State the win plainly: `Schedule exported — 42 games across 6 fields.` | Over-celebrating trivial actions with `🎉` spam |
| **Loading** | Active and specific: `Building lineups…` | Bare `Loading...` when the action is known |
| **Labels** | Universal and true; the term the coach/director actually uses | Internal jargon or abbreviations users don't share |

**Principle:** confidence over hedging. Prefer "will" to "should," "run" to
"try to run." If a sentence could be shorter and still true, cut it.

### Traits & Values (reference)

Truthful · Empowered · High-Performance · Caring · Reliable · Respectful ·
Family · Quality · Legacy · Clear · Genuine · Accountable · Teamwork · Top-tier.
Family first · Respect of all · Humility · Work ethic · Integrity ·
Customer-centric.

---

## 2. Color Palette

### 2.1 Official brand colors (source of truth)

Straight from the brand book. These are the *only* brand colors — everything in
§2.2 is a UI-tuned expression of them.

| Role | PMS | HEX | RGB |
|---|---|---|---|
| **Navy (primary)** | 540 | `#003057` | 0, 48, 87 |
| **Red (primary accent)** | 200 | `#BA0C2F` | 186, 12, 47 |
| Gold | 1235 | `#FFB81C` | 255, 184, 20 |
| Orange | 153 | `#BE6A14` | 190, 106, 20 |
| Olive | 371 | `#546223` | 84, 98, 35 |
| Purple | 525 | `#572C5F` | 87, 44, 95 |
| Stone | 7534 | `#D1CCBD` | 209, 204, 189 |

Navy + Red carry the identity on every screen. Gold/Orange/Olive/Purple/Stone
are **secondary** — use them only as data-category accents (see §2.4), never as
general UI chrome.

### 2.2 CSS variables

All colors are defined as CSS custom properties on `:root`. Never use raw hex in
components — always reference the variable.

#### Brand — Navy (ramp anchored on PMS 540 `#003057`)
| Variable | Value | Use |
|---|---|---|
| `--navy-900` | `#001E37` | Sidebar gradient top, deepest fills |
| `--navy-800` | `#003057` | **Brand navy** — sidebar base, headings, primary button |
| `--navy-700` | `#0F4770` | Primary button hover |
| `--navy-600` | `#2E6D9C` | Input focus ring, stat card top border |
| `--navy-500` | `#5A93BE` | Light navy accent, chart fills |

#### Brand — Red (PMS 200 `#BA0C2F`)
| Variable | Value | Use |
|---|---|---|
| `--red` | `#BA0C2F` | Active nav item, sidebar event label, accent borders |
| `--red-hover` | `#970A26` | Red button/link hover |
| `--red-dim` | `rgba(186,12,47,0.12)` | Active nav background tint |

> **Legacy note:** older code names this variable `--gold` (it was red all
> along). New standard: `--red` is the accent; `--gold` is the *actual* gold
> `#FFB81C` below. See migration §13.

#### Surface
| Variable | Value | Use |
|---|---|---|
| `--cream` | `#F5F8FC` | Table header background, input hover |
| `--clay` | `#E7EDF4` | Clickable row hover |
| `--white` | `#FFFFFF` | Card, modal, input backgrounds |

#### Text
| Variable | Value | Use |
|---|---|---|
| `--text-primary` | `#12324D` | Body text, table cells |
| `--text-secondary` | `#4D6275` | Helper text, secondary labels |
| `--text-muted` | `#708396` | Table headers, form labels, empty states |

#### Borders
| Variable | Value | Use |
|---|---|---|
| `--border` | `#D6E0EA` | Cards, table rows, inputs |
| `--border-strong` | `#BECBD8` | Secondary button border, strong dividers |

### 2.3 Semantic (state only)

Reserved for status. **Brand red (`--red`) is not an error color** — keep danger
visually distinct so a normal accent never reads as a failure.

| State | Background | Text | Border/Icon |
|---|---|---|---|
| Success | `--success-bg` `#DCFCE7` | `--success-text` `#14532D` | `--success` `#166534` |
| Warning | `--warning-bg` `#FEF3C7` | `--warning-text` `#78350F` | `--warning` `#92400E` |
| Danger | `--danger-bg` `#FEF2F2` | `--danger-text` `#7F1D1D` | `--danger` `#991B1B` |
| Info | `--info-bg` `#E0F2FE` | `--info-text` `#0C4A6E` | `--info` `#075985` |

### 2.4 Secondary palette — sport / category accents (optional)

For tagging content by sport or category. Use as small accents (pill borders,
category dots, chart series) — not as page chrome.

| Variable | Value | Suggested category |
|---|---|---|
| `--gold` | `#FFB81C` | Baseball / featured |
| `--orange` | `#BE6A14` | Fastpitch |
| `--olive` | `#546223` | Lacrosse |
| `--purple` | `#572C5F` | Volleyball |
| `--stone` | `#D1CCBD` | Basketball / neutral tag |
| `--stone-30` | `rgba(209,204,189,0.30)` | Muted stone fill |

---

## 3. Typography

Brand typeface is **Gotham** (with **Gotham Extra Narrow** for tight, scoreboard-
style labels). Gotham is a licensed Hoefler&Co font — self-host the web fonts if
you own the license. **Montserrat** (free, Google Fonts) is the specified fallback
and the default when Gotham isn't licensed for a given app. `JetBrains Mono` is a
functional choice for data grids and is outside the brand type system.

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
```

If Gotham is self-hosted, declare it first in the stack and let Montserrat catch
the fallback:

```css
:root {
  --font-display:   'Gotham', 'Montserrat', -apple-system, system-ui, sans-serif;
  --font-body:      'Gotham', 'Montserrat', -apple-system, system-ui, sans-serif;
  --font-condensed: 'Gotham XNarrow', 'Montserrat', sans-serif;
  --font-mono:      'JetBrains Mono', ui-monospace, monospace;
}
```

| Variable | Family | Use |
|---|---|---|
| `--font-display` | Gotham / Montserrat (700–900) | Page titles, card headings, stat values, nav labels, "SHOW GREATNESS" moments |
| `--font-body` | Gotham / Montserrat (400–600) | Body text, buttons, form labels, table cells |
| `--font-condensed` | Gotham XNarrow / Montserrat | Dense scoreboard labels, tight column headers, badges |
| `--font-mono` | JetBrains Mono | Data values, availability grids, event/year label |

### Type Scale
| Element | Font | Size | Weight | Letter-spacing |
|---|---|---|---|---|
| Page `h1` | display | 32px | 800 | -0.02em |
| Card `h2` | display | 18px | 700 | -0.01em |
| Modal `h2` | display | 20px | 800 | -0.01em |
| Stat value | display | 40px | 800 | -0.01em |
| Body | body | 15px | 400 | — |
| Table cell | body | 14px | 400 | — |
| Table header | condensed | 12px | 700 | 0.03em (UPPERCASE) |
| Form label | condensed | 12px | 700 | 0.03em (UPPERCASE) |
| Button | body | 13px | 700 | 0.01em |
| Badge | condensed | 11px | 700 | 0.04em (UPPERCASE) |

> Gotham/Montserrat run slightly heavier than the old Plus Jakarta stack — favor
> weight **800** for display headings and stat values so titles keep their punch.

---

## 4. Spacing & Radii

| Variable | Value | Use |
|---|---|---|
| `--radius-sm` | 4px | Badges, phase labels |
| `--radius` | 7px | Buttons, inputs |
| `--radius-lg` | 12px | Cards, modals, detail panels |

Standard spacing rhythm: **8px base unit**. Common values: 8, 10, 12, 14, 16, 20, 24, 28, 32.

---

## 5. Shadows

| Variable | Value | Use |
|---|---|---|
| `--shadow-sm` | `0 1px 3px rgba(0,30,55,0.08), 0 1px 2px rgba(0,30,55,0.05)` | Cards, stat cards |
| `--shadow-md` | `0 4px 10px rgba(0,30,55,0.10), 0 2px 4px rgba(0,30,55,0.06)` | Modals, dropdowns |

> Shadow tint is derived from `--navy-900` so elevation reads as brand navy, not neutral gray.

---

## 6. Layout

### Shell Structure
```
.app (flex row)
├── .sidebar  (fixed, 224px wide)
└── .main-content  (flex: 1, margin-left: 224px, padding: 32px)
```

- `--sidebar-width: 224px`
- Sidebar is `position: fixed`, full viewport height
- Main content scrolls independently

### Page Header
Every page starts with `.page-header` (flex row, space-between):
```jsx
<div className="page-header">
  <h1>Page Title</h1>
  <div className="dashboard-actions">
    {/* buttons */}
  </div>
</div>
```

### Grid Layouts
| Class | Columns | Use |
|---|---|---|
| `.stats-grid` | `repeat(auto-fit, minmax(175px, 1fr))` | Dashboard stat cards |
| `.builder-top-grid` | `repeat(2, 1fr)` | Two-column builder sections |
| `.builder-bottom-grid` | `1.35fr 0.9fr` | Wide left + narrow right |
| `.builder-form-grid` | `repeat(3, 1fr)` | Three-column form fields |
| `.setup-grid` | `repeat(auto-fit, minmax(250px, 1fr))` | Setup/settings cards |

---

## 7. Components

### Card
```jsx
<div className="card">
  <h2>Section Title</h2>
  {/* content */}
</div>
```
- White background, `--radius-lg`, `--shadow-sm`, `--border` border
- `backdrop-filter: blur(3px)` for glass effect

**Alert card variant:**
```jsx
<div className="card card-alert">
  <h3>Warning Title</h3>
  <p>Message</p>
</div>
```

### Stat Card
```jsx
<div className="stat-card">
  <h3>LABEL</h3>
  <div className="value">42</div>
</div>
```
- Top border: 3px solid `--navy-600`
- Value uses `--font-display` at 40px / weight 800

### Buttons

Four variants, one size modifier:

```jsx
<button className="btn btn-primary">Build Showcase</button>
<button className="btn btn-secondary">Cancel</button>
<button className="btn btn-success">Confirm</button>
<button className="btn btn-danger">Delete</button>

<button className="btn btn-secondary btn-sm">Small</button>
```

| Class | Background | Text | Border |
|---|---|---|---|
| `btn-primary` | `--navy-800` | white | `--navy-800` |
| `btn-secondary` | white | `--text-secondary` | `--border-strong` |
| `btn-success` | `--success-bg` | `--success-text` | `--success` |
| `btn-danger` | `--danger-bg` | `--danger-text` | `--danger` |

- Default padding: `8px 16px`
- Small (`.btn-sm`): `5px 10px`, 12px font
- Primary hover: `--navy-700`
- Disabled: `opacity: 0.45`
- Transition: `all 0.15s`
- **Copy:** label the action, not the mechanism (see §1 microcopy rules)

### Badges
```jsx
<span className="badge badge-success">Active</span>
<span className="badge badge-warning">Pending</span>
<span className="badge badge-danger">Error</span>
<span className="badge badge-info">Info</span>
```
Inline label, `--radius-sm`, 11px bold `--font-condensed`, UPPERCASE.

### Pill
```jsx
<span className="pill">Baseball</span>
```
Rounded-full, navy tint background, 11px bold navy text. For compact metadata /
sport tags. For a sport-colored pill, tint border/dot with a §2.4 accent.

### Forms
```jsx
<div className="form-group">
  <label>Field Label</label>
  <input type="text" />
</div>
```
- Label: 12px, 700 weight, `--text-muted`, `--font-condensed`, uppercase tracking
- Input: `--border`, `--radius`, 14px body font
- Focus: `--navy-600` border + `rgba(46,109,156,0.18)` ring

**Filters row** (above tables):
```jsx
<div className="filters">
  <input type="text" placeholder="Search…" />
  <select>...</select>
</div>
```

### Tables
```jsx
<div className="table-container">
  <table>
    <thead>
      <tr><th>Column</th></tr>
    </thead>
    <tbody>
      <tr className="clickable" onClick={...}>
        <td>Value</td>
      </tr>
    </tbody>
  </table>
</div>
```
- `th`: cream background, 12px bold muted `--font-condensed`, 2px bottom border
- `td`: 14px body text, 1px row dividers, no bottom border on last row
- Row hover: `--cream`; clickable row hover: `--clay`

### Modal
```jsx
<div className="modal-overlay">
  <div className="modal">
    <h2>Modal Title</h2>
    {/* content */}
    <div className="modal-actions">
      <button className="btn btn-secondary">Cancel</button>
      <button className="btn btn-primary">Confirm</button>
    </div>
  </div>
</div>
```
- Overlay: `rgba(0,30,55,0.55)` + `backdrop-filter: blur(2px)`
- Modal: max-width 580px, 90% width, max-height 80vh, scrollable
- Actions: flex row, right-aligned, Cancel before Confirm

### Detail Panel
```jsx
<div className="detail-panel">
  <h2>Entity Name</h2>
  <div className="detail-row">
    <span className="detail-label">Field</span>
    <span className="detail-value">Value</span>
  </div>
</div>
```
- Label column fixed at 148px
- Rows separated by 1px border, last row has none

### Status Notes
```jsx
<div className="status-note status-note-success">Schedule exported — 42 games across 6 fields.</div>
<div className="status-note status-note-error">Availability hasn't been computed yet — run the ETL step first.</div>
```

### Loading & Empty States
```jsx
<div className="loading">Building lineups…</div>
<div className="empty-state">No games scheduled yet. Build your first showcase.</div>
```
Both: centered, 48px padding, `--text-muted`, 14px. Copy follows §1 rules —
active and specific, never a bare `Loading...` or apologetic dead-end.

### Progress Bar
```jsx
<div className="progress-bar-wrap">
  <div className="progress-bar-fill" style={{ width: '60%', background: 'var(--navy-600)' }} />
</div>
```

---

## 8. Sidebar

- Dark navy gradient (`--navy-900` → `--navy-800`)
- Brand block at top: logo + app name, separated from nav by 2px `--red` bottom border
- Logo: white background pill, 58×58px, `border-radius: 14px`
- App title: display font, 22px, weight 800, white
- Event/year label: mono font, 10px, `--red` color
- Nav links: 14px body font, 600 weight, left 3px border indicator
  - Default: `rgba(255,255,255,0.52)`
  - Hover: `rgba(255,255,255,0.88)` + dim red left border
  - Active: `--red` text + `--red` left border + `--red-dim` background
- Section labels within nav: 11px uppercase, letter-spacing 0.12em, `rgba(255,255,255,0.58)`
- Sign out button pinned to bottom: `.btn.btn-secondary` full-width

---

## 9. Page Background

Layered gradient — two radial glows (brand red top-left, brand navy top-right)
over a light linear gradient:

```css
background:
  radial-gradient(circle at top left, rgba(186,12,47,0.10), transparent 26%),
  radial-gradient(circle at top right, rgba(0,48,87,0.12), transparent 30%),
  linear-gradient(180deg, #F8FBFF 0%, #F1F6FB 100%);
```

---

## 10. Responsive Breakpoints

| Breakpoint | Behavior |
|---|---|
| `≤ 1080px` | Builder grids collapse to single column |
| `≤ 900px` | Sidebar goes static full-width (stacks above content), main content loses left margin |

---

## 11. Logo & Asset Usage

- Always give the logo clear space and a clean background — the white logo pill
  in the sidebar is the reference treatment.
- Never recolor the logo into off-brand hues, stretch it, or place it on a
  low-contrast background.
- On dark navy, use the white/knockout logo; on light surfaces, use the full-color
  or navy logo.

---

## 12. Design Principles

1. **Show Greatness in the details.** Alignment, spacing, and copy are never
   sloppy. The little things are done the best way, not just the right way.
2. **Navy + Red is the identity.** Every page carries the true brand palette
   (`#003057` / `#BA0C2F`). Secondary sport colors are accents only.
3. **Data-dense but readable.** Establish priority with font size and weight
   (not decorative color). Tables and grids stay compact.
4. **No third-party component library.** All components are plain CSS classes on
   semantic HTML. Keep it that way.
5. **Semantic color only for state.** Success/warning/danger/info are reserved
   for status — and brand red is not an error color.
6. **Confident, direct copy.** Every label and message follows the voice rules
   in §1. Say it clearly, say it once.
7. **Subtle transitions.** `0.15s all` / `0.15s ease` for interactive states. No
   bouncy or slow animations.
8. **Consistent 8px rhythm.** Multiples of 8 (8, 16, 24, 32) for layout; 4–6px
   for tight component internals.

---

## 13. Migration Notes (from the legacy guide)

Apply these when updating an existing app to this system:

| Legacy | New | Action |
|---|---|---|
| `--gold` = `#C91F3A` (red) | `--red` = `#BA0C2F` | Rename var to `--red`; keep `--gold` alias temporarily to avoid breakage, then remove. |
| — (no real gold) | `--gold` = `#FFB81C` | New: the actual brand gold, for sport accents only. |
| Navy `#163F63` / `#102B45` | `#003057` / `#001E37` | Update navy ramp to true PMS 540 values. |
| `--gold-dim` | `--red-dim` | Rename; value updated to red-based `rgba(186,12,47,0.12)`. |
| Plus Jakarta Sans + Source Sans 3 | Gotham / Montserrat | Swap font stack; bump display weights to 800. |
| Shadow tint `rgba(14,23,32,…)` | `rgba(0,30,55,…)` | Re-tint elevation to brand navy. |

Do the color-variable rename with a global search so no component keeps a raw
legacy hex. Nothing in components should reference a hex directly — only vars.

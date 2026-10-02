# Triple Crown Sports — UI Style Guide

**Aesthetic:** Ballpark Scoreboard  
**Stack:** React 18 + plain CSS custom properties (no UI library)

---

## 1. Color Palette

All colors are defined as CSS custom properties on `:root`. Never use raw hex values in components — always reference the variable.

### Brand (Navy)
| Variable | Value | Use |
|---|---|---|
| `--navy-900` | `#102B45` | Sidebar background (top) |
| `--navy-800` | `#163F63` | Sidebar background (bottom), headings, primary button |
| `--navy-700` | `#21557F` | Primary button hover |
| `--navy-600` | `#2E6D9C` | Input focus ring, stat card top border |

### Accent (Red)
| Variable | Value | Use |
|---|---|---|
| `--gold` | `#C91F3A` | Active nav item, sidebar year label, accent borders |
| `--gold-dim` | `rgba(201,31,58,0.14)` | Active nav background |

> Note: The variable is named `--gold` for historical reasons but the actual color is Triple Crown red `#C91F3A`.

### Surface
| Variable | Value | Use |
|---|---|---|
| `--cream` | `#F5F8FC` | Table header background, input hover |
| `--clay` | `#E7EDF4` | Clickable row hover |
| `--white` | `#FFFFFF` | Card, modal, input backgrounds |

### Text
| Variable | Value | Use |
|---|---|---|
| `--text-primary` | `#14324D` | Body text, table cells |
| `--text-secondary` | `#4D6275` | Helper text, secondary labels |
| `--text-muted` | `#708396` | Table headers, form labels, empty states |

### Borders
| Variable | Value | Use |
|---|---|---|
| `--border` | `#D6E0EA` | Cards, table rows, inputs |
| `--border-strong` | `#BECBD8` | Secondary button border, strong dividers |

### Semantic
| State | Background | Text | Border/Icon |
|---|---|---|---|
| Success | `--success-bg` `#DCFCE7` | `--success-text` `#14532D` | `--success` `#166534` |
| Warning | `--warning-bg` `#FEF3C7` | `--warning-text` `#78350F` | `--warning` `#92400E` |
| Danger | `--danger-bg` `#FEF2F2` | `--danger-text` `#7F1D1D` | `--danger` `#991B1B` |
| Info | `--info-bg` `#E0F2FE` | `--info-text` `#0C4A6E` | `--info` `#075985` |

---

## 2. Typography

Three font families. Import from Google Fonts.

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@700;800&family=Source+Sans+3:wght@400;600;700&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
```

| Variable | Family | Use |
|---|---|---|
| `--font-display` | Plus Jakarta Sans | Page titles, card headings, stat values, nav labels |
| `--font-body` | Source Sans 3 | Body text, buttons, form labels, table cells |
| `--font-mono` | JetBrains Mono | Data values, availability grids, sidebar year label |

### Type Scale
| Element | Font | Size | Weight | Letter-spacing |
|---|---|---|---|---|
| Page `h1` | display | 32px | 700 | -0.03em |
| Card `h2` | display | 18px | 700 | -0.01em |
| Modal `h2` | display | 20px | 800 | -0.01em |
| Stat value | display | 40px | 700 | -0.01em |
| Body | body | 15px | 400 | — |
| Table cell | body | 14px | 400 | — |
| Table header | body | 12px | 700 | 0.01em |
| Form label | body | 12px | 700 | 0.01em |
| Button | body | 13px | 700 | 0.01em |
| Badge | body | 11px | 700 | 0.01em |

---

## 3. Spacing & Radii

| Variable | Value | Use |
|---|---|---|
| `--radius-sm` | 4px | Badges, phase labels |
| `--radius` | 7px | Buttons, inputs |
| `--radius-lg` | 12px | Cards, modals, detail panels |

Standard spacing rhythm: **8px base unit**. Common values: 8, 10, 12, 14, 16, 20, 24, 28, 32.

---

## 4. Shadows

| Variable | Value | Use |
|---|---|---|
| `--shadow-sm` | `0 1px 3px rgba(14,23,32,0.07), 0 1px 2px rgba(14,23,32,0.04)` | Cards, stat cards |
| `--shadow-md` | `0 4px 10px rgba(14,23,32,0.09), 0 2px 4px rgba(14,23,32,0.05)` | Modals, dropdowns |

---

## 5. Layout

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

## 6. Components

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
- Value uses `--font-display` at 40px

### Buttons

Four variants, one size modifier:

```jsx
<button className="btn btn-primary">Primary</button>
<button className="btn btn-secondary">Secondary</button>
<button className="btn btn-success">Success</button>
<button className="btn btn-danger">Danger</button>

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
- Disabled: `opacity: 0.45`
- Transition: `all 0.15s`

### Badges
```jsx
<span className="badge badge-success">Active</span>
<span className="badge badge-warning">Pending</span>
<span className="badge badge-danger">Error</span>
<span className="badge badge-info">Info</span>
```
Inline label, `--radius-sm`, 11px bold text.

### Pill
```jsx
<span className="pill">Tag</span>
```
Rounded-full, navy tint background, 11px bold navy text. For compact metadata tags.

### Forms

```jsx
<div className="form-group">
  <label>Field Label</label>
  <input type="text" />
</div>
```

- Label: 12px, 700 weight, `--text-muted`, uppercase tracking
- Input: `--border`, `--radius`, 14px body font
- Focus: `--navy-600` border + `rgba(37,53,88,0.12)` ring

**Filters row** (above tables):
```jsx
<div className="filters">
  <input type="text" placeholder="Search..." />
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

- `th`: cream background, 12px bold muted text, 2px bottom border
- `td`: 14px body text, 1px row dividers, no bottom border on last row
- Row hover: `--cream` background
- Clickable row hover: `--clay` background

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

- Overlay: `rgba(14,23,32,0.65)` + `backdrop-filter: blur(2px)`
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
<div className="status-note status-note-success">Operation completed.</div>
<div className="status-note status-note-error">Something went wrong.</div>
```

### Loading & Empty States
```jsx
<div className="loading">Loading...</div>
<div className="empty-state">No results found.</div>
```
Both: centered, 48px padding, `--text-muted`, 14px.

### Progress Bar
```jsx
<div className="progress-bar-wrap">
  <div className="progress-bar-fill" style={{ width: '60%', background: 'var(--navy-600)' }} />
</div>
```

---

## 7. Sidebar

- Dark navy gradient (`--navy-900` → `--navy-800`)
- Brand block at top: logo + app name, separated from nav by 2px `--gold` bottom border
- Logo: white background pill, 58×58px, `border-radius: 14px`
- App title: display font, 22px, white
- Year/event label: mono font, 10px, `--gold` color
- Nav links: 14px body font, 600 weight, left 3px border indicator
  - Default: `rgba(255,255,255,0.52)`
  - Hover: `rgba(255,255,255,0.88)` + dim red left border
  - Active: `--gold` text + `--gold` left border + dim red background
- Section labels within nav: 11px uppercase, letter-spacing 0.12em, `rgba(255,255,255,0.58)`
- Sign out button pinned to bottom: `.btn.btn-secondary` full-width

---

## 8. Page Background

The body uses a layered gradient — two radial glows (red top-left, blue top-right) over a light linear gradient:

```css
background:
  radial-gradient(circle at top left, rgba(201,31,58,0.10), transparent 26%),
  radial-gradient(circle at top right, rgba(22,63,99,0.12), transparent 30%),
  linear-gradient(180deg, #F8FBFF 0%, #F1F6FB 100%);
```

---

## 9. Responsive Breakpoints

| Breakpoint | Behavior |
|---|---|
| `≤ 1080px` | Builder grids collapse to single column |
| `≤ 900px` | Sidebar goes static full-width (stacks above content), main content loses left margin |

---

## 10. Design Principles

1. **Data-dense but readable.** Tables and grids are compact; use font size and weight hierarchy (not color) to establish priority.
2. **Navy/red brand identity.** Every page carries the Triple Crown palette. Avoid introducing off-brand accent colors.
3. **No third-party component library.** All components are plain CSS classes on semantic HTML. Keep it that way.
4. **Semantic color only for state.** Success/warning/danger/info colors are reserved for status indicators — never use them as decorative accents.
5. **Transitions should be subtle.** `0.15s all` or `0.15s ease` for interactive states. No bouncy or slow animations.
6. **Consistent spacing rhythm.** Stick to multiples of 8px (8, 16, 24, 32) for layout spacing; 4–6px for tight component internals.

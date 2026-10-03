# FREE Design System

## 1. Atmosphere & Identity

FREE feels like a quiet research desk: paper-forward, compact, and evidence-minded. The signature is warm document surfaces paired with restrained terracotta accents, so the source document remains the primary visual object.

## 2. Color

### Palette

| Role | Token | Light | Dark | Usage |
|------|-------|-------|------|-------|
| Canvas | `--color-canvas` | `#faf6f2` | n/a | App backdrop and source document area |
| Surface | `--color-surface` | `#ffffff` | n/a | Sidebars, toolbar, panels |
| Surface muted | `--color-surface-muted` | `#f5efe9` | n/a | Pills and subtle fills |
| Ink | `--color-ink` | `#33302c` | n/a | Primary text |
| Ink muted | `--color-ink-muted` | `#6c6259` | n/a | Secondary text |
| Ink faint | `--color-ink-faint` | `#776b60` | n/a | Tertiary labels |
| Line | `--color-line` | `#eadfd6` | n/a | Hairline borders |
| Line strong | `--color-line-strong` | `#d9cabc` | n/a | Emphasised borders |
| Accent | `--color-accent` | `#a34828` | n/a | Brand, the active tab, selection and drag states, focus |
| Accent soft | `--color-accent-soft` | `#f4ddd3` | n/a | Accent fills |
| Accent ghost | `--color-accent-ghost` | `#fbf1ec` | n/a | Hover wash |
| Evidence | `--color-ev` | `#4f8aa8` | n/a | Evidence-related marks only |
| Success | `--color-green` | `#3e7c4f` | n/a | Positive commands (run, apply, accept, save, finalize) and success state |
| Warning | `--color-stale` | `#c98a2b` | n/a | Stale state |
| Error | `--color-danger` | `#b3402a` | n/a | Destructive commands (delete a field, clear the schema, discard a proposal, cancel) and errors |

### Rules

- Terracotta (accent) marks brand, the active tab, selection and drag states, and focus.
- Green (`--color-green`) fills positive commands: run, apply, accept, save, finalize.
- Red (`--color-danger`) fills destructive commands: delete a field, clear the schema, discard a proposal, cancel.
- Every coloured action keeps an icon or a label; colour is never the only signal.
- Preserve the warm paper palette; avoid decorative gradients.
- Do not introduce raw colors outside this file and `index.css`.

## 3. Typography

### Scale

| Level | Size | Weight | Line Height | Tracking | Usage |
|-------|------|--------|-------------|----------|-------|
| App title | 17px | 800 | 1.2 | 0.06em | FREE wordmark |
| Panel body | 13px | 400-700 | 1.5 | 0 | Side panels |
| Secondary | 12px | 400-600 | 1.5 | 0 | Hints and metadata |
| Compact | 11px | 500-700 | 1.3 | 0 | Pills, buttons, dense controls |
| Overline | 10.5px | 700 | 1.3 | 0.12em | Panel labels |
| Code | 11-12.5px | 400-600 | 1.6 | 0 | JSON and field names |

In the right rail only four sizes are used, as the tokens `--text-content` (13), `--text-secondary` (12), `--text-compact` (11) and `--text-overline` (10.5) in `index.css`.

### Font Stack

- Primary: `Albert Sans`, system sans.
- Serif: `Source Serif 4`, Georgia, for document-adjacent flourishes only.
- Mono: `IBM Plex Mono`, system mono.

### Rules

- Keep panel typography compact and scannable.
- Use mono for schema fields, JSON, and machine-readable values.

## 4. Spacing & Layout

### Base Unit

All spacing derives from 4px. Existing Tailwind arbitrary values such as `px-3.25` map to the same base grid.

| Token | Value | Usage |
|-------|-------|-------|
| `--space-1` | 4px | Tight inline gaps |
| `--space-2` | 8px | Dense controls |
| `--space-3` | 12px | Default row padding |
| `--space-4` | 16px | Panel padding |
| `--space-6` | 24px | Empty states |
| `--space-8` | 32px | Source document vertical padding |

### Grid

- Layout is a three-pane work surface: project nav, source document, right rail.
- Right rail remains dense and resizable; avoid landing-page spacing.

### Rules

- Keep fixed-format controls stable with explicit min widths or flex shrink rules.
- Avoid nested page-section cards; cards are for repeated values and error blocks.

## 5. Components

### Segmented Control
- **Structure**: bordered flex group with button segments.
- **Variants**: active uses `bg-ink text-canvas`; inactive uses surface and muted ink.
- **States**: hover, focus-visible, `aria-pressed`.

### Action Button
- **Structure**: compact rounded button with border.
- **Variants**: green positive, danger, surface secondary, rounded pill; disabled is a line fill.
- **States**: hover brightness or color shift, global dual-color focus indicator.
- One filled primary per screen. The tab strip's "▶ Run extraction" is positive; while a run is active it reads "■ Stop extraction" in danger, and stays danger (disabled) once its cancellation is requested.

### Result Card
- **Structure**: shallow bordered section using `bg-surface` or `bg-canvas`.
- **Variants**: object section, array item, missing primitive.
- **States**: expandable where content can be long.

### Toast
- Toast — message plus one optional action; float shadow; eight seconds when an action is offered, 2.6 s otherwise. Its timer holds while it is hovered or has focus within, so a researcher reaching its action does not lose it.

### Field Row
- Field row — 30px at rest when its pills fit beside the name: grip, disclosure, mono name (never truncated by its metadata: the type and values pills wrap under it when the line is too narrow), then the worded actions "Edit", "Note" and "Delete" (11px semibold, 28px tall, 4px apart, Delete in danger; no tooltips, their accessible names say which field) as an overlay of at least 140px (wider only when a fallback font or a larger text size needs it, then reaching past the pills' 140px reserve) on the right end of the first line, shown on hover and focus-within and stepping aside while a pill has keyboard focus. Hidden, the overlay takes no pointer hits.
- No pill sits under the actions, so a pointer on a pill always reaches it; only the name may run under them (its full text is its title). On a row line of 296px and more the pills' line keeps the 140px clear (at 344px the top level keeps 123px: `title · string` stays on one 30px line, a values pill usually wraps). A narrower row (the 264px rail, nested rows) starts its pills on the line below the name at full width, so they are never squeezed under their own width.
- A field's note starts where its name starts (46px: the 14px grip, 4px, the 24px disclosure, 4px).
- The row itself (not the slot above it or its children) is the drop target for "into <group>".

## 6. Motion & Interaction

| Type | Duration | Easing | Usage |
|------|----------|--------|-------|
| Micro | 150-200ms | ease | Button and hover transitions |
| Spinner | 800ms | linear | Running states |
| Entry | 200ms | ease | Toast and chat message entry |

### Rules

- Animate only `transform` and `opacity`.
- Every interactive element needs hover and focus-visible treatment.

## 7. Depth & Surface

### Strategy

Mixed but restrained: borders define panes and cards; shadows are reserved for floating overlays, PDF pages, and toasts.

| Level | Token | Usage |
|-------|-------|-------|
| Page | `--shadow-page` | Rendered source document pages |
| Float | `--shadow-float` | Toasts and modal-like overlays |

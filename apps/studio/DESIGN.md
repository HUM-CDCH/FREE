# FREE Design System

## 1. Atmosphere & Identity

FREE feels like a quiet research desk: paper-forward, compact, and evidence-minded. The signature is warm document surfaces paired with restrained terracotta accents, so the source document remains the primary visual object.

## 2. Color

### Palette

| Role | Token | Value | Usage |
|------|-------|-------|-------|
| Canvas | `--color-canvas` | `#faf6f2` | App backdrop and source document area |
| Surface | `--color-surface` | `#ffffff` | Sidebars, toolbar, panels |
| Surface muted | `--color-surface-muted` | `#f5efe9` | Pills and subtle fills |
| Ink | `--color-ink` | `#33302c` | Primary text |
| Ink muted | `--color-ink-muted` | `#6c6259` | Secondary text |
| Ink faint | `--color-ink-faint` | `#776b60` | Tertiary labels |
| Line | `--color-line` | `#eadfd6` | Hairline borders |
| Line strong | `--color-line-strong` | `#d9cabc` | Emphasised borders |
| Accent | `--color-accent` | `#a34828` | Brand, the active tab, selection and drag states, focus |
| Accent soft | `--color-accent-soft` | `#f4ddd3` | Accent fills |
| Accent ghost | `--color-accent-ghost` | `#fbf1ec` | Hover wash |
| Evidence | `--color-ev` | `#4f8aa8` | Evidence-related marks only |
| Success | `--color-green` | `#3e7c4f` | Positive commands (run, apply, accept, save, finalize) and success state |
| Warning | `--color-stale` | `#b8860b` | Stale state (golden amber, held off the terracotta hue) |
| Error | `--color-danger` | `#9e2b33` | Destructive commands (delete a field, clear the schema, discard a proposal, cancel) and errors |

`index.css` holds the full token set, including the `-soft` and `-ghost` tints, `--color-stale-ink`, `--radius-card` and `--shadow-lift`.

### Rules

- Terracotta (accent) is a **rest** colour: brand, the active tab, the selected or current item, drag, and focus. It is never a hover-only transition on an otherwise-neutral control.
- Neutral controls rest in ink/line and hover to ink (`text-ink`, `bg-surface-muted`, `border-line-strong`) — a muted button, tab, icon button, menu item or text action never turns terracotta on hover. Selectable rows keep the faint `accent-ghost` wash that previews their selected state.
- Green (`--color-green`) fills positive and commit commands: run, apply, accept, save, finalize, create, add. An inline confirm/save icon button takes green, not terracotta.
- Red (`--color-danger`) fills destructive commands: delete a field, clear the schema, discard a proposal, cancel. It is deeper and cooler than the terracotta accent so the two never read as one colour.
- Amber (`--color-stale`) is a distinct golden hue from the terracotta accent, so "stale / re-run" and "brand / current" never blur together.
- Every coloured action keeps an icon or a label; colour is never the only signal.
- Preserve the warm paper palette; avoid decorative gradients.
- Do not introduce raw colors outside this file and `index.css`.

## 3. Typography

### Scale

| Level | Size | Weight | Line Height | Tracking | Usage |
|-------|------|--------|-------------|----------|-------|
| Panel body | 13px | 400-700 | 1.5 | 0 | Side panels |
| Secondary | 12px | 400-600 | 1.5 | 0 | Hints and metadata |
| Compact | 11px | 500-700 | 1.3 | 0 | Pills, buttons, dense controls |
| Overline | 10.5px | 700 | 1.3 | 0.12em | Panel labels |
| Code | 11-12.5px | 400-600 | 1.6 | 0 | JSON and field names |

In the right rail only four sizes are used, as the tokens `--text-content` (13), `--text-secondary` (12), `--text-compact` (11) and `--text-overline` (10.5) in `index.css`, plus one display size, `--text-display` (20px, weight 700, line-height 1.25), for the To check count and the one-by-one value.

### Font Stack

- Primary: `Albert Sans`, system sans.
- Serif: `Source Serif 4`, Georgia, for document-adjacent flourishes only.
- Mono: `IBM Plex Mono`, system mono.

### Rules

- Keep panel typography compact and scannable.
- Use mono for schema fields, JSON, and machine-readable values.

## 4. Spacing & Layout

### Base Unit

Spacing uses Tailwind's default scale, in steps of 0.25rem (4px); FREE defines no spacing tokens of its own.

### Grid

- Layout is a three-pane work surface: project nav, source document, right rail.
- Right rail remains dense and resizable; avoid landing-page spacing.

### Rules

- Keep fixed-format controls stable with explicit min widths or flex shrink rules.
- Avoid nested page-section cards; cards are for repeated values and error blocks.

## 5. Components

The shared primitives are exported from [`src/ui/index.ts`](src/ui/index.ts).

### Segmented Control
- **Structure**: bordered flex group with button segments.
- **Variants**: active uses `bg-ink text-canvas`; inactive uses surface and muted ink.
- **States**: hover, focus-visible, `aria-pressed`.

### Action Button
- **Structure**: compact rounded button with border.
- **Variants**: green positive, danger, surface secondary, rounded pill; `outline-positive` (green text and icon, `border-green/40`, `--color-green-soft` on hover) and `outline-danger` (the same in danger) for the rail's positive and destructive actions; `ghost` (muted text, no border, surface-muted on hover) for quiet text actions; disabled is a line fill. Secondary and pill hover to ink on `line-strong`/`surface-muted`, never to terracotta; only their focus ring is terracotta.
- **States**: hover brightness or color shift, global dual-color focus indicator.
- One filled primary per screen. The tab strip's "▶ Run extraction" is positive. While the latest Extraction can still continue, it gives way to "❚❚ Pause extraction" (secondary), "▶ Resume extraction" or "↻ Retry extraction" (positive), or a disabled "Pausing…" or "Stopping…", with an outline-danger "■ Stop" beside it until stopping begins.

### Results rail
- One header in both phases: the status line (a mark, a bold word, a muted rest, then ⓘ Run details and ⋯ More result actions), the count block (the To check count at the display size, the review bar, "One by one" and "Save review" ("List" in one-by-one), the breakdown line) and the filter chips (To check · Doubtful · Not reviewable · All; a labelled select at 264px).
- The list of records with flat value rows (glyph · name over value · chip); the selected row's expansion is one tinted surface with a 2px accent edge, no inner card, with one joined Approve | Edit | Reject group. Colour is never the only signal: every state has a glyph and a text equivalent.
- One by one is the same rail as a card for one value: its record's queue, its Evidence, 44px actions with their keys, Up next. The rail's own toast docks at its bottom; the Run details drawer covers the rail.
- While an Extraction runs, the list shows the records in the order the Parsing Service reads them under "Reading records · k of n"; a record read is reviewable at once; at settlement the list keeps its place. The Results tab's badge names the run's status; Run, Pause, Resume and Retry share one fixed width and carry no count, and Stop sits beside them.
- Evidence marks on the page use the one Evidence colour: dotted for a rule link, dashed for a doubtful one, a 1px border once decided, an accent outline when selected.

### Toast
- Toast — message plus one optional action; float shadow; 8 s when an action is offered, 6 s for some run errors and notices, 2.6 s otherwise. Its timer holds while it is hovered or has focus within, so a researcher reaching its action does not lose it.

### Field Row
- Field row — grip, disclosure, mono name (never truncated by its metadata: the type and values pills wrap under it when the line is too narrow), then the worded actions "Edit", "Note" and "Delete" (Delete in danger; no tooltips, their accessible names say which field) as an overlay on the right end of the first line, shown on hover and focus-within and stepping aside while a pill has keyboard focus. Hidden, the overlay takes no pointer hits.
- No pill sits under the actions, so a pointer on a pill always reaches it; only the name may run under them (its full text is its title). A narrow row starts its pills on the line below the name, so they are never squeezed under their own width; at the narrowest (every row at the 264px rail) the actions take their own line below the pills, kept at rest so no row moves under a click. `src/FieldRow.tsx` holds the widths and breakpoints.
- A field's note starts where its name starts.
- The row itself (not the slot above it or its children) is the drop target for "into <group>".

## 6. Motion & Interaction

| Type | Duration | Easing | Usage |
|------|----------|--------|-------|
| Micro | 150-200ms | ease | Button and hover transitions |
| Spinner | 800ms | linear | Running states |
| Entry | 200ms | ease | Toast, review row and sign-in card entry |

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

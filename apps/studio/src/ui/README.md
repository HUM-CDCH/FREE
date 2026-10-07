# FREE UI

Presentational primitives for the FREE studio, decoupled from PDF.js and app
state — they import only React and the shared Tailwind tokens (`src/index.css`).

## Components

| Component | Purpose |
|-----------|---------|
| `Button` | `positive` (green, positive/commit) / `danger` / `secondary` (outline) / `pill` actions; secondary and pill hover neutral, never terracotta |
| `Pill` | Rounded chip with `neutral`/`accent`/`evidence`/`success`/`stale`/`danger` tones, an optional `outline`, and `size` `overline` (default, 10.5px semibold) or `compact` (11px medium) |
| `SegmentedControl` | Single-select segmented toggle |
| `EmptyState` | Dashed placeholder card (`neutral`/`danger`) with optional action |
| `Spinner` | Loading ring, optionally with label + hint |
| `Toast` | Transient `role="status"` notice with one optional action (e.g. Undo) |
| `ModalDialog` | Native modal dialog: Tab containment, one dismissal path, focus returned to its opener |
| `DeleteDialog` | Labelled `ModalDialog` that confirms a permanent deletion, never on one click |
| `Overline` | Uppercase, letter-spaced section label |
| `PhaseProgress` | Five-segment workflow position bar with a small state line |
| `Panel` | Full-height column with bordered header/footer + scrolling body |
| `ResultValue` | Recursive renderer for an extraction result tree |

## Library build

```bash
pnpm build:lib   # → dist-lib/free-ui.js + dist-lib/free-ui.css
```

`dist-lib/` is the consumable design-system artifact (ES bundle + a
Tailwind-compiled stylesheet carrying the palette). React is externalized.

The workspace consumes `Button`, `Pill`, `SegmentedControl`, `EmptyState`, `ModalDialog`, `Toast` and `ResultValue`; the remaining inline patterns live in the project pages.

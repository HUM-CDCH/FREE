# FREE UI — building with these components

FREE is a document-extraction tool for humanities researchers. The look is a
quiet research desk: warm paper surfaces, restrained terracotta actions, compact
type. Build on-brand by composing these components and using the brand tokens
below for your own layout glue.

## Setup

No provider or theme wrapper is required — these are presentational primitives.
They only need the design system's stylesheet loaded (it ships the tokens, the
`@font-face` brand fonts, and the component styles). Components are React
function components; import them from the bundle global `window.FreeUI` (e.g.
`window.FreeUI.Button`).

## Styling idiom: props first, tokens for glue

Style the components through their **props**, not by inventing CSS classes:

- `Button` — `variant="primary" | "secondary" | "pill"`, `size="sm" | "md"`
- `Pill` — `tone="neutral" | "accent" | "evidence" | "success" | "stale"`, `outline`
- `EmptyState` — `tone="neutral" | "danger"`, `icon`, `title`, `description`
- `SegmentedControl` — `options`, `value`, `onChange` (single-select toggle)
- `Spinner` — `label`, `hint` (loading); `Overline` — uppercase section label
- `Panel` — `header` / `footer` slots + scrolling body
- `ResultValue` — recursive renderer for an extraction-result tree

For the layout **around** components, use the brand tokens (CSS custom
properties, available globally from the stylesheet) so your own markup matches:

| Token | Use |
|---|---|
| `--color-canvas` `--color-surface` `--color-surface-muted` | backdrops, panels, subtle fills |
| `--color-ink` `--color-ink-muted` `--color-ink-faint` | primary / secondary / tertiary text |
| `--color-line` `--color-line-strong` | hairline / emphasised borders |
| `--color-accent` `--color-accent-soft` `--color-accent-ghost` | terracotta actions, focus, hover wash |
| `--color-ev` `--color-ev-soft` | evidence marks only |
| `--color-green` `--color-green-soft` `--color-stale` `--color-stale-soft` `--color-stale-ink` `--color-danger` | success / stale / error states (note: `danger` has no `-soft`) |
| `--font-sans` (Albert Sans) `--font-serif` (Source Serif 4) `--font-mono` (IBM Plex Mono) | body / quotes / field names + JSON |

Rules: accent only for commands, focus, and active states. Field names, schema
keys, and JSON use `--font-mono`. Quoted source passages use `--font-serif`
italic. Keep the warm paper palette; no decorative gradients.

## Where the truth lives

Read the bound stylesheet (`styles.css` and its `@import` closure, incl.
`_ds_bundle.css`) for the exact tokens and component CSS, and each component's
`<Name>.prompt.md` / `<Name>.d.ts` for its full prop contract.

## Example

```jsx
const { Panel, Overline, Pill, Button } = window.FreeUI
<div style={{ height: 360, background: 'var(--color-surface)',
              border: '1px solid var(--color-line)', borderRadius: 12, overflow: 'hidden' }}>
  <Panel
    header={<><Overline as="h2">Extraction Schema</Overline><Pill tone="accent">4 fields</Pill></>}
    footer={<Button variant="pill">Regenerate</Button>}
  >
    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--color-ink)' }}>
      site_name <Pill tone="neutral">string</Pill>
    </div>
  </Panel>
</div>
```

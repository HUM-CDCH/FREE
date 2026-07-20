## Context

Evidence highlights are derived from the extraction result and painted over PDF.js pages. The implementation now carries a result path for every scalar, caches located rectangles, and repaints from that cache when selection changes. The previous main spec still described raw-value selection and intentionally painting the active rectangle twice.

## Goals / Non-Goals

**Goals:**

- Make duplicate scalar values independently selectable.
- Define one deterministic paint per cached rectangle.
- Preserve evidence snippet and page-hint lookup with direct value search as fallback.
- Keep the existing schema-derived palette and PDF coordinate corrections.

**Non-Goals:**

- Changing extraction response shapes.
- Adding a new evidence-generation request.
- Changing PDF.js rendering or the highlight palette.

## Decisions

### Use result paths as identity

Every highlight carries its `string[]` path from the extraction root. Result rows report both path and display value, and the clear action sets the focused path to `null`. Paths distinguish duplicate values without inventing IDs or coupling selection to display text.

### Paint cached entries exactly once

A pure paint helper chooses alpha from path equality and fills each cached rectangle once. Normal, selected, and dimmed alpha values are `0.4`, `0.75`, and `0.15`. This makes opacity testable and avoids the text-obscuring double paint.

### Prefer evidence metadata, retain direct-search fallback

`_evidence` snippets and page numbers guide text lookup when present. The extracted scalar remains the highlighted value, and direct text search remains available when usable evidence metadata is absent.

## Risks / Trade-offs

- **A result path can become stale if the displayed result is replaced** → extraction replacement clears selection and rebuilds cached entries.
- **Evidence snippets can match multiple locations** → page hints are searched first and the existing text-matching fallback remains deterministic.

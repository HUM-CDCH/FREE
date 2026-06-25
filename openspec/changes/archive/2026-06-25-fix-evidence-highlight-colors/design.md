## Context

`EvidenceHighlightLayer` was assigning colors via `buildTopLevelColorMap(schema)`, which mapped schema keys to palette slots. `buildHighlights` then looked up each result key in that map with `colorMap[key] ?? PALETTE[0]`.

The bug: in practice schema keys and result keys diverged — e.g. the model returned `{Graver: [...]}` (one key) while the schema might have different or more keys. Every result key missed the colorMap lookup and fell back to `PALETTE[0]` (yellow), making all highlights yellow.

## Goals / Non-Goals

**Goals:**

- Each top-level result key always gets a distinct palette color.
- Remove the schema dependency from the color assignment path entirely.

**Non-Goals:**

- Preserving schema-driven color stability across reruns.
- Per-field color customization.

## Decisions

**Remove colorMap entirely; assign colors by result key iteration index.**

`buildHighlights` now tracks `i` over `Object.entries(result)` and assigns `PALETTE[i % PALETTE.length]` directly — no `colorMap` parameter, no schema lookup.

`buildTopLevelColorMap` and the `schema` prop on `EvidenceHighlightLayer` were deleted.

Alternative considered: keep colorMap but build it from result keys instead of schema keys. Rejected as equivalent but more complex — iterating result keys twice for no benefit.

## Risks / Trade-offs

- Colors may shift between reruns if the model returns result keys in a different order. Acceptable — distinct colors are more important than stable colors.
- No migration needed.

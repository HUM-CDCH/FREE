## Context

`EvidenceHighlightLayer` currently uses a 3-entry `DEPTH_COLORS` map to color highlights: depth 0 → yellow, depth 1 → blue, depth 2 → green. All top-level fields share the same yellow, making it impossible to visually associate a highlight with a specific schema section.

## Goals / Non-Goals

**Goals:**
- Assign a distinct color to each top-level schema key, cycling a 4-color palette
- Keep adjacent keys visually distinct (guaranteed by the 4-slot cycle)

**Non-Goals:**
- Changing backend evidence generation
- Highlighting nested fields (no evidence data exists for them yet)
- More than 4 colors (intentionally limited to avoid visual clutter)

## Decisions

### Decision 1: 4-color fixed palette, cycled by key order

The palette has exactly 4 entries. Top-level keys are enumerated in schema key order; key k is assigned `PALETTE[k % 4]`. With 4 colors, no two adjacent keys ever share a color (since k and k+1 differ by 1, their indices mod 4 always differ).

### Decision 2: Replace `buildDepthMap` with `buildTopLevelColorMap`

The new function iterates only the top-level keys of the schema (skipping `_evidence`) and returns a `Record<string, string>` mapping each key to its palette color. Nested keys are not traversed — they are not needed since nested evidence does not yet exist.

`depthColor(fieldKey, depthMap)` → `topLevelColor(fieldKey, colorMap)`: a direct lookup with a fallback to `PALETTE[0]`.

### Decision 3: `buildDepthMap` is removed, not kept alongside

The old depth-based logic served no purpose other than coloring. Keeping it would be dead code. If nested-field evidence is added later, the coloring rule ("inherit from top-level ancestor") is simple enough to implement at that point.

## Risks / Trade-offs

With 4 colors and a cycle, schemas with exactly 4k top-level keys will have the first and last key in the same color. This is acceptable — they are not adjacent in the result view so the visual distinction still holds.

## Context

SchemaPanel currently renders a read-only field tree (with delete). The component receives a `template` object and calls `onTemplateChange` to propagate edits. The design reference (Claude Design project `a4007f27`, file `Schema editing.dc.html`, option 2a "Unified") shows the target: a unified panel with drag handles, inline edit, and a chat panel at the bottom.

The existing template utilities (`patchTemplateField`, `addTemplateField`, `removeTemplateField`) operate on path-addressed nested objects. Drag-and-drop requires a mutable flat-ish node list for efficient reordering, so the component maintains an internal node representation and converts back to the template object on every change.

## Goals / Non-Goals

**Goals:**
- Drag-and-drop reorder within the same nesting level; drag to nest a leaf into a group; drag a child out to root
- Inline edit form for renaming and retyping any field
- Chat panel that accepts a free-form change description, calls `/api/edit_schema`, shows an inline structured diff, and lets the researcher apply or discard
- Auto-scroll while dragging near the container's top/bottom edge
- Visual drop slots (blue line between items) and "into [group]" badge
- Empty-group placeholder

**Non-Goals:**
- Undo/redo history
- Drag between different nesting levels deeper than one (child → grandchild) — too complex for v1; chat covers structural changes
- Real-time streaming for chat response
- Persistence of chat history across sessions

## Decisions

**D1: Canonical node tree, not duplicated template state**
The ready state owns a required `SchemaNode[]`. Recursive id-based helpers perform edits and drag moves at arbitrary depth. Display JSON and extraction records are derived from nodes only at their boundaries, while envelope metadata is stored separately so `schema.record` cannot drift from the editor tree.

*Alternative:* Keep the template as source of truth and derive rendering order from it. Rejected: would require Object.keys ordering guarantees and complex insertion logic.

**D2: Pure mouse events, no drag library**
The design prototype uses plain `mousedown / mousemove / mouseup` with a floating drag overlay. This keeps zero new dependencies. For the schema panel (typically 6–15 fields), the complexity is manageable. 
*Alternative:* `@dnd-kit`. More robust for keyboard accessibility and touch, but adds ~40 kB and API surface. Deferred to a later iteration.

**D3: Chat uses the dedicated `/api/edit_schema` operation endpoint**
The browser sends the current derived template and the researcher instruction. Ollama receives a hand-rendered NuExtract structured prompt over `/api/generate` with `raw: true`; generic providers use AI SDK structured array output. Both paths return the same runtime-validated operation contract and propagate cancellation.

**D4: Operations produce an inline tree diff**
The frontend applies proposed operations to a copy of the node tree. Added and removed nodes are merged into a preview; patches appear as one amber `modified` node. Apply commits the copy and Discard leaves canonical nodes unchanged.

**D5: Suggestion chips are static in v1**
Three pre-defined chips ("Add a field", "Remove a field", "Change a field type") populate the chat panel and fire real model calls. Free-text input is also wired to the model. This matches the design prototype's UX without requiring NLP intent parsing.

## Risks / Trade-offs

- **Schema drift**: Model operations may add or remove unexpected fields. The inline tree preview mitigates this by showing all changes before Apply.
- **Drag jank on slow machines**: Pure mouse events with `requestAnimationFrame` for auto-scroll could stutter on slow hardware. → Acceptable for the research prototype. Add passive event listeners and `will-change: transform` on the drag overlay.
- **Template conversion round-trip loss**: Converting `template → nodes → template` may reorder keys if `Object.entries` order differs across engines. → Modern JS engines preserve insertion order; this is a non-issue in V8/Safari.
- **Chat call latency**: NuExtract3 is slow (5–15 s). Researcher sees a spinner while waiting. → Show typing indicator; disable input during pending call.

## Migration Plan

The change adds `source: custom` and `basePinnedSchemaId` to ready-state provenance, an explicit Customize callback in `SchemaPanelProps`, and the `/api/edit_schema` model route. Pinned definitions stay immutable; Customize makes a detached ephemeral node copy while preserving the pinned extraction strategy. Document or pinned-schema selection resets that copy.

## Resolved Questions

- Suggestion chips trigger the real `/api/edit_schema` model call and disappear after use.
- Should drag-to-re-nest allow nesting a group inside another group? → No for v1 (groups cannot be nested into groups; the design shows this constraint).
- The editor exposes `verbatim-string`, `string`, `date`, `number`, `integer`, `boolean`, `object`, and `array`. Scalar-to-group creates an empty group. Manual group-to-scalar conversion confirms before dropping children; chat Apply/Discard is the operation confirmation boundary.

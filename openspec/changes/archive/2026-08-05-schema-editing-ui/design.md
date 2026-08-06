## Context

SchemaPanel currently renders a read-only field tree (with delete). The component receives a `template` object and calls `onTemplateChange` to propagate edits. The design reference (Claude Design project `a4007f27`, file `Schema editing.dc.html`, option 2a "Unified") shows the target: a unified panel with drag handles, inline edit, and a chat panel at the bottom.

The existing template utilities (`patchTemplateField`, `addTemplateField`, `removeTemplateField`) operate on path-addressed nested objects. Drag-and-drop requires a mutable flat-ish node list for efficient reordering, so the component maintains an internal node representation and converts back to the template object on every change.

## Goals / Non-Goals

**Goals:**
- Drag-and-drop reorder within the same nesting level; drag to nest a leaf into a group; drag a child out to root
- Inline edit form for renaming and retyping any field
- Chat panel that accepts a free-form change description, calls `/api/chat` (or `/api/generate_schema` with the current template as context), shows a structured diff card, lets the researcher apply or discard
- Auto-scroll while dragging near the container's top/bottom edge
- Visual drop slots (blue line between items) and "into [group]" badge
- Empty-group placeholder

**Non-Goals:**
- Undo/redo history
- Drag between different nesting levels deeper than one (child → grandchild) — too complex for v1; chat covers structural changes
- Real-time streaming for chat response
- Persistence of chat history across sessions

## Decisions

**D1: Internal node list, not path-based mutation during drag**
Path-based helpers work well for point edits (rename, delete) but are awkward for drag-and-drop where items move across parent boundaries. The component keeps `SchemaNode[]` as local state, converts to/from the template object. Conversion is cheap (the tree is never large).

*Alternative:* Keep the template as source of truth and derive rendering order from it. Rejected: would require Object.keys ordering guarantees and complex insertion logic.

**D2: Pure mouse events, no drag library**
The design prototype uses plain `mousedown / mousemove / mouseup` with a floating drag overlay. This keeps zero new dependencies. For the schema panel (typically 6–15 fields), the complexity is manageable. 
*Alternative:* `@dnd-kit`. More robust for keyboard accessibility and touch, but adds ~40 kB and API surface. Deferred to a later iteration.

**D3: Chat uses `/api/generate_schema` with existing template as a forced starting point, not a new endpoint**
The model already understands schema generation. Sending the current template as a "seed" with instruction "modify this template according to the following request" reuses existing infrastructure. The response is a new template; the component diffs old vs. new to produce the diff card lines.

*Alternative:* A dedicated `/api/chat` endpoint that outputs a JSON patch. Cleaner semantically but requires new backend work. Deferred.

**D4: Diff card is computed on the frontend**
After the model returns a new template, the frontend walks both old and new node lists to produce `{sign, text}` diff lines: `+` for added, `−` for removed, `~` for renamed/retyped. The researcher sees this before committing.

**D5: Suggestion chips are static in v1**
Three pre-defined chips ("Add a field", "Remove a field", "Change a field type") populate the chat panel and fire real model calls. Free-text input is also wired to the model. This matches the design prototype's UX without requiring NLP intent parsing.

## Risks / Trade-offs

- **Schema drift**: The model's "modified template" response may add or remove unexpected fields. The diff card mitigates this by making all changes visible before apply. → Researcher always reviews before committing.
- **Drag jank on slow machines**: Pure mouse events with `requestAnimationFrame` for auto-scroll could stutter on slow hardware. → Acceptable for the research prototype. Add passive event listeners and `will-change: transform` on the drag overlay.
- **Template conversion round-trip loss**: Converting `template → nodes → template` may reorder keys if `Object.entries` order differs across engines. → Modern JS engines preserve insertion order; this is a non-issue in V8/Safari.
- **Chat call latency**: NuExtract3 is slow (5–15 s). Researcher sees a spinner while waiting. → Show typing indicator; disable input during pending call.

## Migration Plan

SchemaPanel is a self-contained component. The change is:
1. Replace the file in-place; `SchemaPanelProps` interface stays the same.
2. No backend changes; no API migrations.
3. If the existing `template.ts` helpers are no longer used after the rewrite, remove them in a follow-up cleanup. They are not breaking to leave in place.

## Open Questions

- Should the chat suggestions trigger a real model call, or should they apply changes locally without AI (like the design prototype)? → Start with real model call; fall back to local for "Remove a field" (deterministic).
- Should drag-to-re-nest allow nesting a group inside another group? → No for v1 (groups cannot be nested into groups; the design shows this constraint).

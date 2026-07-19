## 1. Data types and diff computation

- [x] 1.1 Add `NodeDiffStatus = 'added' | 'removed' | 'modified'` and update `PendingChange` in `SchemaPanel.tsx`: replace `lines: DiffLine[]` with `displayNodes: SchemaNode[]` and `diffMap: Map<string, NodeDiffStatus>`
- [x] 1.2 Write `buildDiffPreview(oldNodes, newNodes): { displayNodes: SchemaNode[]; diffMap: Map<string, NodeDiffStatus> }` — builds `diffMap` by comparing id sets, then produces `displayNodes` by walking `newNodes` and reinjecting removed nodes at their original sibling index
- [x] 1.3 Replace the `computeDiff` call in `sendChatMessage` with `buildDiffPreview`; store the result in `setPending`
- [x] 1.4 Remove the now-unused `DiffLine` type and `computeDiff` function

## 2. Schema tree — inline diff rendering

- [x] 2.1 Add `--color-danger-soft: #fce8e4` to `src/index.css`
- [x] 2.2 In `renderRootField` and `renderChildField`, look up the node's id in `diffMap`; when a status is found, apply the row background (`bg-green-soft` / `bg-danger-soft` / `bg-stale-soft`) and text colour (`text-green` / `text-danger` / `text-stale-ink`)
- [x] 2.3 For `removed` nodes, add `line-through` to the name span
- [x] 2.4 When a node has any diff status, omit the drag handle, edit button, and remove button from the row
- [x] 2.5 Switch the schema tree to render `displayNodes` (instead of `nodes`) when `pending !== null`; on Apply/Discard, revert back to `nodes`

## 3. Apply / Discard action bar

- [x] 3.1 Remove the pending diff card `<div>` (the "Proposed changes" block with the `ul` of lines) from the chat scroll area
- [x] 3.2 Add a sticky action bar at the bottom of the chat column, rendered outside the scroll container, visible only when `pending !== null`; it contains the existing "Apply changes" and "Discard" buttons
- [x] 3.3 Update `applyPending` to use `pending.newNodes` (unchanged) and update the confirmation chat message to not reference `pending.lines.length` (use a generic "changes applied" message instead)

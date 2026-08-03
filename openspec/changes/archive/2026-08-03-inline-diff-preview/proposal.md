## Why

When a chat edit produces a pending change, the separate diff card is detached from the schema tree — researchers must cross-reference two areas to understand what will change. Marking nodes directly in the tree with colour makes the diff immediately legible in context.

## What Changes

- Remove the standalone "Proposed changes" diff card (the `ul` list inside the chat column)
- Annotate schema tree node rows with diff state: added nodes get a green background, removed nodes get a red background with strikethrough, modified nodes get an amber background
- Move the Apply / Discard buttons from the diff card to a fixed action bar at the bottom of the chat column, visible only while a pending change exists
- Replace `lines: DiffLine[]` in `PendingChange` with a node-keyed diff map that carries each node's status (`added` | `removed` | `modified`) and, for modified nodes, the previous type string

## Capabilities

### New Capabilities

- `schema-inline-diff`: Schema tree nodes carry a diff state (`added` / `removed` / `modified`) and render it directly as a colour overlay in the tree view

### Modified Capabilities

- `schema-chat-edit`: The Apply / Discard trigger moves from the diff card to a bottom action bar in the chat column

## Impact

- `src/SchemaPanel.tsx`: `PendingChange` type, `computeDiff`, pending diff card JSX, Apply/Discard button placement, `NodeRow` / node rendering
- `src/index.css`: add `--color-danger-soft` token (light red fill, currently missing)

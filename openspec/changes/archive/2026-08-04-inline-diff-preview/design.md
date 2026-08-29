## Context

`SchemaPanel` currently shows a pending chat edit as a standalone diff card — a bulleted list of `+`, `−`, `~` text lines positioned inside the chat scroll area. The schema tree is unchanged until the researcher clicks Apply. This forces researchers to read the diff card and mentally map each line back to its position in the tree.

The goal is to merge the diff directly into the tree view: the schema panel shows a "preview" of the post-edit state, with each changed node visually annotated inline.

Relevant current types:

```ts
type DiffLine  = { sign: '+' | '−' | '~'; text: string }
type PendingChange = { newNodes: SchemaNode[]; lines: DiffLine[] }
```

`renderRootField` / `renderChildField` in `SchemaPanel` currently know nothing about pending state.

## Goals / Non-Goals

**Goals:**
- When a pending change exists, the schema tree shows a merged "before + after" view where each affected node is colour-annotated
- Added nodes: green background
- Removed nodes: red background + strikethrough, shown at their original position (ghost entries — not applied yet)
- Modified nodes: amber background, showing the new name/type
- Apply / Discard move to a sticky action bar at the bottom of the chat column
- No separate diff card

**Non-Goals:**
- Drag-and-drop or editing within the diff preview (those controls are hidden/disabled while a pending change exists)
- Diffing nested structural changes beyond name/type

## Decisions

### 1. Diff representation: node-keyed map + display tree

Replace `lines: DiffLine[]` with:

```ts
type NodeDiffStatus = 'added' | 'removed' | 'modified'

type PendingChange = {
  newNodes: SchemaNode[]                    // post-op state, used on Apply
  displayNodes: SchemaNode[]                // merged tree for rendering (includes ghost-removed nodes)
  diffMap: Map<string, NodeDiffStatus>      // node id → status
}
```

`displayNodes` is `newNodes` augmented with removed nodes re-injected at their original positions. `diffMap` covers all affected node ids (including removed ones whose ids come from `currentNodes`).

**Why not just annotate `newNodes`?** Removed nodes are absent from `newNodes`. To show them in the tree, they must be reinjected. A separate `displayNodes` keeps `newNodes` clean for the Apply path.

### 2. Computing `displayNodes`

New helper `buildDiffPreview(oldNodes, newNodes)` returns `{ displayNodes, diffMap }`:

1. Build id sets for old and new trees.
2. Populate `diffMap`: new id not in old → `added`; old id not in new → `removed`; same id, different name or type → `modified`.
3. Walk `newNodes` recursively, interleaving removed siblings at their original index (recovered from `oldNodes`).

Removed nodes are ghost entries — they carry their original `SchemaNode` shape but are marked `removed` in `diffMap`. `applyPending` uses `newNodes` unchanged.

### 3. Tree renderer uses `diffMap` via closure

`renderRootField` and `renderChildField` are already closures inside `SchemaPanel`. They gain access to a local `diffMap` variable — no new prop drilling needed.

Row treatment per status:

| Status     | Row background    | Text colour      | Extra               |
|------------|-------------------|------------------|---------------------|
| `added`    | `bg-green-soft`   | `text-green`     | —                   |
| `removed`  | `bg-danger-soft`  | `text-danger`    | `line-through` name |
| `modified` | `bg-stale-soft`   | `text-stale-ink` | —                   |

Drag handles, edit buttons, and remove buttons are hidden for any node with a status in `diffMap`.

`--color-danger-soft: #fce8e4` is added to `index.css`.

### 4. Apply / Discard action bar

While `pending !== null`, a sticky action bar renders at the bottom of the chat column (outside the scroll area). The existing diff card inside the chat scroll area is removed.

## Risks / Trade-offs

- **Ghost node positioning**: Reinjecting removed nodes at their original sibling index may feel off if earlier siblings were also added/removed in the same op batch. Fallback: append removed nodes at the end of their parent.
- **No diff for structural moves**: A move (remove from root, add under parent) appears as two separate annotated nodes — correct but may look like two unrelated changes.

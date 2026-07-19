## Context

Schema chat calls `generateSchemaWithModel` (NuExtract `template-generation` mode). This mode generates a schema from a document — not from an instruction. At temperature 0.2 it always returns the same schema, so `computeDiff` returns zero and the researcher sees "No changes needed" on every chat message.

Separately, the schema is held in `App.tsx` as `template: unknown` (plain JSON). `SchemaPanel` converts it to `SchemaNode[]` on input and back to template JSON on every output. Node ids are regenerated on every round-trip, making stable field identity impossible.

## Goals / Non-Goals

**Goals:**
- `SchemaNode[]` becomes the canonical schema representation in App state — no more round-trips.
- Chat edits call a chat/instruction model and return a bounded op list; only the named fields are touched.
- Untouched nodes keep their ids across edits.
- Pending-diff card (Apply / Discard) shows the researcher exactly what will change.

**Non-Goals:**
- Move / reorder ops (enabled by the id stability this change introduces, but not implemented here).
- Streaming chat responses.
- Changes to manual drag-and-drop or field-edit forms.
- Changes to `generate_schema` or extraction routes.

## Decisions

### 1. `SchemaNode` moves to a shared file

`SchemaNode` is currently a file-local type in `SchemaPanel.tsx`. Moving it to `src/schemaNode.ts` (and exporting it) lets `App.tsx`, `SchemaPanel.tsx`, and the new `src/schemaOps.ts` all use the same type without a circular dependency.

### 2. `TemplateState` holds `nodes: SchemaNode[]`, not `template: unknown`

```ts
// before
{ status: 'ready'; template: unknown; inputsKey: string; edited?: boolean }

// after
{ status: 'ready'; nodes: SchemaNode[]; inputsKey: string; edited?: boolean }
```

`App.tsx` calls `templateToNodes` once when a schema generation result arrives, and `nodesToTemplate` once at each API call site (extraction, generate_schema). `SchemaPanel` drops its internal conversion entirely and reads/writes nodes directly.

### 3. Chat edit uses a chat model via `generateText`, not NuExtract

NuExtract is an extraction/template-generation model. The `model()` function in `_model.ts` already supports a configurable Ollama or API-compatible chat model. `editSchemaWithModel` sends a single user message:

```
Here is a JSON extraction schema:
<current template JSON>

The researcher wants to make this change: "<instruction>"

Return ONLY a JSON array of operations, one of:
  {"op":"add",    "name":"field_name", "type":"string", "parentName":null}
  {"op":"remove", "name":"field_name"}
  {"op":"patch",  "name":"field_name", "newName":"new_name", "type":"new_type"}

parentName is the name of an existing object field to nest under, or null for root.
Return [] if no change is needed. No explanation, no markdown, only the JSON array.
```

Response is parsed with `JSON.parse` (using the existing `parseUnknownJson` helper which handles whitespace and `<think>` blocks).

### 4. Op functions operate on `SchemaNode[]` directly

Three pure functions in `src/schemaOps.ts`:

| Op | Function | Behaviour |
|----|----------|-----------|
| `add` | `addSchemaNode(nodes, name, type, parentName)` | Appends new node to root, or to named parent's `children`. |
| `remove` | `removeSchemaNode(nodes, name)` | Recursively finds node by name and removes it. |
| `patch` | `patchSchemaNode(nodes, name, newName, type)` | Recursively finds node by name; updates `name` and `type` in place, preserving `id` and `children`. |

Existing `template.ts` functions (`addTemplateField`, `removeTemplateField`, `patchTemplateField`) are not removed — they remain for any callers that need to operate on plain template JSON.

### 5. Diff and pending-diff card are unchanged

After ops are applied: `computeDiff(oldNodes, newNodes)` produces the diff lines. `setPending` is called as today. Apply/Discard flow is identical.

## Risks / Trade-offs

- **Model returns malformed JSON** → `parseUnknownJson` + `JSON.parse` will throw; `sendChatMessage` catches and shows an error message in chat. No schema change occurs.
- **Model hallucinates a field name** → `removeSchemaNode` / `patchSchemaNode` traverse the tree and return nodes unchanged if the name is not found; the op becomes a no-op visible in the diff as zero lines.
- **`add` with nested `parentName`** → if the named parent does not exist or is not an object node, the function falls back to adding at root.
- **`inputsKey` / stale detection** — `TemplateState` still carries `inputsKey`; `schemaStale` in `App.tsx` is unaffected by this change.

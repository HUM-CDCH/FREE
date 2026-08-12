## Why

Two problems with the current schema editing flow:

1. **Chat edits are broken.** `sendChatMessage` calls `generate_schema`, which uses NuExtract in `template-generation` mode — a model designed to derive a schema from a document, not to follow instructions. 

2. **Schema state is lossy.** The schema is stored as a plain JSON template (`Record<string, unknown>`). Nodes have no stable identity — every re-generation or edit rebuilds the node tree with new random ids. This makes targeted partial edits and future tree operations (move, reorder) fragile.

## What Changes

**Part 1 — Persist schema as `SchemaNode[]`**

- Move `SchemaNode` type out of `SchemaPanel.tsx` into a shared `src/schemaNode.ts`.
- Change `TemplateState` in `App.tsx` to hold `nodes: SchemaNode[]` instead of `template: unknown`.
- `SchemaPanel` receives nodes directly; the `templateToNodes` / `nodesToTemplate` round-trip inside `SchemaPanel` is removed.
- NuExtract boundary: `nodesToTemplate` is called in `App.tsx` before sending to extraction or schema-generation APIs.
- Nodes that are not touched by an edit keep their original `id` across edits.

**Part 2 — Chat edits via op list applied to `SchemaNode[]`**

- Add backend route `POST /api/edit_schema`: accepts `current_template` (JSON) + `instruction` (string); calls a chat/instruction model; returns a structured op list.
- Op format:

  ```json
  [
    { "op": "add",    "name": "excavation_date", "type": "date",   "parentName": null },
    { "op": "remove", "name": "irrelevant_field" },
    { "op": "patch",  "name": "loc", "newName": "location", "type": "string" }
  ]
  ```

- Add three pure functions that apply ops directly to `SchemaNode[]`: `addSchemaNode`, `removeSchemaNode`, `patchSchemaNode`.
- `sendChatMessage` calls the new `requestSchemaEdit`; applies the returned ops to the current nodes; diffs old vs new nodes; sets `pending` for the researcher to review (Apply / Discard).

## Capabilities

### New Capabilities

- `schema-chat-edit`: Researcher types an instruction in the schema chat → model returns a list of atomic field operations → frontend applies them to the current `SchemaNode[]` one by one, leaving untouched nodes unchanged.
- `schema-node-persistence`: `SchemaNode[]` (with stable ids) is the canonical schema representation in `App.tsx`; template JSON is derived at API call sites only.

### Modified Capabilities

- `chat-endpoint`: Unaffected — `/api/edit_schema` is a new route separate from `/api/chat` and `/api/generate_schema`.

## Impact

- **Shared type**: new `src/schemaNode.ts` (exports `SchemaNode`).
- **Backend**: new `api/edit_schema.ts` route; new `editSchemaWithModel` in `api/_model.ts`.
- **Frontend**:
  - `App.tsx` — `TemplateState` type; schema generation result → `templateToNodes`; extraction call-site → `nodesToTemplate`.
  - `SchemaPanel.tsx` — remove internal `templateToNodes`/`nodesToTemplate` round-trips; use nodes from props directly.
  - `src/api.ts` — new `requestSchemaEdit`.
  - New `src/schemaOps.ts` — `addSchemaNode`, `removeSchemaNode`, `patchSchemaNode`.
- **No changes**: manual editing (drag/drop, field-edit forms), extraction logic, `generate_schema` route, `template.ts`.

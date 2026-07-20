## Why

Humanities researchers need to annotate group-level schema fields with descriptive text so the extraction model understands the intent behind each logical grouping. Without descriptions, multi-level schemas lack the semantic context that would help researchers communicate extraction intent.

## What Changes

- Add a `description?: string` property to group nodes (nodes with `children`) in `SchemaNode`
- Store and round-trip `_description` as a reserved key inside group objects in the schema template representation
- Filter `_description` keys out of the template before sending to the extraction model (NuExtract treats unknown keys as fields to extract)
- Show an ℹ icon on group node rows in the Schema Panel fields view; clicking it reveals an inline editable text input for the description
- Make the JSON tab in the Schema Panel fully editable: add an Edit button that switches the `<pre>` display to a `<textarea>`; save parses JSON back to nodes (including `_description` keys)
- Update `nodesToTemplate` / `templateToNodes` to carry `_description` through round-trips

## Capabilities

### New Capabilities

- `schema-field-descriptions`: Group-level descriptions on schema nodes — UI entry (ℹ icon), JSON round-trip via `_description` key, and filtering before model dispatch

### Modified Capabilities

- `schema-panel`: Fields view gains ℹ icon for group nodes; JSON tab gains Edit button and editable textarea mode

## Impact

- `prototypes/studio/src/SchemaPanel.tsx`: `SchemaNode` type, `templateToNodes`, `nodesToTemplate`, `renderRootField`, JSON tab render
- `prototypes/studio/src/api.ts` or wherever `nodesToTemplate` output is passed to `/api/extract`: strip `_description` keys before dispatch
- `/api/extract` accepts an optional instruction block and threads it through extraction generation; the parsing service is unchanged

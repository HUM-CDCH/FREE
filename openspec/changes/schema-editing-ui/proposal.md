## Why

The schema panel currently supports only read-plus-delete operations. Researchers need to refine the generated schema after reviewing it — renaming fields, changing types, reordering, and making structural changes by describing them in natural language. Without these controls, every schema imperfection requires a full regeneration.

## What Changes

- Add drag-and-drop reordering and re-nesting to the schema field list (grab ⠿ handle, drop onto slot or group)
- Add inline edit form (✎ button opens name input + type dropdown in place)
- Add a chat panel at the bottom of SchemaPanel: researcher describes a schema change, model proposes a diff, researcher applies or discards
- Auto-scroll the field list while dragging near the container edges
- Show "into [group]" badge when dragging over a nested group to indicate nesting intent
- Show empty-group placeholder "drag a field in here" for groups with no children

## Capabilities

### New Capabilities

- `schema-drag-drop`: Drag-and-drop reorder and re-nest of schema fields within SchemaPanel, including auto-scroll and visual drop-slot indicators
- `schema-chat-edit`: Chat panel in SchemaPanel that accepts free-form schema change requests, returns validated operations, and lets the researcher review an inline diff before applying or discarding

### Modified Capabilities

- `extraction-results-view`: No requirement changes (UI is unaffected by schema panel changes)

## Impact

- `prototypes/studio/src/SchemaPanel.tsx` — substantial rewrite; adds drag state, chat state, inline edit, and a bottom chat panel
- `prototypes/studio/src/api.ts` and `prototypes/studio/api/edit_schema.ts` — dedicated runtime-validated schema-operation request
- `prototypes/studio/src/template.ts` — `patchTemplateField`, `addTemplateField`, `removeTemplateField` helpers remain; may add a field-reorder helper
- Model-route changes are limited to the Studio serverless API; no parsing-service changes are required

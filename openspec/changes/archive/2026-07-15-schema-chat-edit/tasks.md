## 1. Shared SchemaNode type

- [x] 1.1 Create `src/schemaNode.ts` — move the `SchemaNode` type from `SchemaPanel.tsx` and export it
- [x] 1.2 Update `SchemaPanel.tsx` to import `SchemaNode` from `src/schemaNode.ts` instead of defining it locally

## 2. Persist SchemaNode[] in App state

- [x] 2.1 Change `TemplateState` (exported from `SchemaPanel.tsx`) — replace `template: unknown` with `nodes: SchemaNode[]`
- [x] 2.2 In `App.tsx` schema generation handler: call `templateToNodes` on the returned template and store as `nodes` in `TemplateState`
- [x] 2.3 In `App.tsx` extraction call-site: call `nodesToTemplate(state.nodes)` before passing to the extraction API
- [x] 2.4 In `App.tsx` `changeTemplate` handler: accept `SchemaNode[]` instead of `unknown` and store as `nodes`

## 3. Simplify SchemaPanel internals

- [x] 3.1 Remove the `useEffect` in `SchemaPanel` that calls `templateToNodes(state.template)` — read `state.nodes` directly as the initial node tree
- [x] 3.2 Replace every `onTemplateChange(nodesToTemplate(nodes), ...)` call in `SchemaPanel` with a direct `onNodesChange(nodes, ...)` using the updated prop signature
- [x] 3.3 Update `SchemaPanel` props: rename `onTemplateChange` to `onNodesChange` and change its signature to `(nodes: SchemaNode[], message: string) => void`

## 4. SchemaNode op functions

- [x] 4.1 Create `src/schemaOps.ts` with `addSchemaNode(nodes, name, type, parentName): SchemaNode[]` — appends to root when `parentName` is null; appends to named parent's children otherwise; falls back to root if parent not found
- [x] 4.2 Add `removeSchemaNode(nodes, name, parentName?): SchemaNode[]` — recursively finds the node with that name; when `parentName` is provided, only matches nodes whose direct parent has that name; returns nodes unchanged if not found
- [x] 4.3 Add `patchSchemaNode(nodes, name, newName, type, parentName?): SchemaNode[]` — same scoped lookup as `removeSchemaNode`; updates `name` and `type` in place; preserves `id` and `children`
- [x] 4.4 Update the op types and `addSchemaNode` to include the optional `parentName` field consistently across all three functions so the model can always pass it for precision

## 5. Backend — edit_schema route

- [x] 5.1 Add `editSchemaWithModel` to `api/_model.ts` — sends current template JSON + instruction to `model()` via `generateText`; parses the response JSON array with `parseUnknownJson`; returns typed op list
- [x] 5.2 Create `api/edit_schema.ts` route — `POST`, reads `current_template` and `instruction` from form data; calls `editSchemaWithModel`; returns the op list as JSON

## 6. Frontend — wire up chat edit

- [x] 6.1 Add `requestSchemaEdit(nodes: SchemaNode[], instruction: string): Promise<SchemaOp[]>` to `src/api.ts` — serialises `nodesToTemplate(nodes)` as `current_template`, posts to `/edit_schema`, returns the parsed op array
- [x] 6.2 In `SchemaPanel.tsx` `sendChatMessage`: replace the `requestSchema` call with `requestSchemaEdit`; apply the returned ops sequentially using `addSchemaNode` / `removeSchemaNode` / `patchSchemaNode`; keep the existing diff and `setPending` logic unchanged
- [x] 6.3 Define `SchemaOp` type (union of add / remove / patch shapes) in `src/schemaOps.ts` and import it where needed

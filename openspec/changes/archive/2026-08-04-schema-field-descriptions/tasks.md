## 1. SchemaNode type and round-trip functions

- [x] 1.1 Add `description?: string` to the `SchemaNode` type in `SchemaPanel.tsx`
- [x] 1.2 Update `templateToNodes`: when iterating a record's entries, if the entry key is `"_description"` and the value is a string, assign it to the resulting group node's `description` and skip it as a child field
- [x] 1.3 Update `nodesToTemplate` to include `"_description"` at the start of each group object when `node.description` is non-empty (display version — used for JSON tab and state)
- [x] 1.4 Add `stripDescriptions(v: unknown): unknown` pure function in `template.ts` that recursively removes `_description` keys from any object/array tree
- [x] 1.5 Update `deepClone` to carry `description` through cloned nodes (no-op: spread already copies all properties)

## 2. Description compilation utility

- [x] 2.1 Add `compileInstructions(template: unknown, prefix?: string): string` in `template.ts` that recursively reads `_description` keys, building lines in the format `- <dot.path>: <description>`, and returns the joined string (empty string if no descriptions)

## 3. ℹ icon in fields view

- [x] 3.1 Add local state `openDescId: string | null` to SchemaPanel to track which group node's description input is open
- [x] 3.2 In `renderRootField`: after the field name `<span>`, add an ℹ icon `<button>` that is only rendered when `isGroup === true`; clicking toggles `openDescId` between `node.id` and `null`; icon is accent-colored when `node.description` is non-empty, ink-muted otherwise
- [x] 3.3 Below the row `<div>`, when `openDescId === node.id`, render a single-line `<input>` pre-filled with `node.description ?? ''`; on blur, trim the value, update `node.description` in nodes state (set to `undefined` if empty), and call `onTemplateChange`
- [x] 3.4 Apply the same ℹ icon and inline input pattern in `renderChildField` for child nodes that are also groups (`child.children !== undefined`)

## 4. JSON tab Edit mode

- [x] 4.1 Add local state `jsonEditMode: boolean` and `jsonDraft: string` and `jsonEditError: string | null` to SchemaPanel
- [x] 4.2 In the JSON tab render, show an Edit button (top-right corner of the `<pre>` area) that sets `jsonEditMode = true` and initialises `jsonDraft` with the current display JSON
- [x] 4.3 When `jsonEditMode` is true, render a `<textarea>` containing `jsonDraft` with Save and Cancel buttons; Save: parse `jsonDraft` as JSON, call `templateToNodes`, update nodes and call `onTemplateChange`, close edit mode; on parse error set `jsonEditError` and keep textarea open; Cancel: reset `jsonEditMode = false` and clear `jsonEditError`
- [x] 4.4 Show `jsonEditError` as an inline error message below the textarea when non-null

## 5. Wire descriptions into extraction

- [x] 5.1 Add `instruction?: string` parameter to `requestExtraction` in `api.ts`; append it as `form.append('instruction', instruction)` when non-empty
- [x] 5.2 Strip descriptions and compile instructions internally in `useExtraction.ts` using `stripDescriptions` and `compileInstructions` from `template.ts`
- [x] 5.3 Before passing `template` to `requestExtraction` in `useExtraction`, call `stripDescriptions(template)` to remove `_description` keys from the extraction template
- [x] 5.4 Compile instructions in `useExtraction` with header "Field descriptions:\n..." and pass as `instruction` to `requestExtraction` (no App.tsx changes needed — handled internally)

## 6. Verify

- [x] 6.1 Run `pnpm build` in `prototypes/studio` and confirm zero TypeScript errors

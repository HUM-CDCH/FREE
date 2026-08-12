## 1. Data Model

- [x] 1.1 Define `SchemaNode` type (`id`, `name`, `type`, `children?`) in SchemaPanel.tsx
- [x] 1.2 Write `templateToNodes(template)` converter that produces a `SchemaNode[]` from the nested template object
- [x] 1.3 Write `nodesToTemplate(nodes)` converter that produces the nested template object from `SchemaNode[]`
- [x] 1.4 Add `reorderTemplateField` helper to template.ts (or inline in SchemaPanel) that moves a field by id within a flat node list

## 2. Drag and Drop — Core Mechanics

- [x] 2.1 Add drag state to SchemaPanel: `dragging: { id, parentId, name, isGroup } | null`, `dragX`, `dragY`, `overTarget`
- [x] 2.2 Attach global `mousemove` and `mouseup` listeners in `useEffect`; update `dragX/dragY` on move, commit drop on up
- [x] 2.3 Implement `startDrag(id, parentId, name, isGroup)` on `mousedown` of each ⠿ handle; prevent default to block text selection
- [x] 2.4 Implement drop slot elements between each field row; on `mouseenter` set `overTarget` to `{ type: 'slot', parentId, index }`
- [x] 2.5 Implement `commitDrop()`: extract dragged node from nodes array, insert at target slot; call `onTemplateChange` with converted template
- [x] 2.6 Render floating drag overlay: fixed-position chip following `dragX/dragY` showing "⠿ fieldname" — only when `dragging !== null`

## 3. Drag and Drop — Group Nesting

- [x] 3.1 On `mouseenter` of a group row (not its children area), set `overTarget` to `{ type: 'group', id, name }` — skip if dragged item is a group or is already a child of this group
- [x] 3.2 On `mouseleave` of a group row, clear `overTarget` if it was pointing to that group
- [x] 3.3 Show "into [group name]" badge on the group row when `overTarget.type === 'group' && overTarget.id === group.id`
- [x] 3.4 In `commitDrop`, handle `type === 'group'` target: append the dragged node to the group's children array
- [x] 3.5 Show "drag a field in here" dashed placeholder inside empty groups while a drag is in progress

## 4. Drag and Drop — Auto-Scroll

- [x] 4.1 On drag start, begin a `requestAnimationFrame` loop that reads the schema list's scroll container bounding rect and `dragY`
- [x] 4.2 If `dragY < rect.top + 60`, scroll container up by 7px per frame; if `dragY > rect.bottom - 60`, scroll down by 7px per frame
- [x] 4.3 Cancel the RAF loop on drag end (`mouseup`) and on component unmount

## 5. Inline Edit

- [x] 5.1 Keep existing `FieldEditing` state and `FieldEditForm` component; wire ✎ button to `startEdit` in the new node-based render
- [x] 5.2 In `saveEdit`, convert updated node back to template via `nodesToTemplate` and call `onTemplateChange`
- [x] 5.3 Ensure inline edit is not accessible while a drag is in progress (disable ✎ button when `dragging !== null`)

## 6. Chat Panel — Layout and Static UI

- [x] 6.1 Add a bottom chat panel section below the field list scroll area (inside the SchemaPanel flex column), with a max-height and internal scroll
- [x] 6.2 Render chat messages list: user messages right-aligned with accent background; assistant messages left-aligned with surface border style
- [x] 6.3 Render suggestion chips row above the text input when unused suggestions remain
- [x] 6.4 Render text input with send button (↑); placeholder "Describe a change to the schema…"
- [x] 6.5 Add `chat: ChatMessage[]`, `pending: PendingChange | null`, `usedSuggestions: string[]` to state

## 7. Chat Panel — Model Integration

- [x] 7.1 On user sends message (or clicks chip), append user turn to `chat`, set loading state
- [x] 7.2 Call `/api/generate_schema` (POST) with current template serialized as `document_markdown` context and user message as the annotation hint; receive new template
- [x] 7.3 Compute diff: walk old nodes and new nodes to produce `DiffLine[]` with `sign (+/−/~)`, field path, and new type
- [x] 7.4 Set `pending` state with the diff lines and the proposed template; append loading-complete assistant turn to chat
- [x] 7.5 Scroll the chat container to the bottom after each new message or pending change appears

## 8. Chat Panel — Apply and Discard

- [x] 8.1 Render the pending diff card in the chat area: "Proposed changes — review before applying" header, diff lines with colored signs, "Apply changes" + "Discard" buttons
- [x] 8.2 On "Apply changes": update node list from pending template, call `onTemplateChange`, clear `pending`, append confirmation message to chat
- [x] 8.3 On "Discard": clear `pending`, append "Discarded, no changes made" message to chat
- [x] 8.4 Disable text input, send button, and hide suggestion chips while `pending !== null`

## 9. Cleanup and Verification

- [x] 9.1 Verify TypeScript compiles without errors (`pnpm --filter studio build`)
- [ ] 9.2 Manually test drag reorder at root level; drag into group; drag child out to root
- [ ] 9.3 Manually test inline edit (rename + retype)
- [ ] 9.4 Manually test chat suggestion chips → diff card → apply and discard
- [ ] 9.5 Test auto-scroll by dragging a field with the schema list taller than the panel

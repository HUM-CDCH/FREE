# Studio workspace redesign — design

Date: 2026-10-02 · Status: implemented on feat/studio-workspace-redesign (plan 2026-10-03) · Scope: `prototypes/studio/src`,
`prototypes/studio/DESIGN.md`

## Purpose

The Source Document workspace is cluttered and unclear: three bars of chrome
before the document, a toolbar that mixes viewing, method and run controls, a
rail whose field names truncate to one letter, a permanent chat that takes
half the rail, badges below the design system's own type floor. The audit of
2026-10-02 (private page "Studio Workspace UX Audit", 32 findings) is the
evidence; this spec is the layout that answers it.

Decided with the researcher on 2026-10-02: no sampling controls (removed by
`2026-10-02-sample-workbench-removal-design.md`); one green run action without
a popover; chat as a drawer; thumbnails in the page rail; green for positive
actions and red for destructive ones; a single-click delete icon on a field
row instead of checkboxes. Confirmed on 2026-10-02: a run still starts on the
researcher's Run; what is on screen decides only the order in which it runs
(the streaming spec).

## Constraints

- No new dependency. Thumbnails render with the `pdfjs-dist` already loaded.
- Base: a fresh worktree from `origin/dev` after the removal spec has merged.
- Tokens and type from `DESIGN.md` and `index.css`, with the one amendment in
  §10. Four text sizes in the rail: 13 content, 12 secondary, 11 compact,
  10.5 overline. No `text-[9px]` or half-pixel sizes.
- Colour is never the only signal: every coloured action keeps an icon or a
  label; every state has a text equivalent.
- Hit targets at least 24px; hover-revealed controls are also revealed by
  `:focus-within`, so keyboard users reach them.
- `src/ui` primitives are used, not mirrored: `Button`, `Pill`,
  `SegmentedControl`, `Overline`, `Panel`, `EmptyState`, `ModalDialog`.
- Domain language from `CONTEXT.md`; copy says "researcher", never "user", and
  never "JSON" in a researcher-facing label.
- The next-step line of `2026-10-02-workflow-guidance-design.md` renders above
  the content; this spec leaves it the slot and removes the control it
  replaces (the floating hint pill).

## 1. Frame and tab strip

- `AppFrame.tsx`: the collapsed rail (46px) shows a 24px monogram; the full
  mark only when the rail is open. The 56px header height stays.
- `DocumentTabBar.tsx`: one row. Left: a project chip (the Project name with a
  caret; click navigates to the project's Sources tab, replacing the
  breadcrumb row, which is removed). Then the open-document tabs as today.
  Right, in the portal slot: the schema save state (§5) and the run action
  (§2). Nothing else. The "Back to review grid" link, when present, sits in the
  project chip's menu.
- The window title stays `FREE Studio — <document>`.

## 2. The run action

- One `Button variant="positive" size="md"`, "▶ Run extraction", at the right
  of the tab strip. While an Extraction runs it reads "■ Stop extraction" with
  the progress the Results badge shows (§4); cancellation keeps today's
  "Cancellation requested…" state.
- No popover. The click reads the account's saved method again
  (`saved.refresh()` then `savedMethodFor`) and submits that, so what admission
  pins is what was saved at the click; `SavedMethodSummary` and its toolbar
  variant are removed. A `method_changed` refusal (the settings changed between
  the read and the admission) re-reads once and retries; a second refusal
  shows the toast "Your saved settings changed. Run again." and nothing starts.
- The strategy is the schema's saved Record Scope (§5). With none saved the
  button is disabled with the tooltip "Choose Article or Catalog in the
  schema header"; the next-step line says the same.
- Boundaries (a numbered-catalogue recipe or model discovery) is a per-run
  choice only on a deployment that does not admit the unified Catalog. There
  it is a `<select>` on the schema header's second line (§5), labelled
  "Boundaries"; on a deployment with the unified Catalog nothing is shown.
- Disabled reasons keep today's `title` texts (no current representation, a
  save error or conflict, no schema, indexing).
- The method is explained after the fact where it already is: "Run details"
  in the Results tab (`MethodUsed`). Model Configuration's Advanced tab holds
  the settings.

## 3. Document region

- Edge to edge: hairline borders, no rounded card, no outer padding
  (`App.tsx` work surface). The page keeps `--shadow-page`.
- One document toolbar, 34px: "☰ Pages" (`Button variant="secondary"`,
  `aria-expanded`), "◀ 6 / 7 ▶" with the number an input (type a page, Enter
  navigates), the zoom group as today, nothing at the right.
- `PageNavigation.tsx` becomes a thumbnail rail, 76px wide: each page a
  46×58px canvas rendered by pdf.js at scale 0.12 from the viewer's own
  `PDFDocumentProxy`, rendered lazily when the rail is open and the page is
  within one rail height of view, cached per document in a `Map<number,
  ImageBitmap>` that is dropped when the document closes. Number under each
  thumbnail; the current page has a 2px ink ring (`ring-ink`), the hovered one
  an accent-ghost wash. The keyboard model is unchanged. On viewports under
  860px the rail overlays as today.
- The floating hint pill (`hintText`) is removed. Transient outcomes stay as
  toasts at the top of the document.

## 4. Right rail

- Tabs: Schema and Results. The Schema badge is the field count. The Results
  badge is "n to check" while required decisions remain, "running" (and, once
  the streaming spec lands, "k of n") during a run, and nothing once
  reviewed. The developer-only Evidence tab is unchanged.
- The collapse button, the 264 to 560px resize and the narrow-viewport overlay
  are unchanged.

## 5. Schema panel header and record description

- Line one: the schema name through `SchemaNameEditor` (13px semibold, pencil
  on hover and focus), then the right group: `SegmentedControl` "Fields |
  Code" and an overflow button "⋯" (`aria-label="Schema actions"`).
- Line two, 12px ink-muted: the Record Scope as "Article · one object for the
  document" or "Catalog · a collection of records", editable through a
  `<select>` styled as a text button, saved at once as today
  (`schema.setRecordScope`); then "Boundaries" when §2 says so. With no scope
  saved the line reads "Choose Article or Catalog" in accent.
- The default schema name is no longer "Extraction Schema": a generated or
  imported schema is named after its Source Document (the file name without
  its extension, as `sourceDocumentName` already supplies it) and a blank
  schema "Untitled schema"; the researcher renames through the pencil. The
  overline "EXTRACTION SCHEMA" is removed; the `h2` keeps the name for the
  accessibility tree.
- Overflow menu, in order: "Import from Excel codebook…", "Edit as code",
  "History" (opens today's revision list), "Regenerate from the document…"
  (opens today's instructions drawer as a dialog), a divider, "Clear schema"
  in danger with its existing confirmation.
- Record description: a labelled `<textarea>` "What one record is", flush with
  the list, hairline border that strengthens on hover and focus, two rows,
  auto-growing to six, saved on blur as today. The card around it is removed.
- Save state: the footer shows "Saved · revision 3", "Saving…", "Not saved ·
  Retry" (`SchemaSaveStatus`, moved from the toolbar); the "n fields" footer
  text is removed.
- Empty state (`EmptyState`): "No schema yet" with three actions, "Generate
  from the document", "Import from Excel codebook…", "Start blank".

## 6. Field rows

Anatomy, left to right, 30px tall at rest, 4px gap, nested rows indented 16px
behind a hairline:

1. Drag grip `⠿`, always visible at 60% opacity; drag behaviour unchanged.
2. Disclosure triangle for every group, root level included; a collapsed group
   shows "· n fields" in its type pill.
3. Name: IBM Plex Mono 13px weight 600, `shrink-0`, `max-w-[60%]`, so it is
   never truncated by its own metadata.
4. Type `Pill tone="neutral"` at 11px with words: "string", "number",
   "boolean", "verbatim", "list of strings", "list of objects · 2 fields".
   Clicking it opens the edit form as today.
5. Values `Pill outline` "6 values" when `allowedValues` is set; its `title`
   lists them; clicking opens the edit form on the values tab. The inline value
   list is removed.
6. Flexible space.
7. Actions, hidden at rest, shown on hover and `:focus-within`: "Edit"
   (pencil), "Add note" (note-plus icon), "Delete" (trash, danger). 28px
   targets, 4px apart. The selection checkbox, `selectedIds`, `toggleSelected`,
   `bulkRemoveNodes` and the "n fields selected" bar are removed.

A note (`description`) renders as a second line, 12px ink-muted, in full; the
"i" button and its accent state are removed. "Add note" and clicking the line
open today's `DescriptionEditForm`.

Delete: one click removes the field (and its subtree) with
`schema.commit(…, 'Field removed')` and shows the toast "Field removed · Undo"
for eight seconds; Undo commits the previous nodes back
(`'Field restored'`). No confirmation dialog. The toast is the existing
`showToast` with an action slot added.

A new field opens the edit form with an empty name and the placeholder
`field_name`; Save is disabled until a valid name is entered. The `nyt_felt`
default is removed.

Keyboard: a row is focusable; Enter opens the edit form, Delete removes with
the same undo, Space toggles a group. Proposal review (diff tints, Accept
checkbox, `ProposalReviewBar`) is unchanged.

## 7. Chat composer and drawer

- At rest: one composer line docked at the rail's bottom, placeholder
  "Describe a change to the schema…", the ↑ button; nothing else. The greeting
  bubble is removed (its text becomes the drawer's empty state).
- Sending expands a drawer to 40% of the rail height: conversation, typing
  indicator, Stop. A pending proposal keeps it open with the Apply / Discard
  bar; Apply or Discard collapses it. A "collapse" chevron in the drawer header
  hides it without discarding; a dot on the composer then marks an open
  conversation.
- Running earlier requests (`runningRows`) show in the drawer and, while
  collapsed, as the same dot with the tooltip "An earlier request is still
  running".
- Before a schema exists, the instructions chat (`SchemaInstructionsChat`) uses
  the same drawer, open by default, with "Generate schema" in its header.

## 8. Results tab

- Header: "Extraction results", the Run-details button, and the export control
  as today. The summary chips, review progress and the Review | Values as code
  | Markdown control stay; "Raw JSON" is renamed "Values as code".
- `ReviewAttention` is restyled as rows with a `SegmentedControl` filter
  (Required · Ungrounded · Missing · All), each row the value's path in mono,
  its state as a `Pill`, and "Edit field".
- Per-value state: `ResultValue` takes `state: 'grounded' | 'checking' |
  'reading' | 'queued' | 'empty' | 'contested'`. This spec renders
  `grounded`, `empty` and `contested` from the settled attempt; `checking`,
  `reading` and `queued` are defined here, styled here (muted ink and a hollow
  marker, a dashed marker, a line-strong marker) and populated by the streaming
  spec. A record shows a header "label · page" and its values.

## 9. Import dialog

`SchemaImport` renders as a `ModalDialog` "Import from Excel codebook": file
picker as a `Button` (the native input visually hidden, still focusable),
worksheet and header row on one line, "Preview worksheet", then a table of
columns (include, name, type, allowed values, examples) and the resulting
fields previewed as a field list (not JSON). Its behaviour and limits are
unchanged.

## 10. Colour and type

Amendment to `DESIGN.md` §2 rules: terracotta for brand, the active tab,
selection and drag states, and focus; green (`--color-green`) for positive
commands (run, apply, accept, save, finalize); red (`--color-danger`) for
destructive ones (delete a field, clear the schema, discard a proposal,
cancel). `Button` gains `variant="positive"` (green fill, white text) and
`variant="danger"` (danger fill); `primary` is removed and its uses mapped
(run, apply, accept, finalize → positive; the rest → secondary). Every
coloured action keeps an icon or a label.

Type: the rail uses four sizes (constraints). `index.css` gains
`--text-content: 13px`, `--text-secondary: 12px`, `--text-compact: 11px`,
`--text-overline: 10.5px` under `@theme`, and the components use them.

## 11. Copy

| Where | Now | After |
|---|---|---|
| Results badge | ✓ | "3 to check", nothing once reviewed |
| Schema header | EXTRACTION SCHEMA / Extraction Schema | the schema's name; "Catalog · a collection of records" |
| Record description label | RECORD DESCRIPTION | What one record is |
| View switch | Fields / JSON | Fields / Code |
| Results view | Raw JSON | Values as code |
| Type badges | array<object>, verbatim-string | list of objects · 2 fields, verbatim |
| Values badge | male \| female \| … | 6 values |
| Run | ↻ Re-run extraction | ▶ Run extraction (same label after a result) |
| New field | nyt_felt | empty, placeholder field_name |
| Import | Import Excel codebook Choose File | Import from Excel codebook… |

## Error handling

- Thumbnail render failure: the thumbnail shows the page number on a blank
  card; navigation still works.
- Undo after the schema changed elsewhere (a conflict): the restore commit
  fails through the existing duplicate-name and no-draft paths and the toast
  says "Could not restore the field".
- A `method_changed` refusal twice in a row: toast, nothing started (§2).
- Storage, network and save errors keep their existing copy and placement.

## Testing

- Unit (`vitest` with Testing Library): `DocumentTabBar` renders the project
  chip and no breadcrumb; the run button's disabled reasons; `PageNavigation`
  renders a thumbnail per page and rings the current one; `SchemaPanel` field
  rows keep the full name beside a six-value badge at 264px, reveal actions on
  focus-within, delete with undo, open a blank edit form for a new field; the
  composer expands on send and collapses on apply; `ResultsTab` renders the six
  value states; `Button` variants.
- Playwright (weekly e2e): open a document, run, see "n to check", delete and
  undo a field, import a codebook through the dialog.
- Gates: `pnpm test`, `pnpm lint`, `pnpm typecheck`.

## Files

New: `src/ui/Toast.tsx` (toast with an action slot, replacing the inline toast
in `App.tsx`), `src/PageThumbnails.ts` (render and cache).

Edited: `AppFrame.tsx`, `DocumentTabBar.tsx`, `App.tsx`, `PageNavigation.tsx`,
`RightRail.tsx`, `SchemaPanel.tsx`, `SchemaNameEditor.tsx`,
`SchemaInstructions.tsx`, `SchemaSaveStatus.tsx`, `SchemaImport.tsx`,
`ResultsTab.tsx`, `ReviewAttention.tsx`, `ui/Button.tsx`, `ui/Pill.tsx`,
`ui/ResultValue.tsx`, `ui/README.md`, `index.css`, `DESIGN.md`, and the tests
beside them.

Deleted: `SavedMethodSummary.tsx` and its test; the toolbar `hintText`.

## Out of scope

- Streaming and view-ordered extraction (its own spec).
- An "extract as I read" automatic mode.
- The project page, the batch review grid and Model Configuration.
- The next-step indicator (its own spec).

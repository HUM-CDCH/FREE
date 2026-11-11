# FREE Design System

## 1. Atmosphere & Identity

FREE feels like a quiet research desk: paper-forward, compact, and evidence-minded. The signature is warm document surfaces paired with restrained terracotta accents, so the source document remains the primary visual object.

## 2. Color

### Palette

| Role | Token | Value | Usage |
|------|-------|-------|-------|
| Canvas | `--color-canvas` | `#faf6f2` | App backdrop and source document area |
| Surface | `--color-surface` | `#ffffff` | Sidebars, toolbar, panels |
| Surface muted | `--color-surface-muted` | `#f5efe9` | Pills and subtle fills |
| Ink | `--color-ink` | `#33302c` | Primary text |
| Ink muted | `--color-ink-muted` | `#6c6259` | Secondary text |
| Ink faint | `--color-ink-faint` | `#776b60` | Tertiary labels |
| Line | `--color-line` | `#eadfd6` | Hairline borders |
| Line strong | `--color-line-strong` | `#d9cabc` | Emphasised borders |
| Accent | `--color-accent` | `#a34828` | Brand, the active tab, selection and drag states, focus |
| Accent soft | `--color-accent-soft` | `#f4ddd3` | Accent fills |
| Accent ghost | `--color-accent-ghost` | `#fbf1ec` | Hover wash |
| Evidence | `--color-ev` | `#4f8aa8` | Evidence-related marks only; a top-level field's colour overrides it on its marks and rows |
| Success | `--color-green` | `#3e7c4f` | Positive commands (run, apply, accept, save, finalize) and success state |
| Warning | `--color-stale` | `#b8860b` | Stale state (golden amber, held off the terracotta hue) |
| Error | `--color-danger` | `#9e2b33` | Destructive commands (delete a field, clear the schema, discard a proposal, cancel) and errors |

`index.css` holds the full token set, including the `-soft` and `-ghost` tints, `--color-stale-ink`, `--radius-card` and `--shadow-lift`.

### Rules

- Terracotta (accent) is a **rest** colour: brand, the active tab, the selected or current item, drag, and focus. It is never a hover-only transition on an otherwise-neutral control.
- Neutral controls rest in ink/line and hover to ink (`text-ink`, `bg-surface-muted`, `border-line-strong`) — a muted button, tab, icon button, menu item or text action never turns terracotta on hover. Selectable rows keep the faint `accent-ghost` wash that previews their selected state.
- Green (`--color-green`) fills positive and commit commands: run, apply, accept, save, finalize, create, add. An inline confirm/save icon button takes green, not terracotta.
- Red (`--color-danger`) fills destructive commands: delete a field, clear the schema, discard a proposal, cancel. It is deeper and cooler than the terracotta accent so the two never read as one colour.
- Amber (`--color-stale`) is a distinct golden hue from the terracotta accent, so "stale / re-run" and "brand / current" never blur together.
- Every coloured action keeps an icon or a label; colour is never the only signal.
- Preserve the warm paper palette; avoid decorative gradients.
- Do not introduce raw colors outside this file and `index.css`.

## 3. Typography

### Scale

| Level | Size | Weight | Line Height | Tracking | Usage |
|-------|------|--------|-------------|----------|-------|
| Panel body | 13px | 400-700 | 1.5 | 0 | Side panels |
| Secondary | 12px | 400-600 | 1.5 | 0 | Hints and metadata |
| Compact | 11px | 500-700 | 1.3 | 0 | Pills, buttons, dense controls |
| Overline | 10.5px | 700 | 1.3 | 0.12em | Panel labels |
| Code | 11-12.5px | 400-600 | 1.6 | 0 | JSON and field names |

In the right rail only four sizes are used, as the tokens `--text-content` (13), `--text-secondary` (12), `--text-compact` (11) and `--text-overline` (10.5) in `index.css`, plus one display size, `--text-display` (20px, weight 700, line-height 1.25), for the To check count and the one-by-one value.

### Font Stack

- Primary: `Albert Sans`, system sans.
- Serif: `Source Serif 4`, Georgia, for document-adjacent flourishes only.
- Mono: `IBM Plex Mono`, system mono.

### Rules

- Keep panel typography compact and scannable.
- Use mono for schema fields, JSON, and machine-readable values; in Results a field's name reads as words in the sans face.
- Long text never runs out of its box. Where the whole text matters it wraps and shows in full (`min-w-0` with `[overflow-wrap:anywhere]`, since file and field names run unspaced): a page's subject heading, dialog and toast text, errors and notices, chat messages, values and evidence under review, definition values, a field's name in the Template editor, and the rail's project and document names. Elsewhere — compact chrome such as header lines, tab and chip labels, list rows, menu items, buttons, table headers and status lines — it keeps one line and ends in an ellipsis (`truncate`, with `min-w-0` up its flex chain), its full text in the `title`. A control beside the text keeps its size (`shrink-0`); the text gives way.

## 4. Spacing & Layout

### Base Unit

Spacing uses Tailwind's default scale, in steps of 0.25rem (4px); FREE defines no spacing tokens of its own.

### Grid

- Layout is a three-pane work surface: project nav, source document, right rail.
- Right rail remains dense and resizable; avoid landing-page spacing.

### Rules

- Keep fixed-format controls stable with explicit min widths or flex shrink rules.
- Avoid nested page-section cards; cards are for repeated values and error blocks.

## 5. Components

The shared primitives are exported from [`src/ui/index.ts`](src/ui/index.ts).

### Segmented Control
- **Structure**: bordered flex group with button segments.
- **Variants**: active uses `bg-ink text-canvas`; inactive uses surface and muted ink.
- **States**: hover, focus-visible, `aria-pressed`.

### Action Button
- **Structure**: compact rounded button with border.
- **Variants**: green positive, danger, surface secondary, rounded pill; `outline-positive` (green text and icon, `border-green/40`, `--color-green-soft` on hover) and `outline-danger` (the same in danger) for the rail's positive and destructive actions; `ghost` (muted text, no border, surface-muted on hover) for quiet text actions; disabled is a line fill. Secondary and pill hover to ink on `line-strong`/`surface-muted`, never to terracotta; only their focus ring is terracotta.
- **States**: hover brightness or color shift, global dual-color focus indicator.
- One filled primary per screen. The tab strip's "▶ Run extraction" is positive. While the latest Extraction can still continue, it gives way to "❚❚ Pause extraction" (secondary), "▶ Resume extraction" or "↻ Retry extraction" (positive), or a disabled "Pausing…" or "Stopping…", with an outline-danger "■ Stop" beside it until stopping begins.

### Results rail
- One header in both phases: the status line (a mark, a bold word, a muted rest, then ⓘ Run details and ⋯ More result actions), the count block ("n of m checked" with n at the display size, the review bar, "One by one" and "Save review" ("List" in one-by-one)) and the filter chips (To check · Uncertain · Not reviewable · All; a labelled select at 264px). A completed run's status line says only "Completed": the list shows its records. A filter with no value behind it is not offered, unless it is the one in use. What the researcher rarely needs lives under ⋯: the open value's history, the Template revision the results used, "Open latest reviewed".
- The list of records with flat value rows (glyph · name over value · chip); the selected row's expansion is one tinted surface with a 2px accent edge, no inner card, with one joined Approve | Edit | Reject group. Colour is never the only signal: every state has a glyph and a text equivalent. In Results and on a mark a field's name reads as words in the sans face (`site_name` as "Site name", `fieldWords`); the Template keeps the name as written, in mono. A row shows nothing in a tooltip: the open row shows its name and value whole. How a value was tied to its passage (verifier or rule, page only, passage only, a Catalog value's grounding) waits under "Source details" in the open row and the one-by-one card; an uncertain passage stays in view.
- One by one is the same rail as a card for one value: its record's queue, its Evidence's page, 44px actions with their keys, Up next. "Review one by one" opens on the value already open, else on the first one to check. The rail's own toast docks at its bottom; the Run details drawer covers the rail.
- While an Extraction runs, the list shows the records in the order the Parsing Service reads them under "Reading records · k of n"; a record read is reviewable at once; at settlement the list keeps its place. The Results tab's badge names the run's status; Run, Pause, Resume and Retry share one fixed width and carry no count, and Stop sits beside them.
- The rail and the run button follow one reader per Extraction shown. It reads again 1.5 s after each read while the Extraction is queued, running, pausing or stopping or has a Resume pending, and every 30 s and on window focus once settled. It reads nothing while the tab is hidden and once as it shows again, so a completion toast waits for it.
- A status read cut by the network, a timeout, a rate limit or a server error keeps what is shown, says so and tries again, backing off to 30 s. Any other refusal of the status stops reading until Reconnect (in the rail's banner for the latest Extraction, beside the error for an inspected one) or the researcher's next command. A values read that fails keeps the status current and the last values shown, and says so. The run button's Pause, Resume, Retry and Stop answers only move the shown status forward, and a read follows each of them.
- Collapsing the rail keeps all its work: the selection, one-by-one, drafts, the rail chat, an input edit, an opened cut and an export. Collapsed, it paints no marks or dimming (on the PDF explicitly located Evidence keeps its outline), scrolls nothing and starts no read of the latest values, so the document tab's ring keeps its last progress; work already started finishes, such as a values read in flight, an opened cut's load and its retries, a chat request, an export or a save. History's saved versions are read only while History shows. Expanding in one-by-one scrolls back to its value. Each collapse or expand, also by "Review now", focuses the toggle now shown.
- A value link (`?value=`) selects its value once per arrival, on load or Back onto it, never again on a snapshot switch, and only in its own Extraction. One that arrives while the rail is collapsed waits; expanding then shows it as a click would, and in one-by-one its heading takes the focus, as moving to a value does. When the results shown hold the value and its Evidence, a link scrolls the document to it once: in one-by-one the follow does, except for the value already open or one with only a correction's Evidence. A mark selects its value without scrolling. Marks and dimming are the shown Extraction's only.
- Evidence marks on the page and their Results rows take their top-level field's colour (schema order, cycling eight; the Evidence colour when the field is unknown), never the only signal: a mark's name says the field, and a linked row carries a swatch of the colour beside its name. A block mark that supports values of several fields takes a neutral ink instead of one field's colour. A mark's underline says how its value is linked: solid, dotted for a rule link, dashed for an uncertain passage; the mark's accessible name says the same in words. Review decisions preserve a value's mark colour, fill and underline in both PDF and Markdown; the Results row and mark's accessible name communicate the decision. An accent outline when selected, and only then: the outlined mark shows that one edge and no underline, and the selected value's page draws no second focus border. Every value whose printing is placed also gets a value mark, a fill in its field's colour over the lines where it prints (`valueBoxes`, drawn only when each box lies inside its passage), inside the block mark and never a button; the selected or hovered value's is stronger. Clicking a value mark selects that one value and reveals its row in Results, where a block mark picks among all the values its passage supports; hovering it lights only that row. A block whose every value has a value mark takes no pointer: each value has one pointer target and never a second one under it. It stays a pointer shortcut, not announced: the block mark and the value's Results row are the keyboard's way. A value mark carries its own value's underline, and a block whose every value has one recedes to a faint fill with no underline. A linked value with no value mark says "passage only" in its row.
- An uncertain passage is a link FREE's own check questions: the value is not printed word for word in the passage, or it is also printed in other passages. The row and the one-by-one card head it "Uncertain passage." with the reason in one short sentence; the chip, the filter and a mark's name say "uncertain". (The code keeps the older name, `doubt` and `doubtful`.)
- A strip over the PDF's scrollbar ticks every block mark at its place in the whole document, in the mark's colour and the selected value's in the accent. It takes no pointer, so the scrollbar under it works, and it follows the "Evidence marks" switch.
- An object or list value's parts (nested fields, table cells, list entries) are their own marks, named by their part and drawn by their own link (rule, uncertain passage). Selecting the value outlines all of them; in the open value each part is a button, also in a saved review and while a decision saves, and picking it (or its mark) shows only that part's Evidence, its page, chip and quote, while the decision stays the whole value's and its correction Evidence stays outlined. An edited value's parts are the edit's, and a part keeps the model's link only where the model read the same item at the same path; in an edited list, only an item read once in both, in a list that kept its length. Picking it again, or another value, chooses the whole value. A mark is its Evidence's whole block, never narrowed to a quote (ADR 0029): parts in one passage share its mark, which names each of them.
- Hover links the two sides with one look each: a mark under the pointer lights its values' rows in Results with the neutral `surface-muted` wash (a collapsed record's header for a row it hides), and a row under the pointer lights its marks with a stronger fill. No outline and no coloured edge: those are the selected value's. Hover never selects or scrolls, and it follows the pointer's own movement (`mousemove`), so a mark or a row that scrolls in under a still pointer is not lit. A mark has no browser tooltip: the field's name shows in a small tag over the mark under the pointer once the pointer rests (0.4 s), drawn beside the mark so it takes no pointer.

### Rail chat
- The schema chat docks under every rail tab (ADR 0024): a composer line at rest; sending opens a drawer of 40% of the rail with the conversation; while a card shows, the drawer takes its content's height up to 75% and the conversation scrolls, so the card is never drawn under the composer. Before the first schema the drawer is open by default, since the conversation is the way in.
- The next step is a permission card: a 3px accent left edge, a bold title (a spinner instead of ⏵ while work runs), mono detail rows, an optional notice or error, a question, then numbered options. It sits above the composer whether the drawer is open or collapsed, so the next step is never hidden.
- Options follow §2: at most one green positive, secondary on the surface, danger in red text, and last the way past the step: the chat's composer itself, docked into the card as its last numbered option with the step's hint as its placeholder ("Something else? Say what to do instead…"), so the chat has one field while the card shows. Sending from it is a message of the conversation and sets the step aside; with the card gone the composer returns below the conversation. 1–9 choose (the composer's number focuses it); Esc while the card has focus, or the × at the right of its title, sets the step aside unsaid. A step with no way past it (a running Extraction, a review) has no ×. An answered step folds into the conversation as one line, ✓ title · choice (✓ title · Not yet for Esc).
- Before the first template, an instruction kept for generation is a note, not a turn: a dashed accent box on the right headed "Instruction n of N · for generation", with no reply. A question is a turn, the researcher's bubble and its answer, marked "Question · not used for generation". Each has its ✗ to remove it; counts name instructions ("Generate template (2 instructions)").
- Set aside, the Generate template step folds to its title line rather than leaving: the same accent left edge and ⏵ title, "· 2 instructions" in faint text, and a compact green Generate on the right. The title line brings the whole step back, so the way on is never lost.
- Each finished run stops the chat before anything else goes on. A generation adopted (the first, or one generated again over a template) shows *Template ready*: *View template* (green), *Continue*. A run of this document seen at work and then completed shows *Results ready*: *Open Results* (green), *Continue*, with what is left to check. Viewing keeps the card; Continue, Esc or a typed message ends it, and the chat goes on to its next step. With the view already open, Continue leads.
- Under the chat's header, two workflow lines keep each step's action within reach whatever card shows: a numbered circle (green ✓ once done, a spinner while it runs), the bold step name, its state in muted text, a secondary *View*/*Open*, then its action. *Template*: a green *Generate* before the first template, a secondary circular-arrow icon (drawn, not the ⟳ glyph) to generate it again, which asks first in the same *Regenerate from the document* dialog as the Template view's menu, a red *Stop* while generating. *Results*: *▶ Run* for this document, the same circular arrow to run it again, green once the template exists; none while a run is at work. An action that cannot go yet is disabled and says why in its title. A read-only inspection shows neither action.
- *Clear conversation* is a quiet text control above the conversation (in the drawer's header when it is a drawer), shown once something is said, red on hover, unavailable while a reply or proposal is pending. It asks first in a delete dialog; the template is never touched.
- The card never repeats the tab strip's run controls: a running Extraction's card shows the Results status line and points to Pause, Resume, Retry and Stop above.

### Toast
- Toast — message plus one optional action; float shadow; 8 s when an action is offered, 6 s for some run errors and notices, 2.6 s otherwise. Its timer holds while it is hovered or has focus within, so a researcher reaching its action does not lose it.

### Field Row
- Field row — grip, disclosure, mono name (never truncated: the type and values pills wrap under it when the line is too narrow, and a name longer than the whole line wraps onto more lines), then the worded actions "Edit", "Note" and "Delete" (Delete in danger; no tooltips, their accessible names say which field) as an overlay on the right end of the first line, shown on hover and focus-within and stepping aside while a pill has keyboard focus. Hidden, the overlay takes no pointer hits.
- No pill sits under the actions, so a pointer on a pill always reaches it; only the name may run under them (its full text is its title). A narrow row starts its pills on the line below the name, so they are never squeezed under their own width; at the narrowest (every row at the 264px rail) the actions take their own line below the pills, kept at rest so no row moves under a click. `src/FieldRow.tsx` holds the widths and breakpoints.
- A field's note starts where its name starts.
- The row itself (not the slot above it or its children) is the drop target for "into <group>".

## 6. Motion & Interaction

| Type | Duration | Easing | Usage |
|------|----------|--------|-------|
| Micro | 150-200ms | ease | Button and hover transitions |
| Spinner | 800ms | linear | Running states |
| Entry | 200ms | ease | Toast, review row and sign-in card entry |

### Rules

- Animate only `transform` and `opacity`.
- Every interactive element needs hover and focus-visible treatment.

## 7. Depth & Surface

### Strategy

Mixed but restrained: borders define panes and cards; shadows are reserved for floating overlays, PDF pages, and toasts.

| Level | Token | Usage |
|-------|-------|-------|
| Page | `--shadow-page` | Rendered source document pages |
| Float | `--shadow-float` | Toasts and modal-like overlays |

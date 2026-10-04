# Results review redesign — design

Date: 2026-10-04 · Status: accepted (questions resolved 2026-10-04); supersedes in part
`2026-10-02-view-ordered-streaming-extraction-design.md` and
`docs/superpowers/plans/2026-10-03-view-ordered-streaming-client.md` (§5.5 names
the statements); replaces §8 of `2026-10-02-studio-workspace-redesign-design.md`;
durable decision in `docs/adr/0016-review-drafts-on-a-running-extraction.md` ·
Scope: `prototypes/studio/src`, `prototypes/studio/api`,
`prototypes/studio/shared`, `packages/extraction/src`,
`prototypes/studio/DESIGN.md`

## Purpose

Today's Results rail puts ten blocks of chrome before the first value: the
count "72 to check" appears four times, the same claim counts twice, seven
overlapping words describe the state of a value, three levels of tabs stack
up, the Markdown view sits in the wrong pane, drill-down hides a record from
its children, and every explanation is always on screen. The document only
follows the rail: a passage never selects its value. The streaming spec adds a
second body for a running Extraction with no way to act on what it shows.

After this change the rail has one header in every phase, a list of records
and values that is home, and a "One by one" mode that turns the same rail into
a card for one value at a time. A record can be reviewed as soon as it is read,
while the run goes on. Decisions are a draft until the review is saved; the
settled attempt stays the record of truth for saving and export.

Decided with the researcher on 2026-10-04 (in order): the prototype directions
A (calm rail) and C (focus review) are merged into one rail, "A + C"; the
selected-row expansion is one tinted surface, no inner card, aligned to the
field name column, with one joined Approve | Edit | Reject group; the two
design reviews' items 1–5 are applied (doubtful link as a modifier with the
code's two reasons, the full `claimStates` vocabulary, an explicit warning
before the decision that saves the review, real undo, a keyboard model); the
flow starts with a streamed run; "Extraction can take a really long time, so
user should be able to review the partial values extracted on the go"; the
filter stays "All" at the end of a run to minimise layout drift; and layout
changes from extraction to review are reduced to a minimum. The source of
truth for behaviour and copy is the prototype
[`2026-10-04-results-review-redesign/ReviewFlow.dc.html`](2026-10-04-results-review-redesign/ReviewFlow.dc.html)
(board "A + C · Review while it reads"; its `<script>` is the executable
behaviour model); where this spec goes beyond it, it says so. Beside it: the
diagnosis board `Main.dc.html`, the states board `States.dc.html`, and the two
design reviews under `reviews/`.

## Constraints

- No new dependency. The PDF text layer, pdf.js and the parsed document already
  loaded supply everything the document side needs.
- Tokens and type from `DESIGN.md` and `index.css`: four rail sizes (13 content,
  12 secondary, 11 compact, 10.5 overline) plus one display size, 20px, added
  by §12. No hex colours in components; §12 maps the prototype's colours to
  tokens. No `text-[…px]`.
- Colour is never the only signal: every state has a glyph and a text
  equivalent; every coloured action keeps an icon or a label. Hit targets at
  least 24px. Hover-revealed controls are also revealed by `:focus-within`.
- One filled primary per screen: the tab strip's "▶ Run extraction". Every
  positive action in the rail is green outlined, never filled.
- `src/ui` primitives are used, not mirrored: `Button`, `Pill`,
  `SegmentedControl`, `ModalDialog`, `Toast`, `ProgressBar`, `Overline`.
- Domain language from `CONTEXT.md`: "researcher", never "user"; never "JSON"
  in a researcher-facing label; a link is never a judgement that a value is
  right.
- A candidate is never shown as a value and never gets review controls
  (streaming spec, Constraints). Only a value with an Evidence link in a record
  kei has finished can be decided on.
- The two-second poll stays; no new transport. No change to a workflow's step
  sequence; the server changes (§5.4) are in read and write paths.
- The settled attempt stays the record of truth for saving (finalization) and
  export. What changes is only when a decision may be drafted (§5).
- Base: `origin/dev` after `feat/view-ordered-streaming` (Part A) has merged;
  this spec replaces Part B's client plan where §5.5 says so and is otherwise
  its continuation.

## 1. Vocabulary: two questions, two sets of words

A row answers two questions, with two sets of words that never mix.

**Your decision** (four words; only the first asks for action):

| Word | Glyph | Meaning |
|---|---|---|
| To check | hollow circle, ink-faint | a linked value with no decision yet; the only state that needs the researcher |
| Approved | check, green | |
| Edited | pencil, ink | the reviewed value replaces the extracted one |
| Rejected | cross, danger | the value is removed from the reviewed result |

**Evidence** (the words of `claimStates.ts`, `describeClaimStatus` and
`evidenceCheck`; `Doubtful link` is a modifier on a linked value, never a
state):

| Label | Detail (verbatim) | Source |
|---|---|---|
| Verifier-supported | The verifier linked source evidence to this value. A reviewer still decides whether it is right. | `supported`, `linkedBy: 'verifier'` |
| Linked by rule | A key or structure rule linked this value; no verifier checked it. | `supported`, `linkedBy: 'rule'` |
| + Doubtful link | "Value not found in the linked passage" or "Value also appears in N other passage(s)" | `evidenceCheck` (`verbatim === false`; `lexicalHits > 1`) |
| Unsupported | Every check finished and none found supporting evidence. | `unsupported` |
| Not completed | The check did not finish: {reasons}. | `not_completed`, `reasonText` |
| Excluded by policy | The schema policy “{policy}” asked for no verification. | `excluded` |
| No evidence | This run kept no claim accounting, so whether its checks finished is not known. | populated, no link, `claimStatuses` has no entry (`claims === null`) |
| Contested | Sources disagreed: “{a}” · “{b}”. | `diagnostics.contested` and the value empty, not rejected |
| Missing | No value was extracted. | empty, not contested |

Only linked values (Verifier-supported, Linked by rule) can be To check. The
other seven are **Not reviewable**: listed with their reason, never a decision,
never blocking a save. A document-level field (schema `valueSource:
'document'`) is listed once (§3.1) with the detail "Read once for the whole
document; not verified."

The chip on a row (11px, `--color-ev-ghost` fill) says where and by whom:
`p.{n}`, `p.{n} · rule` (dotted border), `p.{n} · doubtful` (dashed border);
for a Not reviewable value a neutral chip (`--color-surface-muted`) with the
word `unsupported`, `not completed`, `excluded`, `no evidence`, `contested`,
`missing` or `document`. The page is the first page of the link's anchor
(`evidencePages`).

## 2. The rail: one header in both phases

The Results tab body is `aside[aria-label="Results"]`: a header (§2), then the
list (§3) or the one-by-one card (§4), then the rail's own toast slot (§2.5).
The header has the same three parts while a run reads and after it settles.

### 2.1 Status line

One 28px line: a mark, a bold word, a muted rest, and at the right the
"Run details" button (ⓘ, `aria-expanded`) and "More result actions" (⋯). Copy,
by state (the `ExtractionState`, the attempt and the review controller decide
which):

| State | Mark | Copy |
|---|---|---|
| starting (request in flight) | spinner | **Starting** |
| queued (`QUEUED`) | spinner | **Queued** · waiting for the extraction worker |
| running, no partial yet | spinner | **Starting** · finding records… |
| running, Catalog | spinner | **Reading records** · {finished} of {discovered} · from page {startedAtPage} (the last clause only when a start page is known) |
| running, Article | spinner | **Reading the document** · {contextsAnswered} of {contexts} contexts |
| stopping (`cancellationRequested`) | spinner | **Stopping** · the run ends after the current call |
| cancelled | cross, ink-muted | **Stopped** · nothing to review |
| failed | cross, danger | **Failed** · nothing to review — then the failure message on a second line, and "Show details" (opens the drawer) |
| completed, not reviewed | 8px green dot | **Completed** · Catalog · {n} records · [Schema rev {r}] (Article: **Completed** · Article · [Schema rev {r}]; `n === 0`: · no records found) |
| completed, not all of it (`complete === false`) | 8px stale dot | **Completed, not all of it** · [Why?] (opens the drawer's Extraction section) |
| review saved | check, green | **Review saved** · {n} decisions · read-only (the date in its `title`) |
| historical attempt (`inspectedAttempt`, `readOnly`) | as the attempt | the attempt's own line; the snapshot `<select>` and "Open latest reviewed" (`headerExtras`) sit before ⓘ |
| previous schema | as the attempt | the attempt's own line plus `Pill tone="stale" outline` "Rev {r} · current is {c}", and a note line "This review applies to Schema revision {r}. Run extraction again to use revision {c}; this review stays saved." |

"Schema rev {r}" is a text button (`--color-accent`) that opens the drawer at
its Schema section. A second, transient line below the status line (`role=
"alert"`, stale-soft notice) carries, one at a time: the monitor error
(`MONITOR_DISCONNECTED` or `EXTRACTION_UNAVAILABLE` text) with "Reconnect"; a
cancellation failure "Cancellation failed: {message}". Source truncation is
reported apart from processing: with `unified.sourceEndEntries.length > 0` the
Extraction section of the drawer and the "Completed, not all of it" note say
"{k} record(s) cut off where the supplied source ends, so some of its values
may be missing." A result that is complete but has a cut entry keeps
**Completed** and shows that note only in the drawer.

### 2.2 Count block

Below the status line, left: a 20px display number and the word "to check",
then the review bar; right: the two actions. Then the breakdown line.

- **Number**: the To check count over every readable record (§5.1): during a
  run, the read records so far; after settlement, all. In the saved and
  read-only states the number line is replaced by "Read-only. {k} value(s)
  without a link were not part of the review." (omitted when `k === 0`).
- **Review bar** (`role="img"`, `aria-label="{a} approved, {e} edited, {r}
  rejected, {t} to check, of {required}"`): 8px, three segments (green, ink-
  muted, danger) over `--color-line`, widths as fractions of `required` (the
  linked values of readable records). It is empty before the first record is
  read.
- **Actions**, always present, 32px, right-aligned (list mode):
  - `Button` "One by one" (list icon): disabled with `title` "Available once a
    record is read" until a record is readable, and "Nothing left to check
    here" when the To check count is 0.
  - `Button variant="outline-positive"` "Approve rest…" (`aria-expanded`):
    disabled with `title` "Available when the run finishes" while the run
    goes on, and without a title when the count is 0. Opens §3.6.
  - When the count is 0 and the review is not saved and `canAccept`, "Approve
    rest…" is replaced by `Button variant="outline-positive"` "Save review"
    (§6).
  - In one-by-one mode the two are replaced by one `Button` "List ⎋"
    (`aria-label="Leave one-by-one review, back to the list"`), same slot.
- **Breakdown line**, 11px ink-muted, tabular numbers: "{a} approved · {e}
  edited · {r} rejected · {state}" where state is one of "draft until the run
  finishes" (running), "Saving draft…", "draft saved", "Draft not saved ·
  [Retry draft]", "The review changed elsewhere · [Reload server review]"
  (`REVIEW_DRAFT_CONFLICT`), "Saving review…", "Review not saved · [Retry]"
  (`review.error`), "saved". It is `aria-live="off"`.

### 2.3 Filter chips

A `role="group" aria-label="Show values"` row of four 28px chips
(`aria-pressed`), present from the moment the run starts: **To check**
(uncounted; the count is above), **Doubtful {n}**, **Not reviewable {n}**,
**All**. Default **All**, during and after the run; settlement never changes
the filter, the selection or the scroll position. Counts are over readable
records and grow as records are read (resolves the prototype's run-final
numbers). The chips are hidden in one-by-one mode and come back with the same
value on "List". In the saved state the chips stay.

### 2.4 Tab ring, badge and run button

- The document tab in `DocumentTabBar` carries an 18px ring: a `--color-line`
  track and a green arc of (approved + edited + rejected) / required; its
  `aria-label` is "{document}, reading records, {k} of {n}" during a run and
  "{document}, {t} values to check" otherwise ("{document}, review saved" when
  saved).
- The Results tab badge reads "running" before discovery, "{k} of {n}" during
  a run (the streaming spec), "{t} to check" after, nothing once saved
  (`resultsBadgeFor`).
- "▶ Run extraction" and "■ Stop extraction" share one fixed `min-width`
  (172px) and tabular numerals, so the strip never shifts; the Stop button
  carries no count (§5.5 replaces the client plan's appended `badge.label`).

### 2.5 The rail's toast

A `Toast` docked at the bottom of the rail (`position: absolute; left: 12px;
right: 12px; bottom: 12px`), one at a time, with at most one action: "Undo ⌨Z"
or "Review one by one". Eight seconds with an action, 2.6 s without, held while
hovered or focused (DESIGN.md). It paints above the list and the card, below
the drawer. App's own completion toast ("✓ Extraction complete — review it in
the Results tab" · "Review now") is shown only when the rail is not open on
Results; otherwise the settlement toast of §5.3 is the one notice.

## 3. The list

The body is the list: a `--color-canvas` scroll region of record sections
(`section[aria-label="{label}, {state}"]`, `--color-surface`, hairline border,
8px radius) in list order (§3.1). Before discovery it holds one block "Finding
the records in the source…" with a spinner and two skeleton lines (the one
unavoidable change: this block becomes the list).

### 3.1 Records

- **Order**: during a run, the partial's order (nearest the start page first,
  then source order; the client never re-sorts). At settlement the list keeps
  that order while the workspace stays open; a reopened document lists the
  settled records in source order. The record index is the React key in both
  phases, so settlement moves nothing.
- **Header** (a `button[aria-expanded]`, 38px): disclosure, **{label}** (13px
  bold), "Record {i} · p.{page}" (12px muted), then at the right one of:
  spinner + "Reading…", spinner + "Checking {n} values", "Queued", "{t} to
  check" (tabular), or check + "all checked". `label` is kei's entry label
  (`PartialRecord.label`), kept after settlement while open; otherwise the
  record's first populated string field (the `ResultValue` preview rule), else
  "Record {i}". `page` is the partial's page, or the first page of the record's
  first Evidence (today's `RecordHeader` rule).
- **Open by default**: during a run, a record opens when it is being read or
  read (its values arrive into view); after a reopen, the first record with a
  To check value is open and the rest are collapsed. The researcher's toggles
  are remembered for the session.
- **Document section**: document-level fields render once, above the records,
  in a section labelled "Document" with no page and no count.
- **Article** (Record Scope `document`): there is one record and no record
  section: its rows render flat in the body, no header, and §4 has no record
  level (its progress reads "{k} of {n}").
- **Empty Catalog**: the body shows the empty state "No records were found in
  the source." and the count block "0 to check" with "Save review" (§6).
- **Filtered-out record**: a record none of whose rows pass the filter shows
  its header and the line "Nothing in this record for this filter."

### 3.2 Rows

Every leaf value of a record is one row, flat (no drill-down, no nested
sections); its name is the relative path joined by " › " with 1-based indexes
("grave_goods › 1 › description"). A row is
`button[aria-expanded][aria-controls]` on a three-column grid (18px glyph ·
name over value · chip), 6px/8px padding, 6px radius, accent-ghost on hover:

1. **Glyph** (16px): the decision glyph (§1) for a linked value; for a Not
   reviewable value a dashed circle, for Missing a dash, for Contested a
   branch; its text equivalent is a visually hidden span "{To check | Approved
   | Edited | Rejected | Unsupported | …}".
2. **Name** (11px mono, ink-faint) above the **value** (13px, weight 500,
   clamped to two lines with the full text in `title`; "No value" for a
   missing or contested value; the reviewed value when edited).
3. **Chip** (§1), 22px, never a hit target.

Rows during a run (§5.2) use the same grid: a reading value shows a pulsing
skeleton bar in the value slot (`aria-label="Reading"`), never text; a checking
value shows the candidate in ink-faint italic with a small spinner glyph, the
`title` "Candidate · being checked against the source" and the word
"checking" in the chip slot. Placeholder and checking rows have the review
row's height (a two-line name-over-value slot), so a record does not jump when
its values settle.

A selected row that the current filter would hide stays pinned in place with
the italic note "outside the current filter" under its value.

### 3.3 The selected row

Clicking a row selects it (one selection; clicking again deselects); the row
gets a `--color-accent-ghost` surface and a 2px inset `--color-accent` left
edge (terracotta marks selection), its chip stays, and its expansion opens
below the name column (padding-left 34px), with no inner card, in this order
(each part only when it applies):

1. "Extracted value: ~~{extracted}~~" (12px muted, the extracted value struck
   through) when the decision is Edited.
2. **Source line** (11px semibold, evidence file icon): "p.{n} ·
   Verifier-supported" or "p.{n} · Linked by rule; no verifier checked it",
   prefixed "Evidence for the extracted value · " when the decision is Edited
   or Rejected. With `precision: 'input'` it ends " · located to the whole
   page only"; with `'cell'`, " · a table cell".
3. **Quote** (13px serif, `--font-serif`, wraps): the anchor's block text
   (§7.1), with the value's occurrence as `<mark>` (`--color-ev-soft` fill,
   2px `--color-ev` bottom border; dotted for a rule link, dashed for a
   doubtful one). No quote for an `input`-precision link.
4. **Reason line**, only when there is something to explain: "**Doubtful
   link.** {reason}." (evidence icon) for a linked value, hidden once the
   decision is Edited or Rejected (`evidenceCheck`'s rule); for a Not
   reviewable value its label, its detail (§1) and the muted line "Not part of
   the review. It stays in the result and the export as extracted."
5. **Last-value warning** (`--color-surface-muted` box) when this is the last
   To check value and the review is not saved: "This is the last value to
   check. Your decision saves the review, and the review becomes read-only."
6. **Actions** for a To check value: one joined group (`role="group"
   aria-label="Decision for {name}"`, hairline border, 6px radius, 30px) of
   "Approve" (green check icon), "Edit" (pencil), "Reject" (danger cross),
   colour only on the icons; at the right a quiet `Button variant="ghost"`
   "Review from here" (enters §4 at this value). When the warning shows, the
   labels read "Approve and save review" and "Reject and save review".
7. For a decided value, not saved: "{Approved | Edited | Rejected}" (12px
   semibold) and a ghost "Undo" (§3.4). Saved: "{word} · saved".
8. Editing (§3.5) replaces 6–7.

Selecting a row navigates the document to its Evidence (§7.2). Escape
deselects nothing in list mode (§4.4 gives Escape's order).

### 3.4 Decisions and undo

- A decision is `review.setDecision(path, action, value)`: it marks the path
  touched and saves the draft as today (`updateReview`). Every decision, bulk
  included, is an explicit decision in the draft.
- Each decision pushes an entry `{ pathKey, before: { action, reviewedValue,
  touched } }` on a session history (`reviewHistory.ts`). Undo pops the last
  entry and restores decision and value (`setDecision` with the previous
  action and value, untouched when it was untouched). The toast after a
  decision is "{Approved | Edited | Rejected} {name}." with the action "Undo
  ⌨Z". The row's own "Undo" and the card's "Undo this decision" return that
  value to To check and push an entry too, so Z can undo the undo.
- Undo is unavailable once the review is saved (nothing is offered).
- After a decision in the list, focus moves back to the row; after an undo, to
  the restored row, which becomes the selection.
- The live region (§11) says the delta: "Approved sheet." · "Undone. sheet is
  to check again." · "sheet is to check again."

### 3.5 Edit

- "Edit" (or E in §4) opens, in the expansion, the label "Reviewed value" and
  the typed editor of `ResultValue`, extracted to `ui/ReviewedValueEditor.tsx`:
  a `<select>` for `allowedValues` and booleans, `type="date"` for dates,
  `type="number"` (step 1 for integers), text otherwise; a list of scalars as
  comma-separated text. The input takes focus. Below: the joined group "Save
  edit" (green check; "Save edit and save review" for the last value) ·
  "Cancel", and the hint "Enter saves · Esc cancels".
- Save parses with `parseReviewedValue`; an error shows beside the input
  (`role="alert"`) and keeps editing. An empty value is refused with "Enter a
  value." (so there is no empty-string override: to remove a value, Reject).
- Selecting another row, leaving one-by-one or starting a run cancels an open
  edit without saving (no silent save on blur). "Approve rest…" is disabled
  while an edit is open.
- An edited value shows its reviewed value in the row and the card, the
  "Extracted value" line, the source line prefixed "Evidence for the extracted
  value", and no doubtful line.
- "Edit field {name} in the schema…" lives in the ⋯ menu (§8) and is enabled
  only with a selection; it calls `onEditField(nodeId, path)` as today.

### 3.6 Approve rest…

A `ModalDialog` (`aria-label="Approve the rest and save the review"`, focus
returned to the button): title "Approve the {t} values still to check and save
the review?"; scope "{t} values across {m} records, including {w} with a
doubtful link." (one record: "{t} value(s) in {label}, including {w} with a
doubtful link. The other {m} records are already checked."; `w === 0` drops
its clause); the note "Filters don’t limit this. Your edits and rejections
stay as they are. Saving makes the review read-only, so this can’t be undone.";
with an edit open, the danger line "Finish or cancel the edit in progress
first." and a disabled confirm; buttons `Button variant="outline-positive"`
"Approve {t} and save review" · "Cancel". Confirm runs `review.approveAll()`
then `review.accept()` (§6); the toast "Approved {t} values. Review saved; it
is now read-only." has no undo.

## 4. One by one

### 4.1 Entering and leaving

"One by one" (header), "Review from here" (a row), the settlement toast's
"Review one by one" or the end card's "Continue with record {i}" enter the
mode; "List", Escape (§4.4) and "Back to list" leave it. Entering starts at
the named value, else at the selected row if it is To check, else at the first
queue item. Leaving selects the value that was current, restores the filter,
the chips and the scroll position of the list, and moves focus to that row.
Entering and leaving are in place: the header stays, the body swaps.

### 4.2 The queue across records

The queue is every To check value of every readable record, keyed by its full
result path (`resultPathKey`), ordered by record (list order, §3.1) and
within a record doubtful links first, then schema field order. It is recomputed
on every change: a decision removes its item, an undo restores it, a record
read during a run appends its items (§5.1), settlement adds what settlement
changed (§5.3). Position is per record and global: the card's first line is
the record's queue (24px squares with the decision glyphs, `ol[aria-label=
"Record {i}, values in review order"]`, the current one `aria-current="step"`
with a 2px accent outline) and the text "Record {i} of {m} · {j} of {k} in
this record"; the global count stays in the header only.

Steps: **next** (J, or auto-advance after a decision) is the next undecided
item after the current one in queue order, wrapping within the record, then
the next record with an undecided item; **previous** (K) is the previous item
in the record's queue, decided or not. "Skip for now" (J on an undecided
value) postpones: the value stays To check and comes back after the others.
Revisiting a decided value shows "{Approved | Edited | Rejected}" with "Undo
this decision" instead of the actions, and "Next to check ⌨J".

### 4.3 The card

The body (`--color-surface`, 14/16px padding) holds, top to bottom:

1. The record queue line (§4.2).
2. Breadcrumb "Record {i} · {label} › {name}" (12px mono, ink-faint); the
   **value** as `h2[tabindex="-1"]` (20px display, bold) — or, when editing,
   the "Reviewed value" editor at 40px; then "Extracted value: ~~…~~" when
   edited.
3. `figure`: the source line as `figcaption`, the quote as `blockquote`
   (13px serif, line-height 1.6).
4. For a doubtful link: a dashed `--color-ev` box "**Doubtful link.** {reason}.
   Check that this is the right passage."; for the last value, the warning of
   §3.3 item 5.
5. Actions for an undecided value: a 44px `Button variant="outline-positive"`
   spanning the width, "Approve and next ⌨A" ("Approve and save review" for
   the last value), then "Edit ⌨E" and "Reject ⌨R" (outline-danger) in two
   columns. Editing: "Save edit and next ⌨↵" ("Save edit and save review") ·
   "Cancel ⌨Esc". Decided: the `--color-surface-muted` bar "{word}" with
   `Button` "Undo this decision".
6. "⌨K Previous" · "Skip for now ⌨J" (or "Next to check ⌨J").
7. Overline "Up next": the next three queue items as "{name} · {value}" with a
   tag "doubtful link", "linked by rule" or "p.{n}"; or "Nothing else to check
   after this one."

After every step (decision, undo, J, K, a queue square, a click on a page
mark) focus moves to the value heading; the live region says "{word} {name}.
{t} to check. Next: {name}, {value}." The document focuses the value's
Evidence (§7.2, §7.3).

### 4.4 Keyboard model

A `keydown` handler on the rail container; keys act only while focus is within
the rail, never on `repeat`, never with a modifier, and never while typing
(`input`, `textarea`, `select`), except Enter, which saves an open edit, and
Escape:

| Key | Action |
|---|---|
| A | approve the current value (one-by-one, undecided) |
| E | edit it |
| R | reject it |
| J | skip / next to check |
| K | previous |
| Z | undo the last decision (both modes, while the history is not empty and the review is not saved) |
| Enter | save the open edit |
| Escape | the first that applies: cancel the open edit → close the Approve rest… dialog → close the Run details drawer → close the ⋯ menu → leave one-by-one; otherwise nothing |

While nothing is readable (§5.1) only Escape is handled. The `kbd` badges on
the buttons show the keys; they are decoration (`aria-hidden`).

### 4.5 End cards

Replace the card when the queue is exhausted:

- **Record checked**: check (40px, green), "{label} is checked", a line, and
  `Button variant="outline-positive"` "Continue with record {i}" (the next
  record with a queue item; disabled when none) · `Button` "Back to list". The
  line reads, after settlement, "{t} values are left to check in {m} more
  records."; during a run, "You’re caught up with what is read. {t} more
  values are read in other records; {k} record(s) is/are still being read,
  and their values join this queue as each one finishes." (the first clause
  only when `t > 0`).
- **Caught up** (during a run, no record has a queue item): the same card
  with the title "You’re caught up" and no Continue; when a record is read
  with a To check value, "Continue with record {i}" appears and the live
  region says "{label} read: its values can be reviewed now."
- **Review saved**: check, "Review saved", "{a} approved, {e} edited, {r}
  rejected. The review is now read-only. Values that aren’t part of the review
  stay as extracted.", `Button` "Back to list".

## 5. Review during a run

This section is the superseding decision. The streaming spec (Constraints)
said review, finalize and export read the settled attempt only and the partial
view offers no review controls. The researcher overruled it on 2026-10-04:
"Extraction can take a really long time, so user should be able to review the
partial values extracted on the go." The settled attempt stays the record of
truth for saving and export; a decision may now be drafted on a record the run
has finished.

### 5.1 What is reviewable when

- A **readable record** is a partial record with `state === 'finished'`
  (kei published its entry), or any record of a settled result. Its grounded
  values (`PartialValue.state === 'grounded'`, i.e. a link exists) are To
  check; its other values are Not reviewable (§1: a null leaf is Missing or
  Contested; a populated leaf without a link in a finished record is "No
  evidence" until settlement names its claim state).
- A value in state `reading`, `checking` or `queued` never gets a glyph, a
  chip of §1, an expansion, a queue item or a keyboard action.
- Article: links arrive only once every context is answered (Part A); until
  then nothing is readable, and the header counts contexts. From the first
  grounding batch the document is readable like one record.
- Decisions during a run are a draft (§5.4); the review cannot be saved until
  the run settles: `canAccept` is false, "Approve rest…" is disabled with
  "Available when the run finishes", the last-value warning never shows, and
  the breakdown reads "draft until the run finishes".
- Prepared decisions for a readable record are built on the client from the
  partial's links and the pinned document, in `prepareReview`'s shape: one
  `{ resultPath: link.resultPath, evidenceAnchorId, reviewedOccurrenceIds:
  every occurrence of that anchor, action: 'APPROVED', reviewedValue: null }`
  per link whose anchor the pinned document has. `useExtraction` takes a new
  option `occurrenceIdsByAnchor: ReadonlyMap<string, readonly string[]> |
  null` (App derives it from `parsedDocument` with `anchorOccurrences`). A
  link whose anchor is not in the pinned document gives no decision and its
  row is Not reviewable with the detail "Its Evidence is not in this
  document."
- The controller's `review.decisions` during a run are those prepared
  decisions, overlaid with the stored draft the read response carries (§5.4);
  `touchedPaths` are the draft's paths. `reviewAvailable` keeps today's settled
  rule; a new `review.draftAvailable` is true while the attempt is RUNNING on
  the current Source Representation and at least one record is readable.

### 5.2 The streamed run in the rail

The header's status line and count block are §2; the list is §3 with these
run-time rules (the prototype's `stageAt`/`tick` model):

- Before discovery: "Finding the records in the source…" (§3). On discovery
  the live region says "{n} records found. Reading from page {p}."
- Each record section shows "Queued" (collapsed, no rows), "Reading…" (rows as
  placeholders: the pinned schema's record-level fields, client plan Ruling
  2), "Checking {n} values" (candidates muted), then "Read · {n} values"
  becomes "{t} to check" and its rows are review rows. The live region says
  "{label} read: its values can be reviewed now." for the first readable
  record and "{label} read." for the rest.
- Values arrive with a 200ms entry fade (`transform`/`opacity` only; none
  under `prefers-reduced-motion`). Highlights draw on the page as links
  arrive, never scrolling the viewer (client plan Ruling 3).
- A partial never regresses (`retainFinished`); a read with no partial keeps
  what is shown; a reconnect continues from the monitor's partial.
- Stop: "■ Stop extraction" → the status line "Stopping · …"; keys and
  decisions are still allowed on readable records until the attempt settles;
  a cancelled or failed attempt has no result: the body shows "Stopped ·
  nothing to review" / "Failed …", the draft is never read again, and the
  rail toast says "Run stopped · your {d} decisions on it are discarded"
  (`d > 0` only).

### 5.3 Settlement

At the terminal read the settled attempt replaces the partial in the same
list (§3.1: same keys, same order while open; the record header's spinner
becomes the count). Nothing else moves: filter, selection, scroll and an open
record stay; the only unavoidable change is a record dropped by the artifact
(an entry refused at the end) disappearing.

Reconciliation, per draft decision: it is **kept** when the settled result has
an Evidence link at the same result path with the same `evidenceAnchorId` and
the settled value equals the value the decision was made on; otherwise the
value returns to To check and its row and card show the stale-ink note
"changed after you reviewed it" until it is decided again or the document is
reopened. The anchor rule is the server's (§5.4, `dropped`); the value rule is
the client's for the session: the controller keeps, per decision made during
the run, the value it was made on (`decidedOn: Map<pathKey, unknown>`) and
compares at settlement. (A published entry is write-once, so a value changing
under the same anchor is not expected; the value rule guards the view, and
the draft contract does not grow a field for it.)

The rail toast at settlement: "Run finished · your {d} decision(s) kept · {t}
to check." with the action "Review one by one" (`t > 0`, not already in
one-by-one); the "your … kept" clause only when `d > 0`; when some decisions
were not kept, " · {c} changed after you reviewed them" is appended. The live
region says the same. With `t === 0` and `d > 0`: "Run finished · your {d}
decisions kept · nothing left to check." and the count block offers "Save
review" (§6); settlement itself never saves the review.

After settlement the server's read response carries `pendingReviewDecisions`
and `reviewDraft` as today; `recoverReviewDraft` restores the kept decisions;
`reviewDraft.dropped` paths are marked "changed after you reviewed it".

### 5.4 Server: drafts on a running Extraction

- `saveStoredReviewDraft` (`postgres-reviews.ts`): the version predicate stays;
  the `reviewable: true` predicate becomes "reviewable, or not yet settled
  (`outcome IS NULL`)". `resetStoredReview` is unchanged (reset needs a
  settled, reviewable Extraction).
- `module.saveReviewDraft`: on an Extraction with `outcome === null` (running
  or queued) the draft is validated against the pinned document and the
  pinned Schema Revision only, never against kei's progress (a best-effort
  view that may be absent): every decision must carry a non-null
  `evidenceAnchorId` that names an anchor of the pinned document,
  `reviewedOccurrenceIds` equal to every occurrence of that anchor, a result
  path under `records`, `reviewDecisionMatchesSchema` and
  `correctionEvidenceIsPublished`; duplicates and a negative or unsafe version
  are refused as today (`invalid_review`, "Draft decisions do not match the
  pinned document and schema."). A settled Extraction keeps today's rule
  (prepared decisions from the settled Evidence).
- `module.readReviewDraft` on a settled, not finalized Extraction returns
  `decisions` = the stored decisions whose `(resultPath, evidenceAnchorId)`
  match a settled Evidence link, or are optional decisions as today, and
  `dropped` = `[{ resultPath, evidenceAnchorId }]` for the rest. Nothing is
  rewritten; the next draft save replaces the stored draft, after which
  `dropped` is empty. `extractionReadResponseSchema.reviewDraft` gains
  `dropped: z.array(z.object({ resultPath, evidenceAnchorId }).strict())
  .optional()`.
- `read()` (`api/extractions.ts`) returns `reviewDraft` for a RUNNING attempt
  too (the stored draft, no `attention`); `pendingReviewDecisions` stays null
  until COMPLETED. `partial` as today.
- `reviewDraftVersion` continues across settlement (`settleExtraction` does
  not touch it); a draft save that races settlement succeeds under either
  predicate and is reconciled on the next read.
- Finalization is unchanged: the settled, reviewable attempt and its Evidence
  (`reviewAuthority`); a draft decision the reconciliation dropped is never
  submitted. `extractionAttemptSchema` keeps `reviewable: false` while the
  attempt runs.
- The draft of a failed or cancelled Extraction is never read (the row is not
  reviewable and not running) and is garbage with the attempt.

### 5.5 Statements this spec replaces

- Streaming spec, Constraints, second bullet: "The settled attempt stays the
  record of truth. Partial results are a view of files kei already writes;
  review, finalize and export read the settled attempt only." → "The settled
  attempt stays the record of truth for finalization and export. A decision on
  a record kei has finished may be drafted while the run goes on and is
  reconciled at settlement (results review redesign §5)."
- Streaming spec §1, last paragraph of the table's section ("When the attempt
  settles, the settled result replaces the partial view in place …") → the
  one list of §3.1 and §5.3.
- Client plan, Global Constraints: "The settled attempt stays the record of
  truth: review, finalize and export read it only; the partial view offers no
  review controls (no `review` prop on its `ResultValue`s)." → removed; §5.1
  governs.
- Client plan, Task 2: `PartialResults.tsx` and its doc comment "No review
  controls: the settled attempt is reviewed." → not built; the one list of
  §3 renders both phases. Ruling 7 ("two components; the records' order
  changes once, from reading order to source order") → one component, order
  kept while open (§3.1).
- Client plan, copy ` · started at page {n}` → ` · from page {n}`; the run
  button appending `badge.label` (Task 2, Step 5 note; Task 3's assertion
  `toContainText('2 of 5')`) → no count on the button (§2.4).
- Client plan, Task 4's DESIGN.md line → §12's wording.
- Workspace redesign spec §8 ("Results tab": header, summary chips, review
  progress, the Review | Values as code | Markdown control, `ReviewAttention`
  rows) → §2, §3 and §8 of this spec. Its decisions on the built UI (an
  8px accent dot for "to check", no Evidence or Check pills, the "Doubtful
  links: N" chip) are carried into §1 and §3.2 as the glyph, the chip and the
  Doubtful filter.

## 6. Saving the review

The current product rule stays: the decision that leaves nothing To check
saves the review and makes it read-only, and the UI says so before that
decision (§3.3 item 5, §4.3 item 4, the labels "… and save review"). Rules:

- Saving (`review.accept`) is triggered only by a researcher's action: the
  decision that empties the queue, "Approve {t} and save review" (§3.6), or
  the "Save review" button. It is never triggered by an effect on state (the
  `useEffect` in `ResultsTab.tsx` that calls `accept()` whenever `canAccept`
  is removed): settlement, a draft recovered on reload and a reconnect never
  save by themselves.
- `review.setDecision` answers `{ last: boolean }`; the tab calls `accept()`
  when `last` and `canAccept`.
- "Save review" (§2.2) appears when the To check count is 0, the review is
  not saved and `canAccept`: after a reload with a complete draft, after
  settlement with every value already decided (§5.3), for a result with no
  linked values (today's "No grounded values" case), and for an empty Catalog.
  Its toast: "Review saved. It is now read-only."
- While saving: the breakdown reads "Saving review…", every decision control
  is disabled, keys are ignored. On failure: "Review not saved · Retry"
  (`role="alert"`), decisions stay editable.
- The alternative (an explicit "Save review" always, no auto-save) was
  declined (Resolved questions, 1).

## 7. The document side

### 7.1 From a link to rectangles

- A link names an Evidence Anchor; the pinned document's `evidence_index`
  gives the anchor's `producer_observations`, each a page and a bbox in page
  points (`anchorOccurrences`, `verifiedEvidenceBbox`). A text anchor is one
  block; a `table_cell` anchor is one cell. The mark is the occurrence's bbox
  scaled to the rendered page, as today's overlays are.
- Precision: a `cell` or `segment` link draws its mark; an `input` link draws
  nothing, navigates to the anchor's page and says "located to the whole page
  only" (§3.3). A link whose anchor is missing from the document draws
  nothing and its row says "Its Evidence is not in this document."
- The quote (§3.3) is the anchor's text: for a text anchor the block's `text`
  (heading, paragraph, text, list items joined, caption); for a cell anchor
  the cell's `text` with the row's cells joined by " · ". The marked span is
  the first case-insensitive occurrence of `grounding.raw`, else of the
  extracted value's text; when neither occurs (a `verbatim === false` link)
  there is no `<mark>` and the doubtful line explains. A quote longer than
  four lines is clipped to the two lines around the mark with "…" at the cut.

### 7.2 Selection in both directions

- Marks: every link of the inspected attempt (settled) or of the partial's
  finished records (running) is painted on its page while the Results tab is
  active: `--color-ev-ghost` fill with a 2px `--color-ev` bottom border;
  dotted for a rule link, dashed for a doubtful one; a decided value's mark
  keeps a 1px border and no fill; the selected (or current) value's mark has
  a `--color-ev-soft` fill and a 2px `--color-accent` outline. One colour for
  Evidence (DESIGN.md: evidence blue for evidence marks only); today's
  per-field colours go. The "Evidence marks" switch in the document toolbar
  (`aria-pressed`) hides all but the selected mark.
- A mark is a `button` (`pointer-events: auto`), `aria-label="{name}:
  {value}"` (", {Approved | …}" when decided), `aria-current="true"` when
  selected. Clicking it selects that value in the list (scrolling the rail to
  its row, opening its record) or, in one-by-one, makes it current. When
  several values share one anchor, the click opens a small popover (`role=
  "dialog"`, `aria-label="Values in this passage"`) listing "{name} · {value}"
  buttons; Escape closes it.
- Selecting a value in the rail scrolls the viewer to its first occurrence
  (today's `scrollOverlayIntoView`); selecting through a mark scrolls
  nothing; links arriving during a run scroll nothing (§5.2). A focused mark
  survives a poll of the same Extraction and clears for another one.
- "Copy link to the selected value" (§8) writes the document URL with
  `?value={resultPathKey}` (URL-encoded); opening such a URL selects that
  value once the attempt is loaded.

### 7.3 Dimming in one-by-one

Only in one-by-one, only for the current value, only when its link has `cell`
or `segment` precision and a bbox: the page carrying the occurrence gets a
page-sized overlay in `--color-canvas` at 45% opacity (the page reads through
at .55), cut out around the occurrence's bbox expanded by 24pt on each side
(four rectangles); other pages are not dimmed; the overlay takes no pointer
hits. Leaving one-by-one removes it. The Evidence marks switch does not affect
it.

### 7.4 PDF | Markdown

The document toolbar gains a `SegmentedControl` "PDF | Markdown"
(`aria-label="Document view"`) at its right, after the "Evidence marks"
switch. Markdown renders today's parsed Markdown (`documentMarkdown`) in the
document pane as a page-shaped `<pre>` (mono 12px); with none, "Markdown
unavailable · Parsed Markdown has not been received for this source
document." Marks in the Markdown view are text spans at the anchor's
`markdown_span`, same styles; selection works both ways as in §7.2. The
Results tab's own Markdown panel is removed.

## 8. Run details drawer and the ⋯ menu

**Run details** (ⓘ, and the "Schema rev {r}" and "Why?" links) opens a panel
covering the rail (`role="dialog"`, `aria-label="Run details"`, not modal:
Escape closes, focus moves to its heading on open and returns to the opener
on close), with a 44px header "Run details" · close (`aria-label="Close run
details"`) and these sections (overlines):

- **Extraction**: "{Completed | Completed, not all of it | Failed} · {Catalog
  | Article} strategy · {n} records found"; "How many records the source
  holds is not measured, so a missing record would not show here."; the
  source-end note (§2.1); then today's `CatalogReview` or `RecipeReview`
  content (unresolved ranges, failed calls, proposed and rejected candidates,
  conflicts, partial lists), moved here unchanged.
- **Schema**: "Revision {r} · {the current revision | current is {c}}" and
  "View schema used", which expands today's read-only used-schema preview.
- **Evidence · {claims} claims**: "{v} verifier-supported · {l} linked by rule"
  · "{w} of the linked values have a doubtful link: the value isn’t found in
  its passage, or is found in other passages too." · "{u} unsupported · {nc}
  not completed · {x} excluded by policy" · "Linked by rule: a key or structure
  rule linked it, and no verifier checked it. A link is never a judgement that
  the value is right; that is your decision." · today's "Checks not completed
  ({k})" list with "Show {field}" buttons. Without a claim accounting: "This
  run kept no claim accounting." and the counts of linked values only.
- **Review**: "{a} approved · {e} edited · {r} rejected · {draft until the run
  finishes | draft saved | review saved, read-only}" and "The review saves
  itself, and becomes read-only, once every linked value has a decision.
  Values that aren’t linked never block it."
- **Method**: today's `MethodUsed` and the technical diagnostics
  (`ExtractionDiagnostics`) behind "Show the method used".

**More result actions** (⋯, `role="menu"`): "Export…" (today's export dialog;
hidden here once the review is saved, when "Export…" is a `Button` in the
status line), "Values as code" (the body shows the reviewed result as code in
today's `<pre>` with a "Back to review" link above it), "Copy link to the
selected value" and "Edit field {name} in the schema…" (both disabled with the
title "Select a value first" without a selection). The Review | Values as
code | Markdown tab row is removed.

## 9. Narrow widths

- **344px rail**: the status line keeps its mark, word, "{n} records" and the
  two icon buttons; "Catalog ·" and the schema link drop (the drawer has
  them). The count block's actions fit beside the number when both fit at
  their natural width; otherwise they wrap under the bar, full width, in one
  row. Chips stay one row (the overflow scrolls horizontally, no wrap). Rows
  keep the glyph and the chip; the name sits above the value, so nothing is
  squeezed. The expansion's decision group stays on one line; "Review from
  here" drops to its own line when the row is narrower than 300px.
- **264px rail**: the chips become one labelled `<select>` "Show" (To check ·
  Doubtful ({n}) · Not reviewable ({n}) · All); "One by one" and "Approve
  rest…" (or "Save review") each take a full-width line under the bar. The
  expansion aligns to the name column (18px + 8px indent); the decision group
  wraps to its own row; the quote wraps. In one-by-one the queue squares wrap
  to two rows when more than seven; the Approve button spans the width and
  Edit · Reject share a row; "Up next" rows truncate the value with its full
  text in `title`. Run details, Export and Values as code stay behind ⋯ at
  every width.
- The rail tab badge keeps its number-only rule under 300px (`TabBadge`).

## 10. Accessibility

- Rail tabs are `role="tab"` with `role="tabpanel"` bodies (as `RightRail`
  has); the record header is `button[aria-expanded]`; a row is
  `button[aria-expanded][aria-controls="{id}"]`; the expansion is the
  controlled `div`.
- The count line and the status line are not live regions. One visually
  hidden `p[aria-live="polite"][aria-atomic="true"]` in the rail carries one
  message per action with only the delta (§3.4, §4.3, §5.2, §5.3). Toasts are
  `role="status"` (the `Toast` primitive). Errors are `role="alert"`.
- Focus: after a decision in the list, the row; after an undo, the restored
  row; in one-by-one, the value heading (`h2[tabindex="-1"]`) after every
  step; entering an edit, the input; the dialog and the popover return focus
  to their opener (`ModalDialog`); the drawer returns focus to ⓘ.
- Marks have accessible names and `aria-current` (§7.2). The queue squares
  are 24px with glyphs, not colour alone; `aria-label="{name}, {to check |
  approved | …}{, doubtful link}"`.
- Hit targets: chips 28px, rows ≥ 30px, decision buttons 30px, card actions
  44px, queue squares 24px, the status row's buttons 32px, marks at least the
  occurrence's bbox.
- Motion: entry fades and spinners only on `transform`/`opacity`; none under
  `prefers-reduced-motion`.

## 11. Copy

| Where | Now | After |
|---|---|---|
| Status | Completed / Using Schema Revision 2 · Current revision: 2 / View used schema | Completed · Catalog · 7 records · Schema rev 2 |
| Running | Running extraction… / The server is extracting values… | Reading records · 3 of 7 · from page 1 |
| Count | 72 of 72 required decisions remaining; Review attention · 72 to check; Approve remaining (72) | **72** to check (once) |
| Chips | Strategy · Fields · Missing · Verifier-supported · Doubtful links | To check · Doubtful 6 · Not reviewable 4 · All |
| Bulk | Approve remaining (72) + paragraph | Approve rest… → "Approve the 72 values still to check and save the review?" |
| Row state | to check pill / Unsupported pill / MISSING badge | glyph + chip "p.1", "p.1 · doubtful", "unsupported", "missing" |
| Doubt | Value also appears in 1 other passage (note) | **Doubtful link.** Value also appears in 1 other passage. |
| Edited | Extracted value: Grav 8 | Extracted value: ~~Grav 8~~ · "Evidence for the extracted value · p.1 · Verifier-supported" |
| Saved | Review saved · 27 decisions | Review saved · 27 decisions · read-only |
| Views | Review \| Values as code \| Markdown | ⋯ → Values as code; the document toolbar's PDF \| Markdown |
| Completion toast | ✓ Extraction complete — review it in the Results tab · Review now | (rail open on Results) Run finished · your 3 decisions kept · 54 to check. · Review one by one |

## 12. Colour and type

Prototype colours map to tokens: `#a34828` `--color-accent`, `#4f8aa8`
`--color-ev`, `#3e7c4f` `--color-green`, `#b3402a` `--color-danger`,
`#c98a2b` `--color-stale`, `#33302c` `--color-ink`, `#6c6259`
`--color-ink-muted`, `#776b60` `--color-ink-faint`, `#eadfd6` `--color-line`,
`#d9cabc` `--color-line-strong`, `#f5efe9` `--color-surface-muted`, `#fbf1ec`
`--color-accent-ghost`, `#eef6fa` `--color-ev-ghost`, `#d9eaf3`
`--color-ev-soft`, `#e7f1e9` `--color-green-soft`, `#fce8e4`
`--color-danger-soft`, `#fdf3e3` `--color-stale-soft`, `#9a6b14`
`--color-stale-ink`. The prototype's green and danger button borders
(`#b9d3bf`, `#ecc3b9`) are the colour at 40% (`border-green/40`,
`border-danger/40`).

Amendments to `DESIGN.md`:

- §3 Typography: the rail gains one display size, `--text-display: 20px`
  (weight 700, line-height 1.25), for the To check count and the one-by-one
  value. `index.css` adds it under `@theme`.
- §5 Action Button: `Button` gains `variant="outline-positive"` (green text
  and icon, `border-green/40`, `--color-green-soft` on hover) and
  `variant="outline-danger"` (the same in danger), and `variant="ghost"`
  (muted text, no border, surface-muted on hover). One filled primary per
  screen stays: Run.
- A new §5 entry "Results rail": one header in both phases (status line,
  count block, chips); the list of records with flat value rows; the
  selected-row expansion; one-by-one as the same rail; the rail's own toast;
  the Run details drawer. While an Extraction runs, the list shows the records
  in the order kei reads them under "Reading records · k of n · from page p";
  a record read is reviewable at once; at settlement the list keeps its place.

## Glossary changes

Proposed for `CONTEXT.md` (not edited here):

- **Review Draft** (new): A Humanities Researcher's Review Decisions on an
  Extraction before the review is saved, kept on the Extraction under a
  version, accepted for records the Extraction has already read while it runs
  and reconciled against the settled Extraction Result when it settles. It is
  not a Feedback Set until saved. _Avoid_: pending decisions, local changes,
  unsaved review.
- **Required Decision** (new): A Review Decision the review needs before it can
  be saved: one per value with Evidence. Studio shows a value awaiting its
  Required Decision as "to check". A value without Evidence needs none and is
  "not reviewable". _Avoid_: pending, remaining, mandatory field.
- **Doubtful Link** (new): A mark on Evidence linked to a value: the value is
  not found in its passage, or is also found in other passages. It is a
  prompt to look, never a verifier state and never a verdict on the value;
  it does not block saving. _Avoid_: weak link, uncertain evidence, low
  confidence.
- **One-by-one Review** (new): The Results rail's mode that presents one
  Required Decision at a time in a queue across records, with the Source
  Document focused on its Evidence. _Avoid_: focus mode, wizard, stepper.
- **Settled Extraction** (new): An Extraction whose run has ended with its
  Extraction Result published, or with a recorded failure. Before that it is
  running and Studio shows a partial view of what it has read. _Avoid_:
  finished job, terminal attempt (outside code).
- **Review Decision** (amend): add "Made in the Results rail on a Settled
  Extraction, or on a record already read while the Extraction runs; a Review
  Draft until the review is saved."

## Error handling

- A draft save fails (network, 5xx): "Draft not saved · Retry draft" in the
  breakdown line; decisions stay on screen; the next decision retries.
- A draft conflict (`REVIEW_DRAFT_CONFLICT`): "The review changed elsewhere ·
  Reload server review"; decisions are retained for the session recovery as
  today; no further draft is sent until reloaded.
- A draft save refused during a run (`invalid_review`, an anchor not in the
  pinned document): the decision is reverted to To check with the toast
  "This value can’t be reviewed: its Evidence is not in this document."
- Finalization fails: "Review not saved · Retry"; the decisions stay a draft.
  A `review_conflict` (finalized elsewhere): "This review was saved elsewhere.
  Reload." and the tab reloads the attempt.
- The monitor fails: the second status line with "Reconnect"; the list,
  the draft and the queue stay as they were; keys still work on readable
  records.
- The settled attempt drops a record the researcher decided on: its decisions
  are not kept (§5.3's count) and its rows are gone; nothing else moves.
- A cancelled or failed run: the toast of §5.2; the rail shows the state and
  the empty body; the stored draft is never read.
- kei's progress is absent for a poll: nothing changes (`retainFinished`).
- A mark cannot be drawn (no bbox, page not rendered yet): the row still
  selects and the viewer still navigates to the page; `pagerendered` repaints
  as today.
- "Copy link" when the clipboard is unavailable: the toast "Could not copy the
  link".

## Testing

- Unit (`vitest`, Testing Library): `reviewQueue.ts` (order across records,
  doubtful first, skip postpones, next wraps to the next record, a record
  read during a run appends); `reviewHistory.ts` (undo restores decision and
  value, undo of an undo); `reviewReconcile.ts` (kept by path and anchor,
  value change in session, dropped record, the toast counts); `ResultsTab`
  header copy for every state of §2.1, the chips' counts over readable
  records, the filter kept across settlement, the selected row's expansion
  parts, the last-value warning and labels, Approve rest… scope copy and the
  edit guard, Save review when the count is 0, no auto-save at settlement;
  `ReviewFocus` keyboard model (keys ignored while typing and on repeat;
  Escape order; focus on the heading after each step), end cards, caught-up
  copy; the live region's messages; `useExtraction` draft decisions prepared
  from a partial and the pinned document, `draftAvailable`, `decidedOn`,
  `setDecision` answering `last`; `resultsBadgeFor` "k of n"; the marks'
  accessible names, the many-values popover, no scroll on a partial link, the
  dimming overlay only for cell/segment precision; `Button` variants; the
  264px and 344px layouts (chips to a select; actions on their own lines).
- `packages/extraction` and Studio API: a draft is accepted on a running
  Extraction (`outcome IS NULL`) and validated against the pinned document and
  schema, refused for an anchor not in the document or an optional decision;
  refused on a FAILED row; `readReviewDraft` after settlement answers kept and
  `dropped`; the version continues across settlement; finalization unchanged;
  `read()` carries `reviewDraft` while RUNNING.
- Playwright (`canonical-evidence-lifecycle.spec.ts`, the kei stand-in
  delaying entries): Run from page 2; the first record reads on page 2; approve
  one of its values while the run goes on; the breakdown says "draft until the
  run finishes"; release the result; the toast "Run finished · your 1 decision
  kept · …"; the decided row keeps "Approved"; One by one; A, J, Z; Approve
  rest… saves; the header reads "Review saved"; reload: read-only.
- Gates: `pnpm -C prototypes/studio typecheck`, `lint`, `test`;
  `pnpm -r typecheck`; `packages/extraction` tests.

## Files

New, Studio: `src/ResultsHeader.tsx` (§2), `src/ReviewList.tsx` (§3),
`src/ReviewRow.tsx` (§3.2–3.3), `src/ReviewFocus.tsx` (§4),
`src/RunDetailsDrawer.tsx` (§8), `src/ResultsMenu.tsx` (§8),
`src/reviewQueue.ts`, `src/reviewHistory.ts`, `src/reviewReconcile.ts`,
`src/reviewVocabulary.ts` (§1: glyph, chip, label and detail per value),
`src/evidenceQuote.ts` (§7.1), `src/useReviewKeys.ts` (§4.4),
`src/ui/ReviewedValueEditor.tsx` (§3.5), `src/DocumentViewSwitch.tsx` (§7.4),
and the tests beside each.

Edited, Studio: `src/ResultsTab.tsx` (composes the above; the auto-accept
effect, the summary chips, the Completion lines, the breadcrumb navigation and
the result-view tabs are removed), `src/useExtraction.ts` (`draftAvailable`,
prepared decisions from a partial, `decidedOn`, `setDecision` → `{ last }`,
`occurrenceIdsByAnchor` option, the partial on the running state as the
client plan's Task 1), `src/extraction.ts`, `src/partialResult.ts` (the client
plan's Task 1 helpers, kept), `src/resultsBadge.ts`, `src/useEvidenceOverlays.ts`
(one colour, clickable marks, partial links, the dimming overlay, the
Markdown spans), `src/App.tsx` (`occurrenceIdsByAnchor`, the toolbar switch,
the completion toast rule, `?value=`), `src/DocumentTabBar.tsx` (the ring,
the fixed-width run button), `src/RightRail.tsx`, `src/ui/Button.tsx`,
`src/ui/ResultValue.tsx` (its editor extracted; no longer mounted by the
Results tab), `src/index.css`, `DESIGN.md`, `shared/extraction.contract.ts`
(`reviewDraft.dropped`), `api/extractions.ts` (`reviewDraft` while RUNNING),
and the tests beside them.

Edited, `packages/extraction/src`: `module.ts` (`saveReviewDraft` on a running
Extraction; `readReviewDraft` with `dropped`), `postgres-reviews.ts` (the
predicate), `review-rules.ts` (a `runningDraftMatchesDocument` helper beside
`reviewDecisionMatchesSchema`), `types.ts` (`ReviewDraft.dropped`), and the
tests beside them.

Deleted: `src/ReviewAttention.tsx` and its test; `src/resultStats.ts` and its
test (the Fields and Missing chips go); the Results tab's Markdown panel.
`CatalogReview.tsx` and `RecipeReview.tsx` move into the drawer unchanged.

## Out of scope

- The batch review grid (`BatchExtractionReviewGrid`): it keeps its column
  approvals and its own header; a later spec aligns it with §1's vocabulary.
- Correcting a value without Evidence by pointing at a passage: the contract
  exists (`reviewedEvidence`, `optionalDecisionIsPublished`); the passage
  picker does not. Not reviewable values stay without controls here.
- Live re-prioritisation while the researcher scrolls, and an "extract as I
  read" mode (streaming spec §6).
- Thumbnails showing where work is left (Main's "the document only follows
  the rail"): a later small spec on `PageNavigation`.
- Deep links beyond `?value=` (the result view in the URL).
- Export always visible as a button during review (Fable 13): rejected; the
  status line holds two icon buttons at 264px, Export has a dialog of its own
  behind ⋯ one click away, and it surfaces as a button the moment the review
  is saved and export is the next step.
- Progress for Batch Extractions.
- Reviewing an Article's values before its grounding batches arrive: there is
  nothing linked to review (§5.1).

## Resolved questions

Decided with the researcher on 2026-10-04: every question below takes the
option this spec was written for (the first named in each item); the
alternative is recorded for history only.

1. **Auto-save on the last decision** (the current rule, kept here with the
   warnings of §3.3 and §4.3) versus an explicit "Save review" always (Fable
   item 2's alternative, which would also remove the "… and save review"
   labels and the dialog's "can’t be undone"). Decided: auto-save stays. §6 isolates the
   trigger, so a later switch is one change.
2. **List order after settlement**: kept as read (this spec) until the
   document is reopened, versus source order at settlement (client plan
   Ruling 7). Kept-as-read means the order differs after a reload.
3. **The value rule at settlement** is enforced in the session only (§5.3);
   making it durable means the draft decision carries the value it was made
   on (a contract change). Needed only if a published entry's value can
   change under the same anchor, which Part A's write-once entries rule out.
4. **The run button**: no count on "■ Stop extraction" (this spec; the badge
   and the tab ring carry progress) versus the client plan's "k of n" on it.
5. **A record's label after settlement**: kei's entry label kept while open,
   then the first string field (this spec); the artifact does not carry entry
   labels, so a reopened document names records by their first string field.
6. **Not reviewable values and "Edit field…"**: this spec keeps schema edits in
   the ⋯ menu for the selected value only; the alternative is a per-row
   "Edit field…" on Not reviewable rows (Fable 15).

## Review items: where each went

Fable 5.1: 1–5, 7, 8, 10 applied in the prototype and kept (§1, §3.3, §3.4,
§3.6, §4.4, §2.3, §4.2); 6 → §2.1 and §3.1 (Article); 9 → §3.3 (accent edge,
chip kept, wrapping quote, two-line clamp, real fields); 11 → §10; 12 → §10
(targets); 13 → §8 (Schema link opens the used schema; menu items disabled
with a reason) and Out of scope (Export always visible); 14 → §12; 15 → §3.5
and §8.

Codex gpt-6-astra: 1 → §2.1 and §2.2 (saving, failed, conflict, "all decided"
is not "saved": §6); 2–3 applied (§1, §3.3); 4 applied (§3.4; bulk approvals
are explicit decisions); 5 → §1 (Contested kept; Missing without a cause) and
Out of scope (evidence-backed corrections); 6 → §4.2, §3.1 (Article,
document fields, empty Catalog, nested arrays as flat rows); 7 → §3.3 and §9;
8 → §7; 9 → §4.4 and §10; 10 → §3.5; 11 → §4.1 and §4.2; 12 applied (§3.6);
13 → §2.1; 14 applied (§7.3 at .55, §4.2 glyphs and 24px); 15 → §12 and §4.2
(one progress treatment per level).

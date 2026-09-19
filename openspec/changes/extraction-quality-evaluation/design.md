## Context

FREE already has two relevant, reusable primitives: `SchemaRevision`
(`packages/db/src/prisma/contract.prisma:213-232`) is an immutable,
append-only snapshot of the whole `SchemaNode[]` tree — including
`allowedValues`, since that's a property on the node itself
(`packages/extraction/src/schema.ts:21`) — so vocabulary changes are already
versioned for free. `ReviewDecision` records exist but are never checked
against an external answer key. Nothing else described here exists: no gold
corpus, no scoring code, no cross-cycle metrics linkage, no vocabulary-
violation reporting (`coerceAllowedValue` in `allowed-values.ts:65-72`
silently keeps out-of-vocabulary values verbatim by design — intentional,
not a bug, but unreported), no reviewer-effort measurement beyond raw
decision counts, and no schema-free extraction path (only `ARTICLE`/
`CATALOG` exist in `extractionStrategySchema`).

The motivating pilot data point — 341 publications, 589 records from 323
documents, errors "mainly omissions, particularly incomplete enumeration of
multi-species tables and values outside controlled vocabularies" — implies
the two most valuable things to measure first are (a) whether a record was
missed/hallucinated entirely (not just whether a matched record's fields are
right) and (b) out-of-vocabulary rate. Design prioritizes those.

## Goals / Non-Goals

**Goals:**
- A held-out, version-locked gold corpus that stays comparable across
  refinement cycles.
- Record-level alignment that correctly attributes an omitted or
  out-of-order record (the pilot's dominant error mode) rather than assuming
  positional 1:1 correspondence.
- Field-level precision/recall/F1 over matched pairs, with a per-field
  tolerance policy that defaults to strict (exact) matching.
- A persisted per-cycle metrics snapshot (not recomputed live), so a later
  gold-annotation correction never silently rewrites an old cycle's
  reported numbers.
- Reuse `SchemaRevision` and (once it lands) `batch-extraction-retry` rather
  than parallel version/retry mechanisms.

**Non-Goals (this design, not necessarily out of scope forever):**
- A fully automatic gold-annotation pipeline — gold records are expert-
  curated input, not derived.
- Building `schema-free-baseline-extraction` to completion here — sketched
  only, flagged for separate scoping (see Decisions D8, Risks).
- Exhaustive Evidence Anchor judgment on every claim — sampling is
  acceptable (Decisions D7).

## Decisions

### D1. Gold corpus as versioned DB entities, not repo-checked-in fixtures

`EvaluationCorpus` (named, stable identity) → `EvaluationCorpusVersion`
(append-only snapshot, mirroring `SchemaRevision`'s shape/versioning
pattern) → `GoldRecord` rows (one per expert-curated record, per document,
in that corpus version; `fields: Json` shaped like the target schema).
Documents are referenced by existing `sourceDocumentId`/
`sourceRepresentationRevisionId` — the corpus never duplicates document
storage, only curates which documents belong to the benchmark and what
their correct records are.

*Alternative considered*: gold data as files in the repo (fixtures).
Rejected — a gold annotation itself gets corrected over time (an expert
fixes their own mislabeled record), which is exactly the kind of edit
history `SchemaRevision`-style append-only versioning already solves well;
re-deriving that in flat files means rebuilding audit/versioning ad hoc, and
`evaluation-run-tracking` (D4) needs to join against it directly.

### D1b. The project's stored spreadsheet is the ingestion mechanism; schema-seeding is a separate, depended-on change

A researcher already has, in the common case, their own spreadsheet of
manually-extracted values (columns = field names, rows = records) predating
any FREE schema. Rather than building a bespoke annotation UI for
`GoldRecord`s, FREE reuses that spreadsheet directly — and rather than
building a second, evaluation-specific "spreadsheet seeds a schema"
mechanism, this change depends on the standalone
`openspec/changes/spreadsheet-schema-suggestion` change for that half
(project-scoped versioned spreadsheet storage, column-value type
inference, routing through the existing batch-suggestion draft/edit/
confirm flow via `templateToNodes`, and a confirmed column-to-field
mapping). That change is useful on its own — bootstrapping a schema from a
spreadsheet has nothing to do with evaluation — so it was split out rather
than owned here.

That sibling change stores the spreadsheet as a versioned, project-scoped
slot (upload is its own action, decoupled from suggestion creation) and
pins which version a spreadsheet-derived `BatchSchemaSuggestion` was built
from (`projectSpreadsheetVersionId`). This directly solves the timing
problem D1b originally had to work around: confirming a suggestion happens
later, asynchronously, after a researcher reviews/edits the draft — with
the spreadsheet durably stored and the suggestion pinning its exact
version, `SCHEMA_AND_VALIDATE`'s population step can read the same rows at
confirm time no matter how much later that is, rather than needing the raw
upload to still be "in flight" from a single request.

What *this* change owns is the purpose choice and the gold-data half: when
creating a suggestion from the project's current spreadsheet, the
researcher picks `SCHEMA` (use the sibling change's suggestion flow, stop
there) or `SCHEMA_AND_VALIDATE` (same suggestion flow, but once confirmed,
also populate an `EvaluationCorpusVersion` from the pinned
`projectSpreadsheetVersionId`'s row values, per D1's requirements).
Column-to-field mapping for that population step comes from the sibling
change's confirmed result — this change never re-matches columns by raw
header text. Filename resolution (D1's spreadsheet-ingestion requirements)
is owned here, since it's specific to attaching gold *data* to documents,
not to schema-seeding — see D1c for how resolution is made unambiguous by
construction rather than by runtime disambiguation.

A spreadsheet row's filename resolves to *one project document*, but a
spreadsheet MAY have multiple rows sharing the same filename — each becomes
its own `GoldRecord` under that one document (e.g. several experts'
independent annotations of the same multi-species table, or several gold
records within one document). This is a spreadsheet-side, expert-authored
choice and is unrelated to D1c's *system-side* filename uniqueness.

*Alternative considered*: a dedicated annotation UI (grid of documents ×
fields, hand-typed) instead of spreadsheet upload. Rejected — it's strictly
more work to build than a parser plus the existing suggestion-review UI,
and ignores that researchers doing this kind of curation work already tend
to have the data in spreadsheet form; making them re-type it into a new UI
is pure friction for no benefit.

*Alternative considered*: infer purpose from whether cells are filled in
(schema-only if headers-only, schema+validate if populated), rather than an
explicit choice. Rejected — a partially-filled sheet (some rows annotated,
some left as placeholders) would be ambiguous under that heuristic; an
explicit researcher choice has no such edge case.

### D1c. `SourceDocument.originalName` is unique per project

`originalName` gets `@@unique([projectContextId, originalName])` on the
Prisma model (`packages/db/src/prisma/contract.prisma:101-115`), and the
upload path (`prototypes/studio/api/source_documents.ts`) rejects a new
upload whose `originalName` already exists in the project, as its own check
ahead of (and independent from) the existing `contentSha256`/`ingestionKey`
dedup logic in `project-store.ts`'s `ingestSourceDocument`. This makes D1's
filename resolution unambiguous by construction: a spreadsheet row's
filename either matches exactly one document or none — there is no longer a
"matches more than one document" case to disambiguate at ingestion time.

*Status quo before this decision*: the codebase has never enforced this —
dedup is by `contentSha256`/`ingestionKey` only, so two different-content
PDFs with the same display name can and do coexist in a project today. This
decision is a genuine, user-facing behavior change to the existing
document-upload flow (`source-document-ingestion`), not scoped to
evaluation — it is being made here because the gold-corpus filename-mapping
requirement is what surfaced the ambiguity as worth closing, but the
constraint applies to every upload, not just spreadsheet-linked ones.

*Alternative considered*: keep allowing duplicate names and require
per-row disambiguation at spreadsheet-ingestion time (the originally
scoped approach, still reflected in tasks.md's superseded 2.2 wording
before this decision). Rejected once made explicit — a disambiguation UI is
strictly more to build than a single upload-time uniqueness check, and
"two different files with the same display name" is confusing for a
researcher independent of gold-corpus ingestion; closing it at the source
is simpler for every caller, not just this one.

*Risk*: existing projects may already have duplicate `originalName`s before
this migration ships — see Risks below.

### D1d. A reserved "filename" spreadsheet column drives row->document resolution

The gold spreadsheet's columns otherwise all become schema fields (D1b) —
but *something* has to say which document each row is about, and nothing
in `spreadsheet-schema-suggestion`'s column model reserves a column for
that. FREE reserves the column named `filename` (matched case- and
whitespace-insensitively — `isGoldFilenameColumn`,
`packages/extraction/src/gold-spreadsheet.ts`): its per-row value resolves
against `SourceDocument.originalName` (unambiguous by construction per
D1c) to pin the `GoldRecord`'s document, and it is excluded from becoming
a schema field at all — `buildSpreadsheetTemplate`
(`prototypes/studio/api/_spreadsheet_schema.ts`) filters it out before
assembling the template, regardless of `SCHEMA`/`SCHEMA_AND_VALIDATE`
purpose, since a column identifying which document a row is about is never
a value to extract from that document's content.

A `SCHEMA_AND_VALIDATE` confirmation with no `filename` column, or a row
whose filename value is blank or unmatched, fails the whole confirm
(`ExtractionError('invalid_request', ...)`, naming the row) rather than
silently skipping data or leaving a partially populated corpus — thrown
from inside the same transaction that creates the `SchemaRevision`/
`BatchExtraction`, so schema-seeding and gold-population commit or fail
together, echoing D4's freezing rationale: a clean all-or-nothing outcome
the researcher can fix and retry beats a partial one. A wholly blank row
(e.g. a trailing one from the source spreadsheet) is treated as noise and
skipped, not an error — only a row with *some* data but no resolvable
filename fails the confirm.

*Alternative considered*: let the researcher pick which column is the
filename column, per suggestion (an explicit parameter alongside
`purpose`). More flexible — no fixed column-naming convention — but adds a
UI decision to every `SCHEMA_AND_VALIDATE` upload for a case a naming
convention handles for free; revisit if `filename` turns out to collide
with a real field name researchers commonly use.

### D2. Record alignment: key-field match first, minimum-cost fallback

If the schema marks one or more fields as identifying (a new optional
`identifying?: boolean` on `SchemaNode`, analogous to the existing opt-in
`description`/`allowedValues`), align records by exact/normalized match on
those fields first. Only when no identifying field is declared, or ties
remain, fall back to a minimum-cost greedy assignment over a per-field
similarity score (corpus sizes here are tens of records per document, not
thousands, so greedy nearest-neighbor is sufficient — no need for a full
Hungarian-algorithm implementation). An unmatched gold record is a recall
miss; an unmatched extracted record is a precision miss (hallucination).

*Alternative considered*: assume positional 1:1 correspondence between
extracted and gold records. Rejected outright — the pilot's own finding is
that omission/reordering in multi-species tables is the dominant error
mode; positional matching would misattribute a shifted-index correct record
as wrong across the board, actively hiding the failure mode this framework
exists to measure.

*Alternative considered*: always use general minimum-cost matching, no
key-field shortcut. Kept only as a fallback — a natural key (e.g. species
name) makes alignment decisions interpretable and debuggable for the
researcher reviewing a scoring disagreement, which an opaque global
assignment score does not.

Implemented in `packages/extraction/src/record-alignment-scoring.ts`
(`alignRecords`). A record whose identifying field(s) are blank never
participates in key-based grouping — a shared "blank" key would otherwise
spuriously collide unrelated records — it goes straight into the greedy
pool, same as a tie. The greedy fallback's "per-field similarity score" is
the fraction of leaf fields matching under D3's own comparator (`0` to
`1`), not a second, separate fuzzy notion of closeness — greedily assigns
the single highest-similarity remaining pair, repeatedly, until either side
runs out (no minimum-similarity cutoff: design.md's "minimum-cost
assignment" always pairs the best available candidates, it does not leave
plausible pairs unmatched).

### D3. Field comparison: exact by default, opt-in tolerance for numerics

String/enum/boolean fields compare exact after trim/case-fold. Numeric
fields (`number`/`integer`) support an optional `evaluationTolerance`
property on `SchemaNode` (absolute or relative, author's choice), defaulting
to exact match when unset.

*Alternative considered*: one global numeric tolerance. Rejected — a
thermal measurement's natural precision differs from a count or a
concentration; a single global percentage is either too loose for exact
counts or too strict for continuous measurements. Per-field, opt-in,
default-strict avoids silently over-crediting near-misses on fields nobody
configured.

*Scope note*: an `array`-typed field (whether `itemType` scalars or a
nested `children` array of structured items) is compared as one opaque
leaf — scalar arrays via order-insensitive deep-equal after normalization,
a nested-object array via plain deep-equal — rather than recursively
realigning its own sub-records. Design.md's multi-record case (multiple
species in one document) is modeled as multiple *top-level* records
(that's exactly what D2's alignment operates over), not as a nested array
inside one record; building full nested record-alignment for the latter is
out of scope here and would be its own follow-up if a real schema needs
it. Plain `object` fields (no repetition) recurse normally — every leaf
inside them is its own compared field.

### D4. `EvaluationRun` persists computed metrics; frozen corpus is re-run via retry

`EvaluationRun { evaluationCorpusVersionId, schemaRevisionId,
batchExtractionId?, extractionId?, computedAt, metrics: Json }` — exactly
one of `batchExtractionId`/`extractionId` is set (D4b). Producing a batch
run: (1) run the gold corpus's documents through extraction at the current
`SchemaRevision` — reusing `batch-extraction-retry` from
`openspec/changes/extraction-review-metrics-and-sampling` (that capability
needs to accept an arbitrary member list, not only "not-yet-reviewed
production members," to be reusable here — a small generalization, not a
new retry mechanism); (2) run record-alignment-scoring (D2/D3) per document
against its `GoldRecord`s; (3) aggregate into `metrics` and persist as one
`EvaluationRun` row.

*Alternative considered*: compute metrics on-the-fly from raw
`BatchExtraction` + `GoldRecord` joins whenever viewed, no persisted
`EvaluationRun`. Rejected — recomputing alignment on every view wastes work
as the corpus grows, and more importantly has no fixed snapshot: a later
gold-record correction would retroactively change what an *old* cycle's
reported metrics were, corrupting the cross-cycle comparison this whole
feature exists to produce. Persisting metrics at run time freezes each
cycle's result the way `SchemaRevision` already freezes each schema's.

**Status: the batch path is blocked, not built.** `batch-extraction-retry`
(`openspec/changes/extraction-review-metrics-and-sampling` §8) does not
exist yet — it sits behind that change's own §7, an unstarted manual
validation spike only a researcher can run. Building a parallel re-
extraction mechanism here instead, rather than waiting, was considered and
rejected: this change is explicitly supposed to *reuse* that capability,
and a shadow implementation would either duplicate it or diverge once the
real one ships. `EvaluationRun`'s data model (below) and D4b's
single-document path do not depend on this and are built; "create a batch
run" (tasks.md 4.2/4.3) is deferred until the sibling capability lands.

### D4b. Single-document validation reuses the exact same scoring, no batch required

A researcher looking at one extraction attempt (in the single-document
Results tab, not the batch grid) SHALL be able to validate that one
document against its `GoldRecord`s — when the document belongs to some
`EvaluationCorpusVersion` — without running a full corpus batch. This calls
the same `record-alignment-scoring` function D4's batch path calls, at
`n=1`, and persists the result as an `EvaluationRun` row with `extractionId`
set and `batchExtractionId` null (same freezing rationale as D4 — a later
gold correction must not retroactively change this document's past
validation result either). The `metrics` shape is identical to a batch
run's — precision/recall/F1, vocabulary-violation count, and (once §6-7
land) reviewer-effort/anchor-accuracy figures — just computed over one
document instead of a corpus, mirroring how `ExtractionFinishedDialog`
already mirrors `BatchExtractionFinishedDialog`'s report shape at `n=1`
rather than inventing a separate single-document metric set.

*Alternative considered*: only support validation at the batch/corpus level,
requiring a researcher to run the whole corpus to check one document.
Rejected — the practical workflow this exists for is "I just tweaked the
schema, does this one document I'm looking at score better now?", which
needs an immediate per-document answer, not a full corpus re-run every time.

*Open question, resolved as built*: does a single-document validation
require the document to already be a member of some `EvaluationCorpus` (has
existing `GoldRecord`s), or should a researcher be able to gold-annotate one
document ad hoc, outside any named corpus, purely to validate it once? Built
per the default assumption: the document must belong to an
`EvaluationCorpus` — `validateExtraction`
(`packages/extraction/src/postgres-evaluation-runs.ts`) reads the corpus's
*current* version's `GoldRecord`s for that document and returns nothing
creatable when there are none, rather than accepting inline gold values.

Implemented in `packages/extraction/src/postgres-evaluation-runs.ts`
(`validateExtraction`/`listEvaluationRuns`), wired through
`ExtractionModule` alongside `scheduleBatch`/`scheduleSuggestedBatch`. The
`metrics` shape currently persisted is `{correctFields, totalGoldFields,
totalExtractedFields, precision, recall, f1}` — the vocabulary-violation/
reviewer-effort/anchor-accuracy fields this paragraph mentions don't exist
yet (§5-8 unbuilt); `metrics` is a `Json` column specifically so later
sections can extend it without a schema change. `listEvaluationRuns` orders
newest schema-revision cycle first (ties broken by `computedAt`), matching
`listSchemaRevisions`'s existing descending convention elsewhere in this
codebase.

### D5. Controlled-vocabulary diagnostics: additive event, unchanged coercion

Wrap `coerceAllowedValue`'s call sites (`applyAllowedValues`/`coerceNode` in
`allowed-values.ts`) to also emit `{resultPath, rawValue, allowedValues}`
whenever the returned value isn't an exact/case-fold match for a member of
`allowed`, collected alongside existing extraction diagnostics (parallel to
how grounding issues are already collected in `diagnostics.grounding`). The
coercion behavior itself — keep verbatim, never blank — is explicitly
unchanged; this only makes an already-intentional pass-through visible and
countable.

### D6. Reviewer effort: client-captured timing + edit distance, EDITED only

Studio already knows when a cell becomes active/editable and when a
decision commits; capture `shownAt`/`decidedAt` locally and include them in
the existing decision-save payload — no new round-trip per keystroke. Edit
distance is computed only for `EDITED` decisions (Levenshtein between
`String(originalValue)` and `String(reviewedValue)`) — `REJECTED` carries no
value (enforced by `extraction.contract.ts`, per the same reasoning already
applied to `schema-field-examples` in the sibling change), so there is
nothing to diff for a rejection.

### D7. Evidence Anchor accuracy: a second, independent judgment layer

Anchor-supports-value is judged independently of value correctness — a
value can be right with a wrong/irrelevant anchor, or (less often) an
anchor can genuinely support a value that's still wrong for other reasons.
Store judgments keyed by `{evaluationCorpusVersionId, sourceDocumentId,
resultPath, judgment}` rather than folding them into `GoldRecord`, so
sampling a subset of claims for anchor judgment doesn't require a full
gold-value annotation pass over the same claims, and vice versa.

### D8. Schema-free baseline: sketch only, flagged for separate scoping

Adding `'SCHEMA_FREE'` to `extractionStrategySchema` and a matching
execution path that skips schema-constrained generation is a full third
strategy alongside `ARTICLE`/`CATALOG` — largest single piece of scope here.
It also adds a problem `record-alignment-scoring` doesn't otherwise have:
schema-free output field names won't match the gold schema's field names
verbatim, so a field-*name* alignment step is needed before record/field
alignment can even run. Recommend a small manual spike (run a schema-free
prompt against 5-10 gold-corpus documents, look at how messy the field-name
matching actually is) before committing to a full build — see Risks.

### D9. Gold-assisted review: a fuzzy-match suggestion, surfaced but never authoritative

When a document belongs to an `EvaluationCorpusVersion` with a matched
`GoldRecord` (same precondition as D4b), each field's existing per-cell
Approve/Reject/Edit control (`BatchExtractionReviewGrid.tsx`'s
`ReviewCell`, and the equivalent single-document result-tab surface) also
shows the gold value alongside the extracted value, and the cell's default
selection is pre-set from a fuzzy-similarity comparison between them —
*separate from* D3's strict scoring, which stays exact-by-default for
`EvaluationRun` metrics and is never affected by this. Pre-selection is a
UI default only: it changes which control looks chosen when the cell is
first shown, never writes a `ReviewDecision` on its own — the researcher's
own click is what actually commits `APPROVED`/`REJECTED`/`EDITED`, exactly
as today.

Similarity reuses D6's Levenshtein primitive (normalized:
`1 - distance / max(len(a), len(b))` over `String(value)`, extended with a
relative-difference variant for numeric fields) rather than D3's exact/
tolerance comparator — a continuous confidence score is a different need
than an authoritative pass/fail. Two thresholds turn that score into a
suggested action: `>= 0.85` pre-selects Approve, `< 0.5` pre-selects
Reject, and the band between pre-selects nothing (today's blank state) —
a genuinely ambiguous partial match should not nudge the researcher either
way. These are starting defaults, not tuned; §11's core-loop checkpoint
(tasks.md) should confirm them against a real corpus like §6 does for
alignment/tolerance.

The suggested action and the similarity score it came from are persisted
alongside the eventual decision — new `suggestedAction: ReviewDecisionAction
| null` and `matchScore: number | null` fields on `ReviewDecision`
(`reviewDecisionShape`, `extraction.contract.ts`), both `null` when no gold
value was available for that field (the overwhelming majority of decisions,
outside evaluation-corpus documents — existing behavior is otherwise
unchanged). Persisting what was actually suggested *at decision time*
matters because gold data is versioned (D1): a later gold correction must
not retroactively change what "the researcher agreed with the suggestion"
meant for a past decision, mirroring D4's freezing rationale. This also
gives `reviewer-effort-tracking` (D6/§7, once it lands) a free signal —
agreement rate with the system's suggestion — without new plumbing.

This does not conflict with the Non-Goal "a fully automatic gold-annotation
pipeline" — that Non-Goal is about *producing* `GoldRecord`s automatically;
D9 only assists the researcher's existing manual review of *extraction
output*, and the gold value itself remains fully visible and the final
decision remains entirely the researcher's.

*Alternative considered*: purely informational badge (similarity score
shown, no control pre-selected). Simpler and zero automation-bias risk, but
explicitly not what was asked for — the point is to save a click on the
common case (obvious match/mismatch) while leaving the ambiguous middle
band untouched, not just to display a number the researcher must still act
on identically to today.

*Alternative considered*: auto-commit a `ReviewDecision` outright when
similarity clears the high threshold, rather than merely pre-selecting.
Rejected — silently deciding without any researcher interaction removes
the human check this whole framework exists to keep meaningful, and would
make "reviewed" and "auto-approved-and-never-looked-at" indistinguishable
in the data.

## Risks / Trade-offs

- [Column-value type inference (D1b) is a heuristic and will sometimes
  guess wrong — e.g. a numeric-looking ID column, or a free-text column
  that happens to have few distinct values in a small sheet] → It only
  ever produces a *draft* suggestion; the researcher corrects it in the
  same review step already used for model-generated suggestions before
  anything is confirmed, so a wrong guess costs one edit, not a bad schema.
- [Tracking column identity through renames (D1b) adds real state to the
  suggestion draft that doesn't exist for model-generated suggestions
  today] → Necessary specifically for `SCHEMA_AND_VALIDATE`; a `SCHEMA`-
  only upload doesn't need it at all, so the added complexity is scoped to
  exactly the path that requires it.
- [This change now depends on `openspec/changes/spreadsheet-schema-
  suggestion` landing (or at least being implemented in lockstep) before
  `SCHEMA_AND_VALIDATE` uploads work end to end] → `SCHEMA`-only uploads
  (no gold data) are entirely that sibling change's own concern and ship
  independently; only the gold-data half here is blocked on its output
  shape (confirmed schema + column-to-field mapping).
- [Record alignment algorithm choice affects every downstream metric] →
  Ship key-field matching only first (cheapest, most interpretable, and
  directly debuggable by a researcher); add the general minimum-cost
  fallback only once real corpora show documents with no usable identifying
  field.
- [Per-field numeric tolerance is easy to forget to configure] → Default to
  exact match; an unconfigured field never silently over-credits near
  misses. Surface which fields have a configured tolerance in whatever UI
  authors the corpus/schema, so it's a visible choice, not a hidden default.
- [Evaluation run cost grows with corpus size] → The corpus is explicitly a
  small, fixed benchmark set, not the full production corpus — bounded by
  design, not by optimization.
- [Evidence Anchor judgment is a second, separate expert-labeling workload,
  on top of gold-record curation] → Make it explicitly samplable (a subset
  of claims, not exhaustive) rather than assuming full coverage; confirm
  expected annotation volume before committing effort.
- [Schema-free baseline's field-name alignment problem is unscoped] →
  Treat D8 as a spike, not a commitment; the manual 5-10 document trial
  should inform whether this is even tractable before writing
  `schema-free-baseline-extraction`'s tasks.
- [This change's scope, taken all at once, is large] → tasks.md phases it;
  the core loop (D1-D4 + D5) is what actually produces cross-cycle
  precision/recall/F1 and should be usable on its own before D6-D8 land.
- [D1c's `originalName` uniqueness constraint may collide with duplicate
  filenames already present in existing projects] → The migration needs a
  pre-flight check (report existing collisions before adding the
  `@@unique` index, rather than the migration failing opaquely); resolving
  real collisions (rename one, or accept both under a disambiguated
  display name) is a one-time data cleanup, not an ongoing product
  surface — decide the exact resolution mechanic during 1.6's
  implementation, not in this design.
- [D9's pre-selected action risks automation bias — a researcher clicking
  through a pre-selected control without genuinely checking it] →
  Pre-selection only ever applies to the two confident bands (`>=0.85`/
  `<0.5`); the gold value stays visibly displayed next to the extracted
  value so confirming it is still a real (if quick) comparison, not a
  blind click; and D9's persisted `matchScore`/`suggestedAction` make
  rubber-stamping visible after the fact (e.g. "researcher always agrees
  with high-confidence suggestions" is a checkable pattern, not a hidden
  one) rather than trying to prevent it structurally.

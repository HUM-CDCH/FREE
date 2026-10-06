## Context

Today the only working evaluation is `experiments/extraction/iterative_eval.py`:
a developer-only Python CLI that parses sources, runs the service's `extract`
entrypoint, and scores values against a golden workbook on disk. It reports
field-level precision, recall and F1 for a "pilot" (the first N documents in the
config) and a "full" phase, with resumable cells and a baseline/candidate
comparison. `experiments/extraction/analyze.py` already computes grounding
diagnostics (`link_rate`, `eligible_link_rate`) and paired document intervals,
and it treats extra predictions as unscored when gold is not exhaustive.

What is missing for the intended loop is not the arithmetic. It is:

- Gold answers uploaded through the project spreadsheet slot are discarded:
  `parseSpreadsheetColumns` reads the header row only and
  `ProjectSpreadsheetVersion` stores `columns` only.
- The CLI's "pilot" is only the first N documents of its own re-extraction: it
  does not run the fixed two-pilot-then-batch pipeline, and a developer must
  start it by hand with files on their own machine.
- Reviewer effort and evidence-anchor coverage do not exist as round metrics.
- There is no one-action path: uploading documents and a gold sheet cannot by
  itself start evaluation, so the numbers never appear on the Spark deployment.

Constraints that shape the design:

- The README product contract: authenticated ownership, durable versioned
  state, explicit finalization, no keys or document content in workflow inputs,
  no reset, and forward-only authored migrations.
- The Parsing Service HTTP API is deliberately stateless and read-only; kei
  keeps state in its worker and the coordination schema.
- Research values and Evidence are read through Studio's durable repository;
  the Parsing Service does not open Studio's database.
- The pilot gate and `PILOT_BATCH_SELECTION_LIMIT` (`packages/extraction/src/batch.ts`)
  already define what a pilot is.
- The only developer action is the upload: the pipeline adds no run, register,
  approve or finalize control.

## Goals / Non-Goals

**Goals:**

- A developer uploads source documents and a gold spreadsheet as the only
  action, and the fixed two-pilot-then-batch pipeline runs automatically and
  publishes per-round metrics.
- Metrics per round: value precision, recall and F1 (micro, macro, per field),
  evidence-anchor coverage, and shadow-reviewer effort.
- Reviewer effort uses a shadow review that writes nothing to durable review
  state.
- Evaluation works on the Spark deployment and stays off by default.

**Non-Goals:**

- No materialized auto-review: nothing writes `ReviewDecision`, corrections or
  finalizations.
- No frontend action beyond the upload: no run, register, approve or finalize
  control, and the metrics surface is read-only.
- No researcher-facing evaluation surface, and no change to review, admission,
  ingestion or extraction behavior when the developer switch is off.
- No change to extraction prompts, methods or production settings; the pipeline
  runs its own rounds through the existing extract entrypoint.
- No change to the frozen ablation study, its manifests or its scorer.
- No claims of semantic correctness or generalization from the metrics.

## Decisions

### D1: The gold corpus is the project's spreadsheet version, with rows

Append nullable `rows` to `ProjectSpreadsheetVersion` and have the upload path
parse the first worksheet's data rows in addition to the header row. One
uploaded version stays the project's single shared sheet: the same version
serves schema suggestion (header only) and evaluation (rows). Versions remain
append-only and owner-scoped, so re-uploading a corrected answer sheet appends
a new version rather than editing history, and every round pins the version it
was scored against. `exhaustive` is stored on the version.

Alternative considered: a separate gold table with its own upload. Rejected
because the project already has one versioned spreadsheet slot and the design
comment there already names gold-standard-corpus population as its future use.
Existing versions with null `rows` stay readable and simply cannot be
evaluated.

### D2: The pipeline produces three fixed rounds, and there are no single-document rounds

One upload starts a fixed pipeline: pilot-1 over two documents, pilot-2 over the
same two documents, then a batch over every uploaded document. The two pilot
documents are the first two in upload order unless the configuration names a
specific pair. An interactive single-document Extraction is never a round. Each
round records the Project
Context, the gold corpus version, the documents it read, the Schema Revision and
Extraction Method pin, its Extractions, the result snapshot and decision version
the metrics read, and its label (`pilot-1`, `pilot-2`, `batch`).
`EvaluationRound` is project-scoped, cascades with Project Context deletion, and
stores the metrics as an immutable JSON value with the cuts it was computed
from. A later run appends new round revisions instead of overwriting.

Alternative considered: deriving rounds from researcher-run Batch Extractions.
Rejected because the developer wants one upload to produce all three rounds with
no frontend action, and because each round needs a stable, pinned record so its
data does not change when later work moves on.

### D3: A dev-only host watcher runs the pipeline; no new HTTP route

The normalization, record alignment, F1 arithmetic and the resumable run loop
already exist in `experiments/extraction/iterative_eval.py`. A developer-only
watcher script runs on the deployment host: it polls the application database
for Project Contexts that have both stored gold rows and at least one ingested
document, writes each one's gold rows to a workbook, assembles the pipeline
config, runs the existing `pipeline` entrypoint, and writes one
`EvaluationRound` row per round through the normal database. Studio owns the
upload and a read-only display: it adds no run, register, approve or finalize
control, and the Parsing Service adds no route. This keeps one scorer
implementation, needs no new authenticated surface, and matches the "one script,
no front-end action" requirement.

Alternative considered: port the scorer to TypeScript. Rejected because it
would duplicate normalization and alignment rules that the Python harness and
the frozen study already own.

### D4: Shadow review mirrors the review's alignment and writes nothing

The shadow review aligns records first: an Article result has one document-level
record; for Catalog, predicted records align to gold rows one-to-one and
mutually by the record-identity field — `identity` in the configuration,
defaulting to `amino_acid_hydroxyproline_value` when that field exists and to
the first field otherwise. A key held by more than one row or record on either
side aligns nothing. Unmatched gold rows and unmatched predicted records are
reported, never scored as correct: an unmatched gold row is a miss and an
unmatched predicted record is an extra, a false positive under exhaustive gold
and an unscored extra otherwise. For each aligned field it compares predicted
and gold values as multisets after the existing NFKC/casefold/whitespace and
numeric normalization. The same comparison also yields the round's guidance: the
value-level differences the next round may carry. That guidance stays in the
evaluation workspace; the shadow review never writes a durable correction,
Review Decision or finalization, and never calls the durable repository.

The carry is applied at the evaluation harness's own model-call boundary: the
field-role client appends a patterns-only guidance block to the system prompt of
its value stages (document, record, entry), mirroring the durable path's
correction-example shape, and the round records the guidance it used in its
pins. The product extraction request, method and fingerprint are untouched, so
no durable admission can send this input.

### D5: Reviewer effort is the count of value changes needed to reach gold

Effort classifies each field's change into:

- `edited`: the field keeps values but at least one value differs.
- `rejected`: the field has predicted values and gold has none.
- `added`: the field has no predicted values and gold has some.
- `deleted`: the field keeps some values and loses individual extra values.

`effort = edited + rejected + added + deleted`, reported with the four counts
separately and normalized per field, per record and per document. In shadow
mode there is no second pass, so no re-edit churn is counted.

### D6: Evidence-anchor accuracy is coverage

Per round, coverage is the share of populated, grounding-eligible record leaves
that carry at least one locatable Evidence anchor. It reuses the existing
`link_rate` and `eligible_link_rate` computation, and reports the eligible
denominator beside the raw one. The metric is named coverage, never
correctness: a link is not independent proof that the value is entailed.

### D7: The watcher detects readiness; no surface action starts a run

Once a Project Context has both the uploaded gold sheet (with rows) and at least
one ingested document, the watcher starts the pipeline; there is no run,
register, approve or finalize action and no need to wait for a researcher's
review. The rounds run in order (pilot-1, then pilot-2, then batch), and
completed cells are reused so an interrupted run resumes rather than repeating
model work. A later re-upload or re-run appends new round revisions. pilot-2
extracts with pilot-1's shadow-review differences carried as guidance, and the
batch extracts with pilot-2's; the carry stays evaluation-only and never becomes
durable project guidance. Because each later round consumes the previous
round's review output, only pilot-1 is an independent measurement; the report
labels pilot-2 and the batch as review-fed and separates same-pair improvement
from transfer to the remaining documents.

### D8: The feature is developer-gated

An environment switch (for example `FREE_DEVELOPER_EVAL=1`) enables the watcher
and the read-only panel. It is off by default and off in the researcher product;
enabling it on the Spark deployment is an explicit operator action. The
read-only surface still enforces authenticated ownership: a researcher sees only
their own Project Contexts' rounds. No environment switch can enable it without
authentication.

### D9: Exhaustiveness is explicit

The gold version carries an `exhaustive` flag. When it is true, predicted values
with no gold counterpart are true false positives; when it is false, they are
unscored extra predictions reported in a review queue, matching the ablation
study's convention. The flag defaults to true for an uploaded "standard
answer" sheet, and that default is confirmed: an uploaded answer sheet is
exhaustive unless it is explicitly marked otherwise.

### D10: The schema comes from the gold header row

The evaluator uploads only documents and the gold sheet, so the pipeline builds
its Extraction Schema from the gold columns: every field column becomes a
`string` field, in sheet order, and the record scope follows the configured
strategy — `document` (Article) by default, `records` (Catalog) when the sheet
carries several rows per document. Field identity is derived deterministically
from the column name, so the same sheet always produces the same schema and the
gold columns and extracted fields line up by construction. A richer schema is a
later, explicit configuration, not a hidden inference.

### D11: A dev-only judge layer scores only the pairs strict matching could not confirm

Strict normalized matching stays the primary score. The harness sends each
(document, field) pair strict matching did not confirm to the deployment's
reasoning provider with a pinned prompt version and a strict JSON verdict
(`match`/`extra`/`uncertain`, plus the gold values it found missing). A pair
whose call fails stays unjudged rather than counting as wrong, and the judge
layer reports its own precision, recall and F1 beside the strict numbers with
judged and unjudged counts; every request and verdict is captured under the
round. It is developer-only (`FREE_EVAL_JUDGE`, on by default for the watcher)
and a diagnostic, never ground truth: the strict number remains the one
comparable across runs.

## Risks / Trade-offs

- Catalog record alignment is ambiguous → align first, report unmatched and
  extra records separately, and never let an unmatched record silently change
  precision or recall.
- A non-exhaustive gold sheet inflates false positives → the per-version
  `exhaustive` flag switches to the unscored convention; the report states which
  convention was used.
- A later round consumes the previous round's review output, so its accuracy is
  not independent → label pilot-2 and the batch as review-fed, and report the
  same-pair change separately from the batch's transfer to the remaining
  documents.
- The pipeline runs its own evaluation extractions, so those results are
  evaluation work, not a researcher's production Extractions → every round is
  labelled as evaluation, pins its own inputs, and never writes into a
  researcher's review state.
- The developer switch ships in the same image as production → default off, and
  tests assert that with the switch off no route, trigger or panel is
  registered.
- Spark cost and latency → the batch is the only full-set pass, both pilots
  reuse the same two documents and their completed cells, and an interrupted
  run resumes instead of repeating model work.
- A large gold sheet or document set → the upload contract bounds both, and the
  pipeline stores metrics rather than copying answers into the round record.

## Migration Plan

1. Add a forward migration: nullable `rows` (and `exhaustive`) on
   `ProjectSpreadsheetVersion`, and the `EvaluationRound` table with its
   project cascade and indexes. Existing rows stay valid with null `rows`.
2. Deploy with `FREE_DEVELOPER_EVAL` unset: no trigger, route or panel is
   active, and uploads keep their current behavior.
3. Enable the switch on the Spark deployment to evaluate rounds.
4. Rollback is disabling the switch; data remains readable and no researcher
   behavior changes.

## Open Questions

- Decide whether the panel needs a per-member and per-field drill-down in the
  first slice or a round-level summary is enough.

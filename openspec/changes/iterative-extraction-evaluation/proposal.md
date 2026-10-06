## Why

The developer loop for "pilot a few documents, then run the whole set" exists only
as an offline Python CLI (`experiments/extraction/iterative_eval.py`) that a
developer runs by hand against a golden workbook on disk. It cannot be started
from the Spark deployment, does not run the fixed two-pilot-then-batch pipeline,
and carries neither an evidence-anchor metric nor a reviewer-effort metric. The
project spreadsheet upload exists but reads only its header row, so an uploaded
gold answer sheet cannot be evaluated at all today.

## What Changes

- Persist an uploaded gold answer sheet as an immutable, project-scoped gold
  corpus version whose rows map to Source Documents. The existing
  schema-suggestion path keeps reading only the header row and is unchanged.
- Define a fixed evaluation pipeline: a pilot over two documents, a second pilot
  over the same two documents, then a batch over every uploaded document. Each
  round runs its own extraction and pins the gold corpus version, its documents,
  the Schema Revision and Extraction Method, and the result/decision cut it read.
- Start the whole pipeline from one developer action: uploading the documents and
  the gold sheet begins the three rounds and publishes their metrics, with
  resumable cells so an interrupted run continues instead of repeating work. No
  further frontend action is needed.
- Add a shadow auto-review: compare each round's saved extraction values against
  the gold corpus with the review's own alignment rules, and count effort as
  EDIT plus REJECT plus added and removed values. A shadow review writes no
  review decision, correction or finalization into durable state.
- Report, per round: value precision, recall and F1 (micro, macro and per
  field), evidence-anchor coverage (the share of grounded-eligible populated
  values carrying at least one locatable anchor), and shadow-reviewer effort.
- Add a developer-only semantic judge beside the strict score: only the pairs
  strict matching could not confirm go to the deployment's reasoning model,
  which returns a structured verdict reported with its own precision, recall
  and F1 and its judged/unjudged counts.
- Run the pipeline and its scoring behind a developer-only deployment switch and
  show the three rounds and their metrics on a read-only developer surface; with
  the switch off, researcher-facing behavior and routes are unchanged.

**BREAKING**: none.

## Capabilities

### New Capabilities

- `gold-standard-corpus`: the project's uploaded spreadsheet becomes a
  versioned, owner-scoped answer corpus with row values and Source Document
  mapping, and the developer evaluation reads a named version of it.
- `iterative-extraction-evaluation`: a one-action pipeline that runs two pilots
  over the same two documents and then a batch over all documents, and reports
  per-round value precision, recall and F1, evidence-anchor coverage,
  shadow-reviewer effort, and the developer-only surface that shows them.

### Modified Capabilities

None. The researcher-facing review, extraction, admission and ingestion
requirements stay as they are; evaluation is separate developer work that does
not change them.

## Impact

- Database: a gold corpus version carries rows and Source Document mappings; a
  developer evaluation round record pins its inputs and metrics. New authored
  forward migration and contract snapshot.
- Studio: project spreadsheet upload reads rows for the gold corpus in addition
  to the header row it already reads for schema suggestion; a developer-gated
  read surface and panel; no change when the switch is off.
- Parsing Service: the iterative harness gains a fixed three-round pipeline
  (two-document pilot, same two-document pilot, all-document batch), record
  alignment, evidence-anchor coverage and shadow-review effort, and runs behind
  a developer-gated entrypoint over pinned source runs.
- Verification: unit tests for row parsing, mapping errors, scoring, alignment
  and effort; PostgreSQL checks for the gold corpus and round records; a
  developer-surface check; documentation of the round contract and its limits.

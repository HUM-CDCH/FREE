# Tasks

## 1. Confirm the open definitions

- [x] 1.1 Record the confirmed default: an uploaded standard-answer sheet is `exhaustive`, so a prediction with no gold counterpart is a false positive (design D9).
- [x] 1.2 Record the confirmed pipeline: pilot-2 carries pilot-1's shadow-review differences as evaluation-only guidance, the batch carries pilot-2's, and the two pilot documents are the first two in upload order unless configured. Drill-down depth stays open.

## 2. Gold corpus rows

- [x] 2.1 Author the forward migration adding nullable `rows` and `exhaustive` to `ProjectSpreadsheetVersion`; regenerate the contract snapshot and update the migration tests.
- [x] 2.2 Extend `_spreadsheet_schema.ts` to read the first worksheet's data rows beside the header row, keeping the header-only schema-suggestion behavior byte-identical; test blank rows, malformed workbooks and a missing header.
- [x] 2.3 Store rows on upload in `project_spreadsheets.ts` and `project-store.ts` with the existing ownership and append-only rules; test that a re-upload appends and never mutates a prior version, and that an unreadable workbook appends nothing.
- [x] 2.4 Map rows to Source Documents by the file-name column and return an error naming both the unmatched file name and the known documents; test a matched row, an unmatched row and several rows for one document.
- [x] 2.5 Record and default `exhaustive` on the version (the store defaults it to true and the record exposes it); the exhaustive-versus-unscored scoring assertion lands with 4.3.

## 3. Pipeline and round records

- [x] 3.1 Add the `EvaluationRound` model (Project Context cascade, gold version, documents, Schema Revision and method pins, Extractions, snapshot/decision cuts, label, status, immutable metrics JSON) with its migration, contract snapshot and indexes.
- [x] 3.2 Implement store methods to append and list an evaluation revision, read one by id, and enforce ownership; cover them with unit tests and a PostgreSQL check including project-deletion cascade.
- [x] 3.3 Extend `iterative_eval.py` into the fixed pipeline: pilot-1 over two documents, pilot-2 over the same two documents, then batch over every uploaded document; keep cell-level resume and the existing CLI behavior.
- [x] 3.4 Run the three rounds in order through the existing extract entrypoint, pin each round's documents, schema/method and read cuts, and record a per-round status even when a round fails.
- [x] 3.5 Carry a round's shadow-review differences into the next round as evaluation-only guidance (pilot-1 into pilot-2, pilot-2 into the batch), with no durable correction or Project guidance; test that the carry reaches the next round and labels it review-fed.

## 4. Scoring

- [x] 4.1 Extract the pure scoring half of `iterative_eval.py` into a function over gold rows, per-member values and Evidence, and pins; keep the existing CLI and its tests passing.
- [x] 4.2 Align records before comparing values one-to-one and mutually by the record-identity field (`identity`, defaulting to `amino_acid_hydroxyproline_value` when present, else the first field); test Catalog fixtures and report unmatched records separately.
- [x] 4.3 Compute micro, macro and per-field precision, recall and F1, handling failed or missing members and exhaustive versus unscored extras; verify against hand-calculated examples.
- [x] 4.4 Compute evidence-anchor coverage from the existing `link_rate` and `eligible_link_rate` logic, excluding policy-skipped leaves and reporting the eligible denominator; test eligible, skipped and ungrounded leaves.
- [x] 4.5 Implement the shadow review and its effort counts (edited, rejected, added, deleted, with their sum); test each classification and assert that evaluation creates no review decision, correction, decision version or finalization.

## 5. Developer watcher and read-only surface

- [x] 5.1 Build the watcher's selection and config: find Project Contexts with stored gold rows and at least one ingested document, derive the Extraction Schema from the gold header columns (Article's `document` scope by default), write the gold rows to a workbook, and assemble the pipeline config; test the derivation and config builder.
- [x] 5.2 Implement the watcher loop: poll, run the fixed pipeline, and write one `EvaluationRound` row per round (PENDING then terminal) with its pins and metrics, skipping a gold version already evaluated; keep it re-runnable and safe to interrupt.
- [x] 5.3 Verify resume and append: an interrupted pipeline continues from completed cells, and a second watcher run (or a re-upload) appends new evaluation revisions instead of overwriting the first.
- [x] 5.4 Add the developer-gated, read-only Studio surface listing the three rounds with value P/R/F1, anchor coverage and effort plus the gold version and pins; enforce ownership, and test that a non-owner receives not-found and that the switch off registers nothing.
- [x] 5.5 Document the round contract, metric definitions and limits in `prototypes/parsing_service/docs/extraction-experiments.md`, and record how to run the watcher and enable `FREE_DEVELOPER_EVAL` on the Spark deployment.

## 6. Verification and delivery

- [ ] 6.1 Run the focused Python and Studio unit tests for row parsing, mapping, scoring, alignment, coverage and effort; fix findings.
- [ ] 6.2 Run the PostgreSQL checks for gold rows, round append and ownership against a disposable loopback `free_test_*` database.
- [ ] 6.3 Run typecheck, lint and the applicable unit tiers; record the tested boundaries and results in a dated `docs/validation/` record.
- [ ] 6.4 Review the final diff against the specs and design, resolve findings, and open the reviewable change per CONTRIBUTING.

Outcome note: this change is developer-only and stays inert with `FREE_DEVELOPER_EVAL` unset; the researcher product contract is unchanged.

# Handoff — grounding lab (2026-09-05)

For a new session picking up `prototypes/grounding_lab` on branch
`experiment/radical-context-prune`. Never push or merge this branch.

## State

- Follow-up authorized after the completed comparison: bounded record batches,
  explicit scope/completion checks, whole-workflow timing, and quote/E candidate
  fallback. Development work is in `experiments/2026-09-05-bounded/PROTOCOL.md`.
  The original experiment remains frozen. New code lives in
  `scripts/bounded-extraction.mts`, `grounding_lab/bounded_scoring.py`, and
  `grounding_lab/bounded_evaluation.py`; no production integration.
  This follow-up is now complete: `RESULTS.md` and `evaluation.json` contain
  the adjudicated comparison. All model jobs and both labeling rounds finished.
  Three attempts remain visible: one aborted after invalid discovery, one
  completed with missing required context, and one valid completed comparison.
  The final attempt has both 20-record identities and mandatory context intact.
  Quote-only improves evidence quality; the hybrid adds 17 correct suggestions
  versus 26 new erroneous suggestions (23 wrong anchors, 3 unsupported values).
  Keep the hybrid unpromoted. There is still no production winner.
  `CANDIDATE_FREEZE.json` preserves the development implementation, not approval.
  1,203 emitted values have 1,053 distinct blind judgments, 99 adjudications,
  and one unresolved title interpretation. Labels are model-generated.
  98 Python and 12 Node checks pass; the previous freeze is unchanged.
  No additional family was opened. The provided folder's remaining Matthias
  series is one related family; additional independent sources are still needed.

- Tag `grounding-lab-freeze-2026-09-04` (commit `0af8ff0a`) is the audited
  state. Everything since is uncommitted in the work tree; `git status`
  lists it. The root `tmp/` and `skills-lock.json` are not ours.
- [`AUDIT.md`](AUDIT.md) is the results entry point. The dated experiment
  keeps its detailed pruning and paired-evaluation reports under
  `experiments/2026-09-05/`. [`README.md`](README.md) has reproduction commands.
- The 2026-09-05 experiment is complete. All model jobs and labeling rounds
  finished. The immutable configuration is `experiments/2026-09-05/freeze.json`;
  preserve every attempt, blind packet and prediction. No holdout retry was run.

## 2026-09-05 experiment

- Pruning is complete: nine warmed, rotated runs retain E. Both pruning
  variants preserve recoverable gold but pass six fewer correct values and
  improve p95 in only one of three repetitions. Reproduction and all counts:
  `experiments/2026-09-05/pruning/SUMMARY.md`.
- All four original PDFs parsed. Eight frozen full-source Qwen calls produced
  four runner-valid completions and four failures. Beier quote (25 records)
  and Bosch baseline (21 records) remain failed diagnostic outputs; Wiermann
  and Bosch quote calls exhausted the output budget. No prefix was salvaged.
  Six complete typed outputs received frozen E replay; no labels tune it.
- Beier is an overlap-flagged transfer case: Menz appeared in earlier labeled
  output. Keep it in the comparison but exclude it from strictly untouched
  summaries. Source-only audits and first-20 manifests live beside each source.
- Every family received two fresh blind labelers and a separate adjudicator.
  All 2,709 populated emitted values are covered by 2,687 distinct claims;
  326 disagreements were adjudicated and five remain unresolved. Model labels
  are not human ground truth. `labeling_runs.json` records actors and hashes.
- Results: `experiments/2026-09-05/EVALUATION.md` and `evaluation.json`.
  Only Kirsch has two runner-valid arms; quote-only improves correct evidence
  versus E on the same values but leaves more missing evidence and takes
  longer than baseline plus E. No production replacement is established.
- `WORKFLOW_TIMINGS.md` distinguishes core timers from broader file-boundary
  spans including risk and audit-file work. `REPRODUCIBILITY.md`,
  `VALIDATION.md`, `validation.json` and `EXECUTION.md` retain checks and caveats.
- The successful development quote pilot and its earlier HTTP timeout are
  retained under `experiments/2026-09-05/pilot`. Quote occurrence is location
  evidence, not a semantic support label.

## Follow-up experiment

- `model_benchmark --dump` is now auditable: routes, proposed/gold anchors,
  all candidate raw scores, unclipped margins, structural features and timing.
- `--bare-number-prune` and `--row-prune` are conservative candidate-only
  ablations. Neither gates singleton hits or auto-links a pruned singleton.
- `review_risk.py` emits exploratory leave-one-Extraction-out `valueRiskScore`,
  `evidenceRiskScore` and `reviewRiskScore`; it never auto-accepts.
- The instrumented E replay remains best. See `AUDIT.md`; generated reports
  are `EXTRACTED_CV6_*_NEMOTRON*.md` and auditable dumps are under `outcomes/`.
- `label-review` no longer hard-codes `dataset`, and extractor-output checks
  now reject the `finishReason='length'` runaway before benchmarking.
- Direct checks pass: 95 Python tests and 10 Node tests. The pnpm shim itself
  could not verify its registry signature in this environment, so tests were
  run with the existing `.venv` and Node directly.

## Production status

One contract change is applied (2026-09-06): every production `EvidenceLink`
now carries `verbatim` (value is a bounded token of the linked anchor) and
`lexicalHits` (candidate anchors containing it), computed in
`packages/extraction/src/lexical.ts`, a port of this lab's `normalize` and
`bounded_contains` that replays `tests/test_pipeline.py`'s cases; change
both together. Studio shows a "Check" badge and a
"To check" count from them. No score, no auto-accept, no reranker; the
benchmark and risk-ranking work remains isolated in this lab.

## What exists

- `grounding_lab/pipeline.py`: lexical tier, sibling gate
  (`gated_lexical_tier`), cached `normalize`, cross-encoder and NLI scorers.
  Policy E reproduces with the gate off.
- `grounding_lab/model_benchmark.py`: `--sibling-gate`, `--cv`, `--claims`,
  `--dump`; whole-path latency with p95 and per-document index ms.
- `grounding_lab/raw_claims.py --sheet [--sample N]`,
  `grounding_lab/label_review.py` (abstention rule for typed-schema
  documents), `grounding_lab/llm_hitset.py --claims` (LLM under E's
  contract), `scripts/extract-real.mts` (uses `schema.json` when present).
- `final_dataset_3/<doc>/`: `schema.json`, hand labels `claims.json`,
  extractor labels `claims_extracted.json` with `labeling_notes.md`,
  `extracted_raw.json` and `extracted_meta.json`, the parsed document and
  anchors. `LABELS.md` documents both label sets.
- Reports kept: `EXTRACTED_*.md` (headline runs), `RAW_EXTRACTION_BLIND.md`,
  `outcomes/*.jsonl` (per-claim outcomes). Everything about the retired
  fixtures and rejected policies was deleted on 2026-09-04; the numbers that
  matter are in `AUDIT.md`, the files are in git history before that date.

## Open for the user

- Commit or not; nothing is staged.
- `final_dataset_3/*/document.md`, `parsed_document.json`, `anchors.json`
  are full-text derivatives of six copyrighted catalogues (PDFs in the
  git-ignored `final_sources_3/`). Drop them if that is too much; labels and
  schemas stand alone.
- Labeler conventions a stricter reading would flip are listed at the end of
  `final_dataset_3/LABELS.md`.

## Infrastructure

- From `prototypes/grounding_lab`, python is `.venv/Scripts/python.exe -X utf8`;
  `pnpm --filter grounding-lab <script>` paths are relative to the package.
- Local Ollama `http://127.0.0.1:11434` serves `qwen3.8:latest` (27B Q4) on
  one RTX 4090 24 GB and cuts every prompt at 16k tokens; large documents are
  windowed by `extract-real`. Nemotron 1B fits alongside it.
- DGX Spark Ollama: `OLLAMA_HOST=http://spark.cdch-dgxspark.lan.ku.dk:11434`,
  model `qwen3.8:27b`, 262k context, about 12 s per claim with thinking.
- Parsing a new PDF: `prototypes/parsing_service/.venv/Scripts/python.exe -X utf8
  scripts/parse-source.py SOURCE.pdf <root>/<doc>` then `pnpm --filter
  grounding-lab dump-anchors <root>/<doc>/parsed_document.json
  <root>/<doc>/anchors.json`. OCR of a 50-page scan takes 15–25 minutes.
- `label_review` needs `expectedLexicalHitIds` on unsupported claims with
  lexical hits; fill them mechanically after labeling.

Memory note for future sessions: `grounding-lab-audit-2026-09` in the
project memory index.

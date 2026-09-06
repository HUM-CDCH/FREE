# Grounding Lab

Answers one design question: can a tiered non-LLM pipeline (lexical
containment, then a cross-encoder inside the lexical hit set) replace LLM
evidence grounding when the aim is to catch extractor errors for a reviewer?
Results, verdict and the steps toward production are in
[AUDIT.md](AUDIT.md). Nothing here changes FREE.

The follow-up bounded-batch development experiment is documented in
[its protocol](experiments/2026-09-05-bounded/PROTOCOL.md). It preserves the
completed four-family comparison and checks record scope before promotion.

## Setup

```
pnpm --filter grounding-lab install:python   # uv sync; torch (CUDA cu130 build, CPU works)
pnpm --filter grounding-lab test             # lexical-tier checks, no torch needed
```

Models download from Hugging Face on first run; revisions are pinned in
`grounding_lab/model_benchmark.py`.

## Datasets

Historical development numbers use typed-schema sets labeled blind from real
extractor output (`final_dataset_3/`, protocol below). The frozen full-PDF
four-family evaluation is under `experiments/2026-09-05` (commands below).
`dataset/`,
`final_dataset/` and `final_dataset_2/` are regression fixtures: their claims
were copied verbatim out of the anchors, so 248 of their 283 linkable claims
cannot produce a wrong link (provenance in
[FINAL_TEST_SOURCES.md](FINAL_TEST_SOURCES.md)). Each `<root>/<doc>/` needs
`anchors.json` and a claims file:

1. Parse with the Parsing Service's own environment (never add Docling here):

   ```powershell
   pnpm --filter parsing-service install:python
   prototypes/parsing_service/.venv/Scripts/python.exe -X utf8 prototypes/grounding_lab/scripts/parse-source.py SOURCE.pdf prototypes/grounding_lab/<root>/<doc>
   ```

2. Dump anchors in FREE's canonical reading order (data cells get row and
   column headers as context, header cells only their own text):

   ```
   pnpm --filter grounding-lab dump-anchors <root>/<doc>/parsed_document.json <root>/<doc>/anchors.json
   ```

3. Write a realistic `schema.json` for the document (example-shaped:
   `"string"`, `0`, `0.0`, `true`, `"1900-01-01"`, `["string"]`), run the real
   extractor with it and turn the output into an unlabeled sheet:

   ```
   pnpm --filter grounding-lab extract-real -- <root> --only <doc>
   .venv/Scripts/python.exe -X utf8 -m grounding_lab.raw_claims <root> --sheet --sample 60
   ```

   `claims_extracted.json` holds one claim per emitted leaf, typed as the
   extractor emitted it, with the record's other scalars as `context` (the
   sibling shape production carries) and `goldAnchorIds: null`.

4. Have someone who has not read this package label the sheet against
   `document.md` and `anchors.json`. `goldAnchorIds` lists every anchor a
   reviewer would accept; `[]` marks an unsupported value, with a note naming
   its kind: (a) never stated, (b) stated under another meaning, (c) computed
   or paraphrased. The labeler never sees the grounding code, its reports or
   earlier labels: the first blind set moved policy E from 97% to 55%, and
   that gap sat in code, not thresholds. Hand-written `claims.json` files
   (`goldAnchorId`, `context`, `expectedLexicalHitIds`) still load.

5. Validate natural output: `pnpm --filter grounding-lab label-review -- <root> --claims claims_extracted.json --natural-output`
   fails when extraction ended early, on a gold id missing from `anchors.json`,
   missing labels, or an unexpected lexical hit on a must-abstain claim.
   Unsupported lexical prevalence is reported without selecting documents on
   it. Omit `--natural-output` for constructed challenge sets, where at least
   half of unsupported claims must occur in the text under another meaning.

## Running

```bash
.venv/Scripts/python.exe -X utf8 -m grounding_lab.model_benchmark final_dataset_3 \
  --stage rerank --retriever mini --reranker nemotron-1b --cv 6 --sibling-gate \
  --claims claims_extracted.json --dump outcomes/run.jsonl
```

Use `--bare-number-prune` instead of `--sibling-gate` to test the narrower
ablation: it never gates a singleton hit and only reduces repeated bare-number
hit sets to exact-value cells with same-row sibling support. `--row-prune`
applies the same candidate-only rule to every multi-hit value. `--dump`
includes the chosen and gold anchors, every candidate/raw score, the unclipped
margin, route, pruning diagnostics, structural anchor fields, suffix ambiguity,
and timings; `legacyConfidence` is retained only to audit the old decision
rule. Regenerate anchors with the current `dump-anchors` before expecting
logical-table and row identities in an older dataset.

Generate exploratory per-claim review priorities from an auditable dump:

```bash
.venv/Scripts/python.exe -X utf8 -m grounding_lab.review_risk \
  outcomes/run.jsonl --output outcomes/run-ranked.jsonl
```

The output separates `valueRiskScore` from `evidenceRiskScore` and combines
them as `reviewRiskScore`. Scores are leave-one-document-out development
diagnostics, not production confidence, and do not authorize auto-accept.

Defaults are policy E (`--candidates hitset --claim-mode rich-hitset
--zero-hit abstain`). `--sibling-gate` adds the field check before any
auto-accept; `--cv N` tunes thresholds per fold, `--abstain-threshold` and
`--accept-threshold` fix them; `--dump` writes one outcome per claim
(link-correct, link-wrong, review, abstain) for the reviewer's-view table.
Latency columns are the whole per-claim path after a one-off anchor
normalization per document.

The LLM comparison under the same contract (field name, siblings, hit set)
needs Ollama (`OLLAMA_HOST` for a remote server):

```bash
.venv/Scripts/python.exe -X utf8 -m grounding_lab.llm_hitset final_dataset_3 qwen3.8:latest --think --claims claims_extracted.json
```

Jina models are non-commercial; Liquid models carry the LFM Open License v1.0
commercial-use threshold. Neither may be promoted without a license review.

## Frozen paired experiment (2026-09-05)

Completed results: [comparison](experiments/2026-09-05/EVALUATION.md),
[workflow timing](experiments/2026-09-05/WORKFLOW_TIMINGS.md),
[validation](experiments/2026-09-05/VALIDATION.md), and
[pruning](experiments/2026-09-05/pruning/SUMMARY.md). Four of eight generation
attempts failed; diagnostic recoveries remain failed. Only Kirsch has two
runner-valid arms, and Beier is excluded from strictly untouched summaries.

The user-selected full PDFs and schemas live in `experiments/2026-09-05/holdout`.
The first 20 definite burial records are requested, with all emitted populated
values labelled. Source files stay in Downloads; `sources.json` records their
hashes. Run `scripts/prepare-holdout.py --parse` with the Parsing Service Python
environment, then `dump-anchors` for each completed source. The preparation
script skips completed parses; do not run two parsers for the same source.

From this package directory:

```powershell
.venv/Scripts/python.exe -X utf8 -m grounding_lab.pruning_experiment final_dataset_3 experiments/2026-09-05/pruning-replay
.venv/Scripts/python.exe -X utf8 -m grounding_lab.holdout_evaluation experiments/2026-09-05 freeze
node --experimental-strip-types scripts/quote-extraction.mts --source experiments/2026-09-05/holdout/beier --output experiments/2026-09-05/runs/baseline/beier --arm baseline
node --experimental-strip-types scripts/quote-extraction.mts --source experiments/2026-09-05/holdout/beier --output experiments/2026-09-05/runs/quote/beier --arm quote
```

Repeat the paired commands for Bosch, Wiermann and Kirsch. The runner pins the
Spark Qwen digest and tested Ollama version, disables prompt truncation and
context shifting, checks typed output/completion, and retains failed attempts.
It requires only source and schema, never pre-existing claims or gold anchors.
`instruction.txt` supplies source-specific conventions. Each prepared request
binds its full canonical source, schema, instructions and model request by hash.
The existing dated experiment is already frozen: use `verify`, not `freeze`,
when continuing it. Use a new experiment directory for a replay.

```powershell
.venv/Scripts/python.exe -X utf8 -m grounding_lab.holdout_evaluation experiments/2026-09-05 score
.venv/Scripts/python.exe -X utf8 -m grounding_lab.holdout_evaluation experiments/2026-09-05 prepare
# Independent labelers write blind/<family>/labels-a.json and labels-b.json.
.venv/Scripts/python.exe -X utf8 -m grounding_lab.holdout_evaluation experiments/2026-09-05 disagreements
# A separate adjudicator writes adjudicated.json for exactly the disagreements.
.venv/Scripts/python.exe -X utf8 -m grounding_lab.holdout_evaluation experiments/2026-09-05 finalize
.venv/Scripts/python.exe -X utf8 -m grounding_lab.label_review experiments/2026-09-05/runs/baseline --claims claims_extracted.json --natural-output
.venv/Scripts/python.exe -X utf8 -m grounding_lab.holdout_report experiments/2026-09-05
```

Validate the quote arm likewise. A gold label is `goldAnchorSets: [["a", "b"],
["c"]]`: either both `a` and `b`, or `c`, support the value. Each blind label
also records `valueSupported`: original-PDF support is distinct from canonical
anchor availability. `valueSupported: true` with empty `goldAnchorSets: []`
means the value is supported but acceptable canonical evidence is unavailable;
false with empty sets means unsupported. Null support is allowed only for an
explicitly unresolved judgment. Null gold sets remain unlabelled and fail
validation. Legacy labels without `valueSupported` infer support from gold.
The blinded
package excludes arm identities, generated quotes and policy predictions.
Scores on this small corpus remain exploratory, including the frozen scores.
`score`, `prepare`, `disagreements` and `finalize` accept `--family FAMILY`
to process completed pairs while other model calls finish. Existing blind
packets cannot be reshuffled. Nested inventory claims retain burial context.
Beier remains a reported transfer case because Menz appeared in prior labeled
output; the strictly untouched summaries exclude that family.

A normally completed, typed output that exceeds the record limit remains a
failed attempt. Preserve every emitted value for diagnostic labeling with:

```powershell
node --experimental-strip-types scripts/diagnostic-output.mts --run experiments/2026-09-05/runs/quote/beier --source experiments/2026-09-05/holdout/beier
```

This writes only `diagnostic_*` sidecars. It never trims records or changes the
original failure metadata; incomplete or malformed generations cannot be
recovered this way. Conforming-output summaries exclude diagnostic outputs.

Run the lab checks directly with the installed environments:

```powershell
.venv/Scripts/python.exe -X utf8 -m unittest discover -s tests
node --experimental-strip-types --test scripts/dump-anchors.test.mts scripts/quote-extraction.test.mts scripts/diagnostic-output.test.mts
```

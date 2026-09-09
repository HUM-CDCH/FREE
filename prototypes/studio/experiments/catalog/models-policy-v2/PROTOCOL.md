# Models on policy v1 — revision 2

Date: 2026-09-09. Status: implementation and preflight; inference requires `freeze.json`.
Origin: user-approved comparison plan. Production baseline: commit `7e27c514`.

Use the production catalog executor with `recordBatchSize=5`,
`groundingGroupSize=5`, field-aware grounding and lexical links disabled.
No production defaults, persisted research records or model routes change.

Run baseline Qwen, HunyuanOCR, Nanonets-OCR-s, NaviDC-OCR, Nemotron Parse 2.0,
EVIE-4.5B, NeoMME-260M and GLiNER 2.5 multilingual on Beier and five Danish
reports. Beier uses its original schema; each Danish report uses both that
schema and the shared Danish schema. Two repetitions give 176 executor runs.
Failures and empty discovery remain in the denominator. Do not drop an arm.

Freeze source code, schemas, references, source hashes, selected image hashes,
checkpoint revisions, runtime versions and the installed Qwen digest before
inference. Never overwrite completed outputs. Changed frozen files require
a new root/revision. Verify saved Beier OCR before reuse. Generate Danish OCR
once per model/document, preserving failed/truncated pages and real crop
geometry. Use 200-DPI renders, a 2,000-pixel longest edge and the handoff's
bounded generation parameters and native loaders. Discovery must process
the converted representation; no Beier-number splitter or copied old anchors.

Retriever queries contain actual baseline claims, field descriptions and
record context, never reference answers. Rank fixed PDF page/column images.
EVIE uses its 2048 head; NeoMME uses native MeanMaxSim (dense is diagnostic).
Map top-three regions to canonical anchors inside the claim's record;
retain and count anchors without reliable geometry. Qwen grounds the union;
validate every returned link against that claim's permitted set. A retrieval
miss must not silently restore candidates or auto-link the first result.

GLiNER extracts per discovered record and assembles the executor's exact
five-record routing envelope. Validate source offsets, preserve the first
offset-valid scalar span (then apply type validation, matching the handoff's
existing selection) and distinct array spans in source order. Empty unsupported
fields stay empty; Qwen provides grouped grounding, never value completion.
Native forwards, executor requests and LLM calls are separate measurements.

Replay unchanged upstream stages from the same baseline repetition, guarded
by exact request hashes. Changed stages run freshly. GPU jobs run serially;
reverse independent comparison order in repetition two. Baseline must precede
dependent arms. Report replayed, reused and fresh costs separately; a composed
timing is not an observed end-to-end latency.

The Danish schema extracts individually described graves: identifier, site,
grave type, rite, explicit grave axis, dating, and distinct grave goods.
Preserve Danish wording and uncertainty; body/head orientation is insufficient.
Source-review inventories before inference, including thematic grave lists.
Beier entry 228 has findspot `1. Gleinaer Berg`; retain original-reference
scores separately. Reference review is agent-only, not independent validation.

Score record recall/duplicates/omissions; supported values and disappeared
fields; unsupported populated values; fixed-denominator supported-link
coverage; wrong-record/wrong-passage links and links on unsupported values.
Report localization granularity separately, OCR completeness, top-three
candidate recall, tokens, native forwards, warm inference/load cost and peak
GPU memory. A source page match alone earns no passage-level credit. Blind
adjudication queues hide the producing arm. New supported claims/variants must
be applied to all arms through one shared reference/adjudication revision.

Required checks: Fable's nested-batch and routing-key regressions, singleton
versus actual fallback accounting, omitted-field coverage, freeze mismatch,
OCR geometry, span offsets, retrieval boundary enforcement and replay matching.

Qualification requires no loss of correct values or supported-link coverage,
no additional unsupported values/wrong links, and a measured quality or runtime
benefit. No qualification while adjudication is pending. Evaluate mismatch
stress tests separately from intended Danish use. Results include per-document
tables and an error gallery. Production adoption is outside this experiment
and requires a separate full-document deployment acceptance run.

Reproduce from the repository root (PowerShell), using existing installed runtimes:

```powershell
python prototypes/studio/experiments/catalog/models-policy-v2/checks.py
node packages/extraction/node_modules/tsx/dist/cli.mjs prototypes/studio/experiments/catalog/models-policy-v2/checks.ts
python prototypes/studio/experiments/catalog/models-policy-v2/suite.py freeze
python prototypes/studio/experiments/catalog/models-policy-v2/suite.py run
python prototypes/studio/experiments/catalog/models-policy-v2/score.py --out artifacts/catalog-lab/models-policy-v2/report-initial
```

Review `report-initial/blind-review.json` against the original PDFs before
opening `review-arm-bridge.json`. Store decisions and shared extensions in a
new JSON file, then rerun `score.py --adjudications <file> --out <new-directory>`.
Reports and executor outputs are exclusive-create. A failed executor artifact
counts as a result; an interrupted process requires inspection before a new
revision. Native models run in reversed order in repetition two, with image
embeddings shared across schemas within each repetition. Composed costs add
back the original encoding time when embeddings were reused. Candidate recall
is conditional on actual correct proposed claims; Danish page-only references
provide page recall until passage references are explicitly reviewed.

## Closure (recorded after the runs)

All 88 selected runs and `report-final` completed before any frozen file
changed. Two unused bindings in `run.ts` were then renamed to satisfy the
repository lint, so `freeze.json` no longer matches this file and the root
accepts no further runs or reports; `RESULTS.md` here is a verbatim copy of
`report-final/RESULTS.md`. Reviewed in `docs/research/catalog-policy-v1.md`,
section 4.3.

# Extraction research harness: pilot evidence

Historical pilot, preserved. See the [2026-09-30 provenance and evaluator correction](../../research/2026-09-30-extractbench-validation/pilot-correction.md) before interpreting it.

Real-model runs of `prototypes/parsing_service/experiments/harness/` on the DGX Spark (`baratheon`): throwaway containers of the
production worker image, `Qwen/Qwen3.8-27B-FP8` on vLLM (`/tokenize` counted, max context 32768). Each `manifest.json` pins the
study, the resolved dataset, the scoring rules, the served-model identity, every source file of the code that ran (99 files) and
the library versions. Only `dev` was run; `test` was never touched. Full outputs (cells, prompts, replies) stay on the Spark under
`~/free-harness-evidence/harness-{final2,ids,big}/out/`.

These are pilots of a research harness on synthetic data. Three dev documents cannot support a claim about any technique: every
interval below is descriptive.

## What ran

| Directory | Study | Data | Cells |
| --- | --- | --- | --- |
| `synthetic-pilot/` | 9 variants of one baseline plus combined-minus-one | `synth --cases 12 --records 8`: 5 fit, 3 calibration, 3 dev (one group each), 1 test; 8 records of 5 fields per document, 2 chunks each | 33 dev + 8 fit/calibration (`combined`) |
| `ids-smoke/` | layout input + segment-id evidence against the baseline | the 3 dev documents | 6 |
| `big-catalogue/` | baseline, chunk overlap, continuation flags, both | one generated 200-entry, 25-page catalogue (the unify-catalog loop's `big` fixture): 600 gold fields, one group | 6 |

`report-dev.json` is `compare --split dev`; `confidence-*.json` is `confidence --variant combined`; `score-production-*.json` is the
production Catalog v3 artifacts of the unify-catalog loop (`big-ids`, `big-default`) run through `score`, i.e. the same scorer.

## Protocol deviations (read before the numbers)

1. The baseline was not frozen before dev was seen. The first pilot's baseline had no recovery; on real vLLM output, constrained
   greedy decoding sometimes emits whitespace until `max_tokens` (every truncated reply inspected was a whitespace run). Bounded
   recovery (`recovery.subdivide`) was then added to the baseline, on the same dev documents. Earlier pilots are superseded; their
   replies were reused only where the request was byte-identical.
2. `chunking.overlap` was silently dropped by the service's `partition` when a chunk had no spare budget, so the first `overlap`
   arm sent the same requests as the baseline. Overlap is now applied on top of the budget and `compare` reports whether two arms
   sent identical requests. All numbers here are from after the fix.
3. `combined` (overlap + quote) was declared in the study file before any run, not selected on dev. Dev does not favour overlap.
4. `retry` (one retry, no subdivision) and `no-recovery` are compared with the subdividing baseline, not with each other.
5. `ids-smoke` used the older baseline without recovery (its own base cells), so it is not comparable with `synthetic-pilot`.
6. The reports carry `run_code_matches_current: false`: `study.py` gained a not-estimable guard and a caveat after the cells ran.
   Extraction, evaluation and provider code is byte-identical to what ran (the only differing file is `study.py`).
7. About 86% of the dev cold calls were replays of real replies recorded earlier (25 fresh of 185), and `ids-smoke` and `big` ran
   while other cells ran on the same server. `cost_as_if_cold` counts replays at their recorded cost; **compare calls and tokens,
   not seconds**.

## Synthetic pilot, dev (3 documents, 114 gold values; comparator fixed: normalised strings)

| Variant | F1 (P / R) | Missing records | Cross-page strict | Valid replies | Calls | Output tokens |
| --- | --- | --- | --- | --- | --- | --- |
| base (+ bounded recovery) | 0.889 (0.901 / 0.877) | 0 | 2 of 3 | 0.80 | 10 | 4,978 |
| overlap | 0.870 (0.922 / 0.825) | 0 | 2 of 3 | 0.64 | 22 | 14,377 |
| continuation flags | 0.895 (0.895 / 0.895) | 0 | 2 of 3 | 1.00 | 6 | 1,915 |
| quote evidence (+ record disambiguation) | 0.956 (0.956 / 0.956) | 0 | 2 of 3 | 0.69 | 16 | 13,176 |
| quote + model verifier, flag gate | 0.956 | 0 | 2 of 3 | 0.69 | 40 | 17,034 |
| sampling n=3, majority | 0.901 (0.926 / 0.877) | 0 | 3 of 3 | 0.95 | 20 | 7,045 |
| one retry, no subdivision | 0.904 (0.904 / 0.904) | 0 | 2 of 3 | 0.86 | 7 | 3,333 |
| no recovery | 0.842 (0.926 / 0.772) | 4 | 2 of 3 | 0.83 | 6 | 3,032 |
| overlap + quote (declared combined) | 0.904 (0.904 / 0.904) | 0 | 2 of 3 | 0.65 | 20 | 16,675 |

No variant produced a hallucinated or duplicated record. Paired F1 differences against the baseline (3 documents; the percentile
interval of three deltas is not evidence): overlap -0.018, continuation +0.007, quote +0.069, sampling +0.014, no-recovery -0.069,
retry +0.016; verifier against quote 0.000; overlap x quote interaction -0.035.

**The F1 differences are mostly output format, not extraction.** `error-types.json` (post hoc; the study comparator is unchanged)
classifies every wrong value: trailing punctuation (`Eck.` for `Eck`) is 8 of 11 in the baseline, 8 of 8 with overlap, 12 of 12
with continuation flags, 5 of 5 with quote evidence. The other errors are model glitches in the `date` field under constrained
decoding, confirmed in the raw replies: in three baseline dates (one document) a JSON fragment such as
`{"type": "integer", "value": 1875}` in place of `1875`, and in three overlap + quote dates the literal word `value` beside the
correct quote.

Grounding (quote): page hit 1.00, segment hit 1.00, span hit 0.60 (quotes include labels such as `Kreis Moor`; gold spans are the
value), decoy hit 0.00, joint value-and-evidence 0.55. Segment-id evidence (`ids-smoke`): cited 94 of 114, span hit 1.00 because
the harness refines the model's passage choice to the value inside it, so this is not the model localising the value. The
verifier's 63/5/0/0 (tp/fp/fn/tn) contains no genuinely unsupported value; its five false positives are the trailing-period
convention.

Confidence (`combined`): fit (184 values) and calibration (111 values) contain **no wrong values**, so fusion, calibrators and
risk control are **not estimable** (the report says so and does not fit them); LTT and CRC are unavailable below 22 groups
anyway. Raw signals on dev, descriptive only (11 errors in 2 documents): mean value-token probability AUROC 0.83, the
deterministic rank baseline 0.80, first-token probability 0.51, margin 0.46. The `supported` target is dominated by the
span-format effect above and is not informative.

## Big catalogue, one document (200 records, 600 gold fields)

| Arm | F1 | Records matched / hallucinated / duplicated | Calls | Input / output tokens |
| --- | --- | --- | --- | --- |
| harness baseline (fixed 3,000-char chunks, Qwen3.8-27B only) | 0.982 | 200 / 0 / 0 | 5 | 8,344 / 11,062 |
| + overlap | 0.963 | 200 / 0 / 0 | 5 | 8,411 / 11,062 |
| + continuation flags | 1.000 | 200 / 0 / 0 | 5 | 8,529 / 11,152 |
| both | 1.000 | 200 / 0 / 0 | 5 | 8,596 / 11,152 |
| production Catalog v3, `big-ids` (NuExtract fields + Qwen reasoning) | 0.9925 | 200 / 0 / 0 | 401 | 138,905 / 27,869 |
| production Catalog v3, `big-default` | 0.910 | 200 / 46 / 5 | 513 | 198,273 / 66,848 |

Every wrong value in the harness arms is the same convention (`G.` for `G`: 11 in the baseline, 22 with overlap, none with
continuation flags), so the arms differ in how the model writes a terminal period, not in what it finds; the fixture has no
cross-page gold, so continuation cannot have helped by joining records. The production and harness arms use different models and
pipelines: this shows the production arms can be scored by the same evaluator (`--accepted-only` changed nothing because neither
artifact holds proposals), not that either is better. The first-token probability of these 11 errors is above 0.99: AUROC 0.33.

## Files not included

`big-catalogue/dataset.json` names `run: bigrun`, the canonical run directory of the fixture (not copied); its gold is the
loop's generator truth (`docs/plans/2026-09-24-unified-durable-execution-evidence/rev8-tests/make_catalogues.py`, `big()`). The
synthetic dataset regenerates with `python -m experiments.harness synth PATH --cases 12 --records 8`.

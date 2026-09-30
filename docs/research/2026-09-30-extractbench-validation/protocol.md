# ExtractBench development screening, 2026-09-30

Status: protocol frozen before model execution. Baseline `base` is **A0**.
Stacked base: `16819c72cf1ef54bfdf73d4159c5ee65dce048f8` (`feat/unify-catalog-extraction`).
Initial checkpoint: `f5827cd7ab8df2f6f63e9816608822618c4c6a6f`.
Executed implementation: `2a2b6d4586179919accbae7800d5071a7df6cb00`;
its 100-file source aggregate is
`6891fab53ec108e42a3dacde27ff16eac3401a8327e78b041678f251d8498b83`.
After all twelve smoke cells sealed, commit
`677ec96f6fc0765d0396df977098b0d373ac0edb` corrected unknown-usage reporting
after transport failures. Only `model.py` among the pinned source files changed;
the final source aggregate is
`3848aa62401d5185074fdd3321450d8ecc185c5372b17043bb291a7ac4fc1408`.
This correction changes neither successful requests nor scoring. Final live tests
and a generation-disabled replay verified it; original execution artifacts remain
pinned to the earlier revision. Later research/evidence commits change no source bytes.
The v3 production fixture is tracked in that base. No production default changes.

The [selection manifest](../2026-09-30-extractbench-selection.json) pins the dataset
revision, source groups and checksums. Twenty real source groups / twenty selected
representatives: twelve development, eight held out. Seventy-five related documents
are reserved within those groups; they are not seventy-five executed documents.
Length categories are metadata, not train/dev/test. See the
[source audit](../2026-09-30-extractbench-source.md) for terms, grouping uncertainty
and the three development spot-checks. Downloaded PDFs stay in ignored scratch/cache.

All arms use the same existing local Qwen3.8-27B-FP8 server, model revision and image
in `study-smoke.json`; PDFium native line text, frozen per-document source/schema
hashes; temperature 0, seed 20260930, 4096 output tokens, layout input, 4000-character
source chunks, no overlap, exhaustive reading, one worker, one sample, no verifier,
no logprobs or confidence model. Recovery: no repeated identical requests, one level
of source subdivision. The served tokenizer admits input plus reply reserve.

| Arm | Only change from A0 |
| --- | --- |
| A0 / `base` | Explicit `evidence.mode=none`, bounded recovery |
| A1 | `merge.continuation=flags` |
| A2 | `evidence.mode=quote` |
| A3 | `evidence.mode=ids` |

Quote/ID arms share alignment/refinement settings and the same passage rendering.
Both retain model-selected spans before a source-only search for the predicted value
inside those spans. Raw and refined spans, ambiguities and failed alignments persist.
Passage selection, literal localization and semantic support are separate quantities.
No inference stage receives annotations: `run_case` projects to `InferenceCase`, which
has no gold, split or annotation members. Inference schemas strip descriptions,
examples, defaults and enum constants because the upstream schema prose contains
answers/locations. Original schemas/rules remain evaluator-only. This departure,
native text inputs and custom scoring preclude leaderboard comparability.

## Budgets and gates

Development allowance is **500 completion calls total**, divided before execution:
100 for the three smoke documents / twelve cells; 400 reserved for the other nine
selected development documents / thirty-six cells. No automatic budget expansion.
Each cell has a 60-call / 250,000-token cap; counted input plus maximum output is
reserved before a fresh request, including requests in flight. An unfinished attempt
blocks resume until its spending is reconciled. Separate final real-provider tests
have their own small synthetic validation calls and are reported separately.

Smoke admission: all three documents must parse without missing native text pages;
gold-as-prediction scores must be perfect and count invariants hold; configuration
deltas must match declarations; counted requests must fit; no unknown usage or
unsealed budget failures. Inspect the completed smoke cells and resource spending
before preparing/running remaining development cases. Any remaining case that lacks
native text or cannot fit the reserved resources stays visibly unrun. No paid endpoint
fallback, no OCR download, no held-out ingestion or execution. A0 is frozen; smoke
errors do not authorize prompt/schema tuning.

## Evaluation version 2

Raw exact is canonical JSON equality of **raw** field values and acceptable gold:
case, whitespace, punctuation, numeric representation and scalar-array order are retained.
Canonicalized metrics are separate. Record correspondence is established with the
canonical comparators and shared by both views, so a formatting difference does not
change the matched population. Repeated object-array order is handled by that shared
record assignment, not by comparing whole arrays as raw JSON. Field policies are resolved from schema types and,
for public date fields only, the documented `date` comparator:

| Field kind | Canonical comparison |
| --- | --- |
| String | Unicode NFKC, casefold, whitespace collapse; punctuation preserved |
| Verbatim string / boolean | Exact JSON equality |
| Number / integer | Numeric, relative tolerance 1e-9, absolute tolerance 0 |
| Date-tagged benchmark field | Explicit date formats to calendar date; otherwise string normalization |
| Scalar array | Set comparison (explicit harness policy) |
| Object array | Parent-scoped record assignment, then field comparisons; duplicates counted |
| Nested object | Scalar leaves evaluated at their own paths |

Original acceptable value/evidence alternatives and record arrays are retained.
Nonnull leaf `evidence[].value` readings and `expected_output` are acceptable values;
parent array object readings are separate records, never interchangeable values.
Explicit null, missing annotation, missing page and missing box remain distinct.
Optional nonnull readings of null-expected fields are reported separately and counted
in record completeness without enlarging the fixed populated-gold F1 denominator.
Wrong optional values remain precision errors. Missing collections are unannotated;
partial collection gold does not make unmatched predictions hallucinations.

Reports include raw/canonical precision/recall/F1, whole-record completeness, repeated
record completeness/misses/extras/duplicates, failures and fresh/replayed calls/tokens.
The original wrapper document and its repeated records have separate counters.
For ExtractBench, annotated page grounding is value correctness plus any acceptable
annotated page among the selected citations. A top-level object/array citation is
inherited by its descendant leaf checks: this is coarse, custom page grounding,
not word localization or a verified semantic-support label. PDF boxes are retained
unchanged but cannot be scored against this parser's line-only evidence. Missing
localization/semantic labels report null, not a fabricated zero or success.
Verifier flags are scored as error detection (TP/FP/FN/TN), never used to improve F1.

`compare --rescore` produces a new report from integrity-checked original predictions,
with evaluator version/code hash and original manifest identity. It refines saved
quote/ID selections without any new extraction/retrieval/model call; old files remain
unchanged. New execution manifests pin source/service/harness bytes, provider and
library versions. Research score computation does not claim formal certification;
see the [LTT/CRC audit and human-gold plan](../2026-09-30-extraction-harness-methods.md).

# Grounding lab audit — 2026-09-04

Four experiments were run to test the headline claim in
[`MODEL_REPORT.md`](MODEL_REPORT.md) that policy E (lexical containment, single
hit links directly, multi-hit reranked, zero hit abstains) reaches 372/382
correct decisions with 0 wrong links. Each has its own report; this page is the
summary and the verdict.

| experiment | report | what it answers |
|---|---|---|
| 1. Real extractor output | [`RAW_EXTRACTION.md`](RAW_EXTRACTION.md) | Does containment survive typed extractor output? |
| 2. Single-hit traps | [`TRAPS.md`](TRAPS.md) | What happens when a value is present once but under the wrong meaning? |
| 3. Rendering fix + LLM as E's scorer | [`LLM_HITSET.md`](LLM_HITSET.md) | Were the LLM baseline's 33 wrong links real? Is the reranker the reason E wins? |
| 4. Blind set | [`final_dataset_3/LABELS.md`](final_dataset_3/LABELS.md), [`BLIND_E_NEMOTRON.md`](BLIND_E_NEMOTRON.md), [`BLIND_H_NEMOTRON.md`](BLIND_H_NEMOTRON.md), [`BLIND_LLM_HITSET.md`](BLIND_LLM_HITSET.md) | What does E score on labels nobody tuned it against? |

`grounding_lab/pipeline.py` was not modified by any experiment. The code is
frozen at the commit that carries this file.

## Verdict

The 372/382 figure is a property of the labels, not of the pipeline.

- Every hand-authored claim was a verbatim string copied from an anchor. 187 of
  283 linkable claims were single lexical hits, linked at confidence 1.0 and
  never scored; 55 of the 90 multi-hit claims had every hit in the gold set. Only
  35 claims in the corpus could be scored wrong at all.
- On 40 traps where the value occurs exactly once but under the wrong field,
  policy E auto-links 34 wrong at confidence 1.0. Nothing in the pipeline looks
  at the field once a single hit exists.
- On a blind set of six grave catalogues labeled by someone who never saw the
  pipeline, with typed values, policy E scores 91/164 correct decisions, 37
  wrong links, auto-precision 72/109.
- 28 of the LLM baseline's 33 wrong links were a bug in `dump-anchors`, not the
  model. After the fix the LLM makes 1 wrong link on the four documents that fit
  the local GPU.

## 1. Real extractor output

The production entry point (`extractWithModel`, Ollama, qwen3.8 27B) was run on
all 20 documents with schemas derived from the hand-authored field names, and
its raw typed output was grounded with the frozen lexical tier.

| raw claims | zero hits (abstain) | loose only (review) | single hit | 2+ hits |
|---:|---:|---:|---:|---:|
| 597 | 16 (3%) | 3 | 325 (54%) | 253 (42%) |

The hypothesis that typed numbers would defeat containment was wrong:
`normalize` folds `48619695` onto `48.619.695` and `-2.1` onto `-2,1`. The 19
misses are magnitude words (`3200000000` vs "€ 3,2 miljard"), signs derived
from "de moins", unit conversions and OCR spacing. What did change is the
mix: 42% of real claims are multi-hit (32% in the hand set) and the extractor
emits 1.6× more claims than were labeled. Of 143 single-hit raw claims with a
gold counterpart, 128 hit the gold; the 15 others are record-order mismatches
or the extractor reading a different value, which the tier links faithfully.

Caveat: the shared Ollama server granted 16k–45k tokens of context, so three
large documents were windowed and two extractions were truncated.

## 2. Single-hit traps

40 traps across 16 documents, each a value with exactly one lexical hit that is
wrong for its field (a colleague claimed as author, a 2014 count claimed for
2024, another row's cell). Merged with the original claims and run at the
frozen thresholds:

| policy | wrong | review | abstain | cost on the 382 real claims |
|---|---:|---:|---:|---|
| E, Nemotron 1B | 34/40 | 4 | 2 | 6 correct links pushed to review by the collision cap |
| H (rerank single hits) | 14/40 | 17 | 9 | supported 275 → 210, review 6 → 61 |
| LLM baseline, bare values | 40/40 | – | 0 | – |

Six traps survived under E only because the same string was claimed under two
fields, which triggers the collision cap. The LLM baseline is worse because it
sees no field name at all, which is the production contract.

## 3. Rendering fix and the LLM as E's scorer

`tableCellContexts` gave header-role cells a context containing the whole row.
The LLM was asked for "the passage that states the value", found the value
inside the row-label passage, and was scored wrong. Fixed in
`scripts/dump-anchors.mts`; 6 100 of 40 066 contexts changed, ids and texts
byte-identical.

| document | LLM wrong links before | after |
|---|---:|---:|
| fed-monetary-policy | 4 | 1 |
| polska-w-liczbach | 14 | 0 |
| nederland, suomi | 0 | 0 |

The same rerun on the DGX Spark with the original `qwen3.8:27b` over all five
`final_dataset_2` documents, España included
([`SPARK_LLM_BASELINE_final2.md`](SPARK_LLM_BASELINE_final2.md)): 73/75 links,
24/25 abstains, 3 wrong, against 48/75 and 28 wrong in
[`LLM_BASELINE.md`](LLM_BASELINE.md). The three survivors are the fed
`2.4 percent` trap and two España values (`83,77 años`, `128 litros`). The
other Spark reruns (`dataset`, `final_dataset`, the blind set, LLM as scorer)
were stopped before completing and are not reported.

Replacing E's cross-encoder with the same LLM, on the same inputs (rich claim,
hit-set candidates only), gives 372/382 correct, identical to E-Nemotron, at
349 ms per claim; 4 wrong instead of 0 because a link/NONE protocol has no
review bucket. The reranker is not what makes E work; the lexical routing is,
and section 2 shows what that routing cannot see.

## 4. Blind set

Six German and English grave catalogues from the user's collection, parsed
through the Parsing Service, labeled by a subagent that was barred from reading
any grounding code or report. Schemas are realistic (records of graves, typed
measurements in cm, ISO dates); 164 claims, 116 supported, 48 unsupported in
three kinds (never stated, present under another meaning, computed). Frozen
thresholds from the 5-fold run.

| policy | correct decisions | supported links | correct abstains | review | wrong | auto precision |
|---|---:|---:|---:|---:|---:|---:|
| E, Nemotron 1B | 91/164 | 72/116 | 19/48 | 13 | 37 | 72/109 |
| H, Nemotron 1B | 85/164 | 65/116 | 20/48 | 27 | 28 | 65/93 |
| E with the LLM as scorer (qwen3.8 27B, local) | 114/164 | 86/116 | 28/48 | – | 25 | – |

The LLM scorer beats Nemotron here only because it may answer NONE inside a
hit set, which catches 9 more unsupported values; it still auto-links the same
single hits. Detail in [`BLIND_LLM_HITSET.md`](BLIND_LLM_HITSET.md).

Outcomes that no reranker could change: 9 unsupported values had one hit and
were auto-linked; 20 unsupported values had several hits, so every pick is
wrong; 7 supported values had gold outside the hit set; 7 supported values had
no hit. Bare numbers (ages, depths, counts, years) occur dozens of times in a
catalogue, and 61 of the first 100 claims were multi-hit against 24% in the
hand set.

Labeler doubts are listed in `LABELS.md`; the largest is that OCR table cells
carry no header, so several supported cells are only identifiable through the
claim's sibling context.

## What would change the verdict

1. A grounding tier that verifies the field, not only the value, before any
   auto-accept. Policy H shows the current reranker cannot do that without
   sending a third of correct links to review.
2. Evaluation only on typed extractor output and blind labels. The three
   original sets should be retired from headline numbers.
3. The LLM comparison rerun with the fixed anchors and, for a fair contract
   comparison, with field names in the request.

## Reproduction

```bash
cd prototypes/grounding_lab
pnpm --filter grounding-lab extract-real -- dataset final_dataset final_dataset_2
.venv/Scripts/python.exe -X utf8 -m grounding_lab.raw_claims dataset final_dataset final_dataset_2
.venv/Scripts/python.exe -X utf8 -m grounding_lab.model_benchmark dataset final_dataset final_dataset_2 --stage rerank --retriever mini --reranker nemotron-1b --split all --abstain-threshold -9.375 --accept-threshold 0.5625 --claims claims.json,traps.json
.venv/Scripts/python.exe -X utf8 -m grounding_lab.model_benchmark final_dataset_3 --stage rerank --retriever mini --reranker nemotron-1b --split all --abstain-threshold -9.375 --accept-threshold 0.5625
.venv/Scripts/python.exe -X utf8 -m grounding_lab.llm_hitset final_dataset_3 qwen3.8:latest --think
```

`final_sources_3/` holds the blind-set PDFs; they are copyrighted scans and are
git-ignored. `final_dataset_3/<doc>/` carries the parsed document, anchors,
schema and labels.

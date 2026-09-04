# Grounding lab: results and next steps (2026-09-04)

One question: can a tiered non-LLM grounder (normalized lexical containment,
then a small cross-encoder inside the lexical hit set) replace LLM evidence
linking, given that the product's aim is to catch extractor errors and put
them in front of a reviewer? Code in `grounding_lab/`, the blind sets in
`final_dataset_3/`, session state in [`HANDOFF.md`](HANDOFF.md).

## Verdict

- The earlier 372/382 for policy E was a property of the labels, not the
  pipeline: every claim was a string copied verbatim out of an anchor, 187 of
  283 linkable claims were single lexical hits linked unverified, only 35
  could be scored wrong at all, and 98 of the 99 must-abstain values were
  simply absent from the text. Those three sets (`dataset`, `final_dataset`,
  `final_dataset_2`) are regression fixtures now and produce no headline
  number.
- On real extractor output labeled blind (360 claims, six scanned grave
  catalogues), the best non-LLM configuration catches 84% of extractor errors
  and passes 57% of correct values without reviewer attention, at 16 ms median
  per claim. A 27B LLM under the same contract catches 80% at 5.2 s. The
  scorer is not the bottleneck; routing, extractor quality and the anchor
  contract are.
- Nothing here auto-accepts safely: the best auto precision is 79%. Links are
  reviewer suggestions; their absence or doubt is the error flag.

## Headline set: extractor output, blind labels

`final_dataset_3/<doc>/claims_extracted.json`. The real extractor
(`qwen3.8:latest`, local Ollama, every prompt cut to 16k tokens by the
server, [`RAW_EXTRACTION_BLIND.md`](RAW_EXTRACTION_BLIND.md)) was run with
each document's `schema.json`; 60 emitted leaves per document were sampled
(seeded) and labeled by six labelers who saw only their document directory
([`final_dataset_3/LABELS.md`](final_dataset_3/LABELS.md), last section).
256 supported, 104 unsupported; the unsupported values are what the extractor
really produces: a runaway enumeration of type codes, place names harvested
from the bibliography, composed labels.

Policy E: one strict hit links at confidence 1.0, zero hits abstain, several
hits go to the reranker (Nemotron 1B) with field name and sibling values.
`--sibling-gate`: a single hit whose page neighbourhood (3 anchors either
side) and table row hold none of the claim's sibling values goes to review; a
bare number (4 characters or fewer, no unit) links only through a
sibling-supported hit, and its hit set is narrowed to those. Frozen thresholds
are the fixture-tuned `-9.375 / 0.5625`; "blind-tuned" is leave-one-document-out
on this set (the abstain threshold lands at about 0.52, so the scorer can say
"none" inside a hit set). Latency is the whole per-claim path after a one-off
anchor normalization per document.

| policy | correct | supported links | correct abstains | review | wrong | auto precision | median ms | p95 ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| E, frozen | 230/360 | 160/256 | 70/104 | 35 | 61 | 160/221 | 28 | 1 053 |
| E + sibling gate, frozen | 233/360 | 155/256 | 78/104 | 39 | 52 | 155/207 | 15 | 366 |
| E, blind-tuned | 234/360 | 154/256 | 80/104 | 33 | 41 | 154/195 | 27 | 1 116 |
| E + sibling gate, blind-tuned | 224/360 | 145/256 | 79/104 | 41 | 39 | 145/184 | 16 | 381 |
| E with the LLM as scorer, same contract | 251/360 | 168/256 | 83/104 | – | 36 | – | 5 238 | – |

The reviewer's view of the same runs (`outcomes/*.jsonl` from
`model_benchmark --dump`; the two lexical-only rows need no model):

| policy | extractor errors caught | missed (auto-linked) | correct values passed | correct values sent to review or abstained | correct value, wrong anchor |
|---|---:|---:|---:|---:|---:|
| E, frozen | 77/104 (74%) | 27 | 160/256 | 62 | 34 |
| E + sibling gate, frozen | 84/104 (81%) | 20 | 155/256 | 69 | 32 |
| E, blind-tuned | 86/104 (83%) | 18 | 154/256 | 79 | 23 |
| E + sibling gate, blind-tuned | 87/104 (84%) | 17 | 145/256 | 89 | 22 |
| single hits pass, every hit set to review | 94/104 (90%) | 10 | 79/256 | 177 | 0 |
| gated single hits pass, hit sets to review | 93/104 (89%) | 11 | 84/256 | 170 | 2 |
| LLM as scorer, same contract | 83/104 (80%) | 21 | 168/256 | 73 | 15 |

What is left, and why no scorer fixes it:

- **27 supported values have no lexical hit** (soft hyphens in the OCR,
  strings the extractor composed from two cells, legend abbreviations it
  expanded to the typed form, a year inside a date). Missed by construction.
- **12 of the 17 errors the gated variant still links are citation place
  names**: the only occurrence is a bibliography entry that also holds the
  sibling district, so the gate confirms the wrong passage.
- **2 are grave numbers that lost their letter** (1117 for 1117A while a grave
  1117 exists).
- Bare numbers produce hit sets up to 174 anchors; the gate's narrowing is
  what halves the p95.

Reports: [`EXTRACTED_E_NEMOTRON.md`](EXTRACTED_E_NEMOTRON.md),
[`EXTRACTED_GATED_NEMOTRON.md`](EXTRACTED_GATED_NEMOTRON.md),
[`EXTRACTED_CV6_E_NEMOTRON.md`](EXTRACTED_CV6_E_NEMOTRON.md),
[`EXTRACTED_CV6_GATED_NEMOTRON.md`](EXTRACTED_CV6_GATED_NEMOTRON.md),
[`EXTRACTED_LLM_HITSET.md`](EXTRACTED_LLM_HITSET.md).

## Secondary set: hand-labeled blind claims

The same six documents, 164 typed claims (116 supported) written by a labeler
who never saw the pipeline (`claims.json`, [`LABELS.md`](final_dataset_3/LABELS.md)).

| policy | correct | supported links | correct abstains | review | wrong | auto precision |
|---|---:|---:|---:|---:|---:|---:|
| E, frozen | 91/164 | 72/116 | 19/48 | 13 | 37 | 72/109 |
| E + sibling gate, frozen | 92/164 | 70/116 | 22/48 | 17 | 30 | 70/100 |
| E, blind-tuned | 99/164 | 65/116 | 34/48 | 4 | 19 | 65/84 |
| E + sibling gate, blind-tuned | 99/164 | 66/116 | 33/48 | 12 | 15 | 66/81 |
| E with the LLM as scorer | 114/164 | 86/116 | 28/48 | – | 25 | – |

Two diagnostics on the fixtures, kept as `<doc>/traps.json`: 40 single-hit
traps (a value present exactly once, under the wrong field) are linked wrong
34 times by E at confidence 1.0; the gate removes 4, because 32 traps are
top-level fields with no sibling to check. Reranking every single hit (policy
H) caught 20 more traps but sent 65 correct links to review, so it was
dropped. Also fixed on the way: `dump-anchors` gave header cells the whole row
as context, which caused 28 of the LLM baseline's 33 wrong links on the
fixtures; production `anchorText()` in
`packages/extraction/src/grounding.ts` has no such leak, but it hands the
scorer bare cell text (no row, no header), less than the lab does, and cuts a
cell containing ` | `.

## Next steps toward production

In order; each is independent of the models.

1. **Contract: a link the reviewer can doubt.** `ground()` returns
   `evidence` and `ungroundedPaths`; add a review state (a confidence or a
   `reviewPaths` list) so a gated or sub-threshold candidate reaches the
   reviewer as "check this passage" rather than as a verified link or as
   nothing. `EvidenceTab` renders it; nothing else changes.
2. **Port the lexical tier and the gate to `packages/extraction`.**
   `normalize`, `bounded_contains`, `lexical_tier`, `sibling_support` are
   pure functions; the sibling values are already in the result
   (`populatedContentPaths` siblings). Route: one verified hit links, zero
   hits go to `ungroundedPaths`, hit sets go to the model with the field name,
   siblings and only the hit set, and `NONE` allowed. That is the LLM row
   above (80% of errors caught) using the existing `GroundingModel`, and it
   cuts the model's input from every anchor to the hit set. Index the
   normalized anchors once at parse time.
3. **Two rules for the classes the gate misses.** Anchors after the last
   bibliography heading are not evidence for site and place fields; a number
   that also occurs with a letter suffix goes to review.
4. **Extractor: emit the verbatim span with each typed value** (the schema
   already has `verbatim-string`). This removes the 27 zero-hit supported
   values and turns most hit-set scoring into exact matching. Also raise the
   Ollama context grant: every extraction here was cut at 16k tokens, and the
   invented records that dominate the unsupported set come from that.
5. **Replace the LLM scorer with Nemotron 1B only after 1 to 4 are in**, with
   the abstain threshold tuned on a blind set from a different document family
   than the six catalogues, then frozen. Acceptance test: the reviewer's-view
   table above, on a set built by the README protocol, run once from
   committed code.
6. **Do not** auto-accept links, compare more rerankers, or tune on the
   fixtures.

## Reproduction

```bash
cd prototypes/grounding_lab
pnpm --filter grounding-lab test
pnpm --filter grounding-lab extract-real -- final_dataset_3
.venv/Scripts/python.exe -X utf8 -m grounding_lab.raw_claims final_dataset_3
.venv/Scripts/python.exe -X utf8 -m grounding_lab.raw_claims final_dataset_3 --sheet --sample 60
.venv/Scripts/python.exe -X utf8 -m grounding_lab.label_review final_dataset_3 --claims claims_extracted.json
.venv/Scripts/python.exe -X utf8 -m grounding_lab.model_benchmark final_dataset_3 --stage rerank --retriever mini --reranker nemotron-1b --split all --abstain-threshold -9.375 --accept-threshold 0.5625 --sibling-gate --claims claims_extracted.json --dump outcomes/extracted_gated.jsonl
.venv/Scripts/python.exe -X utf8 -m grounding_lab.model_benchmark final_dataset_3 --stage rerank --retriever mini --reranker nemotron-1b --cv 6 --sibling-gate --claims claims_extracted.json
.venv/Scripts/python.exe -X utf8 -m grounding_lab.llm_hitset final_dataset_3 qwen3.8:latest --think --claims claims_extracted.json
```

`final_sources_3/` holds the six PDFs; they are copyrighted scans and
git-ignored. `document.md`, `parsed_document.json` and `anchors.json` under
`final_dataset_3/` are full-text derivatives of them and are committed; drop
them if that is too much, the labels and schemas stand alone.

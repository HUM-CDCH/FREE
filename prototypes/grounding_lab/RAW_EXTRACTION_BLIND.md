# The real extractor on the blind set

> **Diagnostic.** Lexical tier only, over what `extractWithModel` (qwen3.8:latest,
> 27B Q4, local Ollama, temperature 0) emitted for the six `final_dataset_3`
> documents with their hand-written `schema.json` as the template. Produced on
> 2026-09-04 by `pnpm --filter grounding-lab extract-real -- final_dataset_3`
> and `grounding_lab.raw_claims final_dataset_3`.

The server granted 32k context but every prompt was counted at 16 386 input
tokens, so all six prompts were cut (see `extracted_meta.json`); the two
scans over 300k characters were windowed to the pages around the hand
labels' gold anchors first. `buchvaldek-koutecky-1972` also hit the output
limit (16 382 tokens) and its 1 362 leaves are mostly repeated or invented
records, which is why 662 of them hit nothing. This is the distribution
production grounds under the same server: 31% of emitted leaves are in no
anchor, 14% in exactly one, 55% in several, against 3% / 54% / 42% on the
fixture documents (earlier run on the twenty fixtures, 597 leaves).

The 60-claim labeling sheets (`claims_extracted.json`, seeded sample per
document) come from these runs; their labels and results are in
[`AUDIT.md`](AUDIT.md).

## Per document

| document | raw claims | abstain (0 hits) | review (loose only) | single hit | 2+ hits | model s | note |
|---|---:|---:|---:|---:|---:|---:|---|
| final_dataset_3/buchvaldek-1970-vikletice-tables-de | 335 | 44 | 1 | 64 | 226 | 109 | windowed, prompt truncated |
| final_dataset_3/buchvaldek-koutecky-1972-vikletice-de | 1362 | 662 | 0 | 2 | 698 | 184 | prompt truncated, answer cut |
| final_dataset_3/conrad-2011-bbc-graves-de | 78 | 15 | 0 | 36 | 27 | 27 |  |
| final_dataset_3/dobes-1998-kugelamphoren-de | 105 | 19 | 1 | 44 | 41 | 51 | prompt truncated |
| final_dataset_3/durankulak-catalogue-de | 788 | 192 | 0 | 150 | 446 | 133 | windowed, prompt truncated |
| final_dataset_3/shbat-2009-skeletal-health-en | 413 | 20 | 1 | 130 | 262 | 58 |  |
| **pooled** | **3081** | **952** | **3** | **426** | **1700** | |

## Pooled

- raw claims: 3081
- zero strict hits: 955 (31%) — of these 952 abstain outright and 3 reach the review bucket through the whitespace-tolerant fallback
- exactly one strict hit (E links at confidence 1.0, no verification): 426 (14%)
- two or more strict hits (E reranks inside the hit set): 1700 (55%)

## Against the hand-authored claims

- raw fields with a hand-authored counterpart at the same result path: 52/3081
- raw value string identical to the hand-authored value: 3 (6%)
- single-hit raw claims whose counterpart has a gold anchor: 7
  - hit is in the gold set (correct auto-link): 5
  - hit is outside the gold set (confidently wrong link at 1.0): 2
  - of those, on a non-indexed (scalar) result path: 2 — an array index in the raw result need not describe the same entity the hand-authored claim indexed, so indexed rows are agreement, not error

| document | path | raw value | hand-authored | linked anchor |
|---|---|---|---|---|
| final_dataset_3/buchvaldek-koutecky-1972-vikletice-de | title | `Vikletice, ein schnurkeramisches Gräberfeld` | `Interpretation des schnurkeramischen Gräberfeldes von Vikletice` | `anchor_0a759436b1ef0…` |
| final_dataset_3/conrad-2011-bbc-graves-de | feature_measurement_unit | `cm` | `m` | `anchor_0aad93310a0d2…` |


The per-leaf zero-hit table (955 rows) is omitted; regenerate it with the command above.

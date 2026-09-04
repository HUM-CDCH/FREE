# Grounding the real extractor's output

> **Diagnostic.** This measures the lexical tier only — the first tier of
> policy E — over output the real extractor produced today on one local
> Ollama server. It is not a rerun of the benchmark in
> [`MODEL_REPORT.md`](MODEL_REPORT.md) and does not restate its accuracy.

## Why

Every value in `claims.json` across the three datasets was hand-authored by
copying a verbatim string out of `anchors.json`. All 382 are `str`, and all
are literally present in the document ("4,4 maaltijden met vlees", "£9.4bn",
"449,3 Millionen"). Policy E's first tier is normalized containment, so the
hand-authored corpus guarantees the tier's own precondition: the value is in
the text. The real FREE extractor answers a typed schema and emits typed JSON
— `48619695`, `-2.1`, `3200000000` — so how often containment still fires on
real output was unknown. That is the number below.

## How this was produced

`scripts/extract-real.mts` derives an Extraction Schema template per document
from that document's `claims.json` result paths (`["records", 0,
"free_port_year"]` -> `records: [{ free_port_year: 'integer' }]`), typing a
field `number` when the hand-authored value is a single number once thousands
separators, spaces, `%`, currency symbols and trailing unit words are removed,
`integer` for a bare year, `string` otherwise. Fields whose name starts with
`adversarial` are excluded. It then calls the production entry point,
`extractWithModel` from `prototypes/studio/api/_model.ts`, through a real
`GeneralExecutionTarget` built from `providerTable.ollama` — the same path the
Studio uses.

```
cd prototypes/grounding_lab
pnpm --filter grounding-lab extract-real -- dataset final_dataset final_dataset_2
.venv/Scripts/python.exe -X utf8 -m grounding_lab.raw_claims dataset final_dataset final_dataset_2
```

- **Model:** `qwen3.8:latest` (Qwen3.5 family, 27.3B, Q4_K_M) on a local
  Ollama at `http://127.0.0.1:11434`, temperature 0, no extra instruction.
- **Document text:** the ten `final_dataset*` documents were given the
  `document.md` the Parsing Service wrote. The ten `dataset/` documents have
  no saved markdown, so their text is `canonicalSource(parsedDocument)` from
  `packages/extraction/src/source-context.ts` — FREE's own projection of the
  parsed document, page headings plus `cell | cell` table rows.
- **Windowed documents:** `desnz-annual-report-2024-25-en`,
  `us-census-income-2024-en` and `espana-en-cifras-2025-es` were extracted
  from a page window — the pages holding a gold anchor of `claims.json` plus
  one page either side — not the whole document. They are labelled in the
  table below and in each `extracted_meta.json`.
- **Context caveat:** the model advertises a 262 144-token context, but this
  shared server granted between 16k and 45k depending on concurrent load.
  `us-census-income-2024-en` was prompt-truncated even windowed (16 386 input
  tokens for a 376 601-character window) and yielded only three fields;
  `age-related-disease` filled its context and its answer stopped early after
  `affiliations`. Both are flagged. The other eighteen documents finished
  with `finishReason: "stop"` on an untruncated prompt.

Per document, `<doc>/template.json` holds the schema sent, `extracted_raw.json`
the model's parsed result, `extracted_meta.json` the attribution, token counts
and elapsed seconds. `grounding_lab/raw_claims.py` flattens each raw result the
way `populatedContentPaths` in `packages/extraction/src/grounding.ts` does —
every non-empty string/number/boolean leaf — and runs the frozen `lexical_tier`
from `grounding_lab/pipeline.py` over each leaf against that document's
`anchors.json`.

## Per document

| document | raw claims | abstain (0 hits) | review (loose only) | single hit | 2+ hits | model s | note |
|---|---:|---:|---:|---:|---:|---:|---|
| dataset/1790-06-17-1 | 36 | 0 | 0 | 32 | 4 | 147 |  |
| dataset/age-related-disease | 23 | 1 | 0 | 14 | 8 | 296 | answer cut |
| dataset/brondbylund | 14 | 0 | 0 | 10 | 4 | 44 |  |
| dataset/catfish-collagen | 37 | 1 | 3 | 29 | 4 | 129 |  |
| dataset/ellekilde | 129 | 0 | 0 | 73 | 56 | 57 |  |
| dataset/free-ports-hamburg | 105 | 0 | 0 | 49 | 56 | 149 |  |
| dataset/herredsvejen | 24 | 0 | 0 | 12 | 12 | 302 |  |
| dataset/hojbakkegaard | 22 | 4 | 0 | 13 | 5 | 61 |  |
| dataset/hvissinge | 28 | 1 | 0 | 14 | 13 | 65 |  |
| dataset/katrinesminde | 41 | 0 | 0 | 14 | 27 | 43 |  |
| final_dataset/desnz-annual-report-2024-25-en | 15 | 0 | 0 | 2 | 13 | 38 | windowed |
| final_dataset/eurostat-key-figures-2025-de | 15 | 0 | 0 | 7 | 8 | 39 |  |
| final_dataset/insee-bilan-demographique-2025-fr | 15 | 4 | 0 | 2 | 9 | 20 |  |
| final_dataset/istat-ambiente-2025-it | 15 | 0 | 0 | 15 | 0 | 380 |  |
| final_dataset/us-census-income-2024-en | 3 | 0 | 0 | 0 | 3 | 636 | windowed, prompt truncated |
| final_dataset_2/espana-en-cifras-2025-es | 15 | 0 | 0 | 6 | 9 | 20 | windowed |
| final_dataset_2/fed-monetary-policy-report-2025-06-en | 15 | 0 | 0 | 5 | 10 | 31 |  |
| final_dataset_2/nederland-in-cijfers-2024-nl | 15 | 3 | 0 | 8 | 4 | 20 |  |
| final_dataset_2/polska-w-liczbach-2025-pl | 15 | 2 | 0 | 9 | 4 | 26 |  |
| final_dataset_2/suomi-lukuina-2025-fi | 15 | 0 | 0 | 11 | 4 | 31 |  |
| **pooled** | **597** | **16** | **3** | **325** | **253** | |

## Pooled

- raw claims: 597
- zero strict hits: 19 (3%) — of these 16 abstain outright and 3 reach the review bucket through the whitespace-tolerant fallback
- exactly one strict hit (E links at confidence 1.0, no verification): 325 (54%)
- two or more strict hits (E reranks inside the hit set): 253 (42%)

## Against the hand-authored claims

- raw fields with a hand-authored counterpart at the same result path: 271/597
- raw value string identical to the hand-authored value: 99 (37%)
- single-hit raw claims whose counterpart has a gold anchor: 143
  - hit is in the gold set (correct auto-link): 128
  - hit is outside the gold set (confidently wrong link at 1.0): 15
  - of those, on a non-indexed (scalar) result path: 5 — an array index in the raw result need not describe the same entity the hand-authored claim indexed, so indexed rows are agreement, not error

| document | path | raw value | hand-authored | linked anchor |
|---|---|---|---|---|
| dataset/1790-06-17-1 | records.2.owner_name | `Emelot` | `Lallemand` | `anchor_ebb61fca35b5e…` |
| dataset/age-related-disease | affiliations.0 | `Institute of Prehistoric and Protohistoric Archaeology, Kiel University, Johanna-Mestorf-Str. 2 -6, Kiel 24118, Germany` | `University of Leicester` | `anchor_1eeb7fa3207c5…` |
| dataset/age-related-disease | affiliations.1 | `School of Archaeology and Ancient History, University of Leicester, University Road, Leicester LE1 7RH, United Kingdom` | `Kiel University` | `anchor_028b35c685595…` |
| dataset/age-related-disease | affiliations.2 | `Laboratory of Biological Anthropology, Globe Institute, University of Copenhagen, Ø ster Voldgade 5 -7, K ø benhavn K 1350, Denmark` | `Vanderbilt University Medical Center` | `anchor_c900f0797a430…` |
| dataset/age-related-disease | affiliations.3 | `Department of Anthropology (Emeritus), The Pennsylvania State University, 245 Susan Welch Building, University Park, PA 16802, United States` | `Mississippi State University` | `anchor_a85e4ea17007b…` |
| dataset/catfish-collagen | primers.0.sequence | `GATCCGGTATGTGCAAGGCT` | `GACGCTGTATGTGAAACGGC` | `anchor_e4786b81b3af0…` |
| dataset/catfish-collagen | centrifuge_speed | `8000 × g` | `12,000 × g` | `anchor_d570a1853ab0f…` |
| dataset/free-ports-hamburg | records.24.free_port_year | `1765` | `1766` | `anchor_1589a3021fcb0…` |
| dataset/hojbakkegaard | budget_approval_date | `2005-03-07` | `2004-08-13` | `anchor_d0c2e59408cbf…` |
| dataset/hvissinge | journal_number | `16/02957` | `TAK 1728` | `anchor_b658d978bc50d…` |
| dataset/hvissinge | records.0.body_height | `mindst 130 cm` | `cirka 173 cm` | `anchor_db31af5e82beb…` |
| dataset/hvissinge | records.1.measured_height | `173` | `135 cm` | `anchor_cc1c4dac3dd4b…` |
| dataset/hvissinge | records.2.body_height | `135 cm` | `172 cm` | `anchor_0a1cae114cef8…` |
| dataset/hvissinge | excavation_participant | `Kenneth Paulmann` | `Morten Knudsen` | `anchor_f85cd6fec331a…` |
| final_dataset_2/nederland-in-cijfers-2024-nl | fastFoodRestaurants2024 | `12560` | `19 040` | `anchor_7fcf83fcbc711…` |

## Zero-hit raw values

| document | path | raw value | hand-authored value | fallback |
|---|---|---|---|---|
| dataset/age-related-disease | authors.2 | `Marie Louise Schjellerup Jørvik` | — | none |
| dataset/catfish-collagen | academic_editor | `Carlos José Dias Pereira` | `Carlos José Dias Pereira` | loose 1 |
| dataset/catfish-collagen | primers.0.name | `β-actin-F` | — | loose 1 |
| dataset/catfish-collagen | primers.1.sequence | `TGC CAGATCTTCTCCATATCA` | `TATCTCCCCTTGGTCCCGAT` | loose 1 |
| dataset/catfish-collagen | primers.1.name | `β-actin-R` | — | none |
| dataset/hojbakkegaard | records.2.grave_length | `220` | — | none |
| dataset/hojbakkegaard | records.3.grave_length | `260` | `2.20 meter` | none |
| dataset/hojbakkegaard | records.4.grave_length | `270` | — | none |
| dataset/hojbakkegaard | records.5.dating | `udateret` | — | none |
| dataset/hvissinge | media_coverage | `lokalavisen og TV Lorry` | `TV Lorry` | none |
| final_dataset/insee-bilan-demographique-2025-fr | populationMetropolitanFrance | `66800000` | `66,8 millions` | none |
| final_dataset/insee-bilan-demographique-2025-fr | populationOverseasDepartments | `2300000` | `2,3 millions` | none |
| final_dataset/insee-bilan-demographique-2025-fr | birthsAnnualChange | `-2.1` | `2,1 % de moins` | none |
| final_dataset/insee-bilan-demographique-2025-fr | birthsChangeSince2010 | `-24` | `24 % de moins` | none |
| final_dataset_2/nederland-in-cijfers-2024-nl | syntheticDrugsRevenue | `3200000000` | `€ 3,2 miljard` | none |
| final_dataset_2/nederland-in-cijfers-2024-nl | cocaineRevenue | `10700000000` | `€ 10,7 miljard` | none |
| final_dataset_2/nederland-in-cijfers-2024-nl | illegalTobaccoRevenue | `100000000` | `€ 0,1 miljard` | none |
| final_dataset_2/polska-w-liczbach-2025-pl | gminyCount2024 | `2477` | `2 477` | none |
| final_dataset_2/polska-w-liczbach-2025-pl | highestPointMetres | `2499` | `2 499` | none |

## Why containment failed

Nineteen of 597 raw claims (3%) produced no strict hit. Grouped by hand:

| reason | n | examples |
|---|---:|---|
| magnitude folded into the number (the document writes the unit, the schema wants a number) | 5 | `66800000` for "66,8 millions"; `3200000000` for "€ 3,2 miljard"; `100000000` for "€ 0,1 miljard" |
| space-grouped four-digit thousands | 2 | `2477` for "2 477"; `2499` for "2 499" — `normalize` joins a space group only at five digits or in an isolated table cell, so "page 5 200" stays two values |
| direction turned into a sign | 2 | `-2.1` for "2,1 % de moins"; `-24` for "24 % de moins" |
| unit converted | 3 | `220`, `260`, `270` for grave lengths the report writes as "2.20 meter" |
| OCR/PDF spacing — no strict hit, whitespace-tolerant fallback hits (E: review) | 3 | `Carlos José Dias Pereira`, `β-actin-F`, a primer sequence broken by a space |
| extractor emitted text the document does not carry verbatim | 4 | `lokalavisen og TV Lorry` (two sources joined), `udateret`, `β-actin-R`, an author name |

The first three groups — nine claims — are normalization, not extraction: the
document states the same fact, in a form the tier's normalizer does not fold
onto the model's typed value. `_GROUPING_SEP`, the currency handling and the
date rewrites in `normalize` already absorb the common cases, which is why the
rate is 3% and not the collapse the typed-output hypothesis predicted.

## What the single-hit links point at

For 143 raw claims that hit exactly one anchor and whose result path also
carries a hand-authored claim with a gold anchor, 128 linked inside the gold
set. The 15 outside it are not 15 wrong links: ten sit on an array-indexed
path where the extractor's record order differs from the hand-authored one
(`affiliations.0` is Kiel in the raw result and Leicester in `claims.json`),
so the two describe different entities. The five on scalar paths are cases
where the extractor read a different value than the human did — `8000 × g`
instead of `12,000 × g`, `16/02957` instead of `TAK 1728` — and the tier then
linked that value to the anchor that actually contains it. The link is
faithful to the value it was given; the disagreement is upstream.

## Reading

The lexical tier's precondition survives typed extractor output far better
than the hand-authored corpus made it possible to check: 97% of real raw
claims still hit at least one anchor, and the shape of the tier's traffic
shifts rather than collapses — 54% single hit (auto-linked at confidence 1.0
with no verification, up from a corpus where multi-hit dominated), 42% into
the reranker. The residual 3% is dominated by two mechanical normalizations
the tier does not yet do (magnitude words, space-grouped four-digit numbers),
not by paraphrase. Two caveats bound this: `us-census-income-2024-en` was
prompt-truncated to three claims and `age-related-disease`'s answer stopped
early, so both under-contribute; and single-hit auto-linking at confidence 1.0
is unverified by construction, which the 15 out-of-gold links make visible even
though most of them are extractor disagreement rather than grounder error.

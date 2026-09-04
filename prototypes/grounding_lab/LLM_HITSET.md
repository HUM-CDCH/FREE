# Anchor rendering fix, and the LLM as policy E's hit-set scorer

Two measurements on the local Ollama box (qwen3.8:latest — 27.3B Q4_K_M, one
RTX 4090 24 GB, 262 144-token context), not the DGX Spark that produced
[`LLM_BASELINE.md`](LLM_BASELINE.md). Diagnostic only: all three datasets have
been reused.

## 1. The rendering fix

`tableCellContexts` in [`scripts/dump-anchors.mts`](scripts/dump-anchors.mts)
gave every cell of a table row a `context` containing the whole row. For a
header-role cell (`column_header`, `row_header`, `row_section`) that meant the
row's data values were inside the label's own passage:

```
anchor_d3f6db988ee  kind table_cell, role row_header
  text     "Número de nacimientos"
  context  "Número de nacimientos | 320.656 | -2,6 — Número de nacimientos"
```

`llm_baseline` renders anchors as `[E1] scoring_text`, and `scoring_text` is
`context` when present. The model was asked for "the passage that states the
value", found `320.656` inside that passage, and answered `E<label>`; the gold
is the sibling data cell, so it scored as a wrong link. Policy E is unaffected
because its lexical tier matches on raw `text`, never on `context`.

Header-role cells now get their own text as their whole scope; data cells keep
the previous behaviour (row headers, column headers above them, then the whole
row). After the fix the same anchor reads
`"Número de nacimientos — Número de nacimientos"`.

```bash
# from D:\progetti\FREE
pnpm --filter grounding-lab dump-anchors ../../prototypes/grounding_lab/<root>/<doc>/parsed_document.json ../../prototypes/grounding_lab/<root>/<doc>/anchors.json
pnpm --filter grounding-lab test
```

Regenerated for all 20 documents (`_smoke` is a fixture, not a document).
`anchorId`, `text`, `page`, `kind`, key set, order and count are byte-identical
to the previous `anchors.json`; only `context` values differ, on header-role
table cells only.

| set | document | anchors | contexts changed |
|---|---|---:|---:|
| `dataset` | 1790-06-17-1 | 2 | 0 |
| `dataset` | age-related-disease | 302 | 0 |
| `dataset` | brondbylund | 62 | 0 |
| `dataset` | catfish-collagen | 252 | 2 |
| `dataset` | ellekilde | 329 | 36 |
| `dataset` | free-ports-hamburg | 404 | 51 |
| `dataset` | herredsvejen | 161 | 0 |
| `dataset` | hojbakkegaard | 147 | 0 |
| `dataset` | hvissinge | 181 | 0 |
| `dataset` | katrinesminde | 152 | 0 |
| `final_dataset` | desnz-annual-report-2024-25-en | 12 285 | 2 441 |
| `final_dataset` | eurostat-key-figures-2025-de | 762 | 0 |
| `final_dataset` | insee-bilan-demographique-2025-fr | 341 | 28 |
| `final_dataset` | istat-ambiente-2025-it | 36 | 0 |
| `final_dataset` | us-census-income-2024-en | 14 609 | 1 463 |
| `final_dataset_2` | espana-en-cifras-2025-es | 4 616 | 1 030 |
| `final_dataset_2` | fed-monetary-policy-report-2025-06-en | 770 | 73 |
| `final_dataset_2` | nederland-in-cijfers-2024-nl | 319 | 0 |
| `final_dataset_2` | polska-w-liczbach-2025-pl | 1 632 | 454 |
| `final_dataset_2` | suomi-lukuina-2025-fi | 2 704 | 522 |
| **total** | **20 documents** | **40 066** | **6 100** |

`label_review` passes on all three roots after the regeneration (26, 28 and 19
pre-existing warnings, no errors):

```bash
.venv/Scripts/python.exe -X utf8 -m grounding_lab.label_review dataset
.venv/Scripts/python.exe -X utf8 -m grounding_lab.label_review final_dataset
.venv/Scripts/python.exe -X utf8 -m grounding_lab.label_review final_dataset_2
```

28 of the 33 wrong links in `LLM_BASELINE.md` are anchors whose `context`
changed here — every one of the 28 the report described as "a table row label
instead of the value cell". The five that do not change are the three
`dataset` name/year misses (`text` anchors), the fed `2.4 percent` trap (a
genuine data cell in the wrong row) and the España `48.619.695` pick, whose
label cell `España` carries no header role from the parser, so it keeps the
row context and remains a hazard.

## 2. Re-measured LLM baseline

`llm_baseline` gained a `--only doc1,doc2` filter; nothing else changed. The
España document (4 616 anchors, ~190k prompt tokens) does not fit the local
4090, so the four remaining `final_dataset_2` documents were rerun:

```bash
.venv/Scripts/python.exe -X utf8 -m grounding_lab.llm_baseline final_dataset_2 qwen3.8:latest --think \
  --only fed-monetary-policy-report-2025-06-en,nederland-in-cijfers-2024-nl,polska-w-liczbach-2025-pl,suomi-lukuina-2025-fi
```

| document | claims | wrong links before (Spark) | wrong links after (4090) |
|---|---:|---:|---:|
| fed-monetary-policy-report-2025-06-en | 20 | 4 | 1 |
| nederland-in-cijfers-2024-nl | 20 | 0 | 0 |
| polska-w-liczbach-2025-pl | 20 | 14 | 0 |
| suomi-lukuina-2025-fi | 20 | 0 | 0 |
| **these four** | **80** | **18** | **1** |
| espana-en-cifras-2025-es | 20 | 10 | not run (context) |

Aggregate over the four documents after the fix: **60/60 correct links, 19/20
correct abstains, 1 wrong link, 0 protocol failures, 21 492 ms per claim**
(before: 43/60 links, 19/20 abstains, 18 wrong). The single remaining wrong
link is the fed `2.4 percent` near-variant trap, which the model links to a
real `2.4` data cell in the PCE-inflation row — not a rendering artifact.
Milliseconds are not comparable to the Spark's 13 669: different hardware, and
the box is shared with other agents.

The 14 polska and 3 of the 4 fed wrong links were entirely an artifact of the
anchor rendering. The report's "33 wrong links" figure therefore describes the
dump script, not the model.

## 3. The LLM as policy E's hit-set scorer

[`grounding_lab/llm_hitset.py`](grounding_lab/llm_hitset.py) is policy E with
one substitution: where E hands a multi-hit lexical set to a cross-encoder, it
hands the same set to the same Ollama model.

- exactly one lexical hit -> direct link, no model call (as E);
- zero strict hits -> abstain, no model call (as E). Whitespace-tolerant
  ("loose") hits also abstain here — E routes those to its scorer with a 0.25
  confidence cap, and a link/NONE protocol has no review bucket to cap into;
- two or more hits -> ONE call whose inputs are exactly E's reranker inputs:
  the rich claim from `render_claim` (field name, value, siblings) and only the
  hit-set anchors, rendered `[E1] scoring_text`, answered as one label or
  `NONE`, JSON, temperature 0.

The request body, prompt and reply validation are `llm_baseline.ground_batch`
and `parse_links` unchanged; the rich claim rides in as the batch's single
claim value. Scoring is identical to `llm_baseline`: correct links, correct
abstains, wrong links, protocol failures, ms per claim, and a per-claim audit.

Two deviations from E as benchmarked, stated: no review bucket (every link is
scored supported or wrong, so E's 8 reviews have no counterpart), and no
field-collision cap — that cap lives in `model_benchmark`, not in
`lexical_tier`, so a single hit here always links.

Routing over the 382 claims: 188 single-hit direct links, 100 zero-hit
abstains, 4 loose-hit abstains, 90 multi-hit model calls.

```bash
.venv/Scripts/python.exe -X utf8 -m grounding_lab.llm_hitset dataset final_dataset final_dataset_2 qwen3.8:latest
.venv/Scripts/python.exe -X utf8 -m grounding_lab.llm_hitset --selfcheck   # routing check, no Ollama
```

Milliseconds are wall clock per claim over all claims, most of which never
call the model, on a box shared with other agents.

| set | claims | correct links | correct abstains | wrong links | protocol failures | model calls | ms/claim |
|---|---:|---:|---:|---:|---:|---:|---:|
| `dataset` (10 docs) | 182 | 124/133 | 48/49 | 4 | 0 | 39 | 514 |
| `final_dataset` (5 docs) | 100 | 75/75 | 25/25 | 0 | 0 | 25 | 237 |
| `final_dataset_2` (5 docs) | 100 | 75/75 | 25/25 | 0 | 0 | 26 | 161 |
| **pooled** | **382** | **274/283** | **98/99** | **4** | **0** | **90** | **349** |

| configuration (382 claims) | correct | links | abstains | review | wrong |
|---|---:|---:|---:|---:|---:|
| E, Nemotron 1B (`MODEL_REPORT.md`) | 372/382 | 274/283 | 98/99 | 8 | 0 |
| E, Qwen3 0.6B | 343/382 | 245/283 | 98/99 | 35 | 1 |
| E, qwen3.8:latest as scorer | 372/382 | 274/283 | 98/99 | n/a | 4 |

Same totals as E-Nemotron, different composition. All ten misses:

| doc | claim | hits | tier | outcome |
|---|---|---:|---|---|
| age-related-disease | Kathryn E. Marklein | 2 | llm | wrong link |
| free-ports-hamburg | Livorno | 11 | llm | wrong link |
| hojbakkegaard | ca. 400 e.Kr. | 2 | llm | wrong link |
| herredsvejen | Poul Kragh | 1 | lexical | wrong link (field collision, uncapped here) |
| age-related-disease | Im Dol 2-6 | 1 | loose | abstained |
| age-related-disease | Øster Voldgade 5-7 | 1 | loose | abstained |
| catfish-collagen | Carlos José Dias Pereira | 1 | loose | abstained |
| herredsvejen | AAR33284 | 1 | loose | abstained |
| brondbylund | cirka 1100-900 f.Kr. | 0 | lexical | abstained |
| hvissinge | at least two individuals | 0 | lexical | abstained |

Six of the ten are the shape of the ablation rather than the model: the four
whitespace-tolerant claims and the Poul Kragh collision are E's review bucket,
which a link/NONE protocol cannot express, and the last two paraphrases are
E-Nemotron's two misses as well. The three genuine scorer errors are all
multi-hit sets a 1B cross-encoder resolves and the 27B model does not; the
protocol held on every one of the 90 calls.

The three roots were run as three commands rather than one because the shared
box timed out a call mid-run; `llm_hitset` retries a timed-out call twice
before raising. Aggregates above are the sum of the three per-root tables.

## Reading

The 33 wrong links attributed to the LLM baseline were mostly a defect in the
evidence the harness handed it: with header cells no longer carrying their
row's values, the incumbent-shaped prompt makes 1 wrong link instead of 18 on
the four documents that fit locally, and the qualitative gap in
`MODEL_REPORT.md` between "LLM: 33 wrong" and "E: 0 wrong" does not survive the
fix. What separates the two is the input shape more than the model: the
baseline scans thousands of anchors for a bare value at ~21 s per claim, while
the same model inside E's hit set answers from 2-12 anchors with the field
name and siblings attached, reaches E-Nemotron's exact totals (372/382,
274/283 links, 98/99 abstains) and holds the protocol on all 90 calls — at 349
ms per claim against 62, and with 4 wrong links where E-Nemotron routes the
same claims to review and makes 0. On this evidence the hit set, not the
scorer's size, is what the accuracy comes from; the residual argument for the
1B cross-encoder is the calibrated score that fills the review bucket, which
a link/NONE protocol has no way to produce. None of this is adoption evidence:
the datasets are burned and the España document was never rerun.

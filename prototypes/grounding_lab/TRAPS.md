# Field-collision traps: what a unique lexical hit does not prove

> **Diagnostic only**, like the rest of this lab. The traps are hand-authored
> adversarial claims added on top of the reused datasets; they are not a frozen
> evaluation set.

Policy E links any claim whose value has exactly **one** `bounded_contains`
hit directly, at confidence 1.0, auto-accepted, never scored
(`lexical_tier` in `grounding_lab/pipeline.py`). The three datasets never
punish that: of 99 must-abstain claims, 98 are values that are simply absent
from the document (off-by-one numbers, misspelled names), and only one
(`Poul Kragh`) is a value that *is* present once but under the wrong meaning.

This report adds 40 claims of exactly that dangerous kind and measures the
wrong-link rate.

## The trap set

`<doc>/traps.json` — same schema as `claims.json`, never merged into it. Load
it with the new `--claims` flag:

```bash
uv run --no-sync python -X utf8 -m grounding_lab.model_benchmark \
  dataset final_dataset final_dataset_2 --stage rerank --retriever mini \
  --reranker nemotron-1b --split all --abstain-threshold -9.375 \
  --accept-threshold 0.5625 --claims claims.json,traps.json
```

`--claims` is a comma-separated list of claim files merged per document
(`load_dataset(root, claims_files)` in `harness.py`, wired into
`model_benchmark`, `llm_baseline` and `label_review`). The default is
`claims.json`, so every existing invocation is unchanged.

40 traps over 16 documents. Every trap satisfies, verified programmatically by
`label_review --claims traps.json`:

- the value appears in **exactly one** anchor's `text` under `bounded_contains`
  (`expectedLexicalHitIds` holds that one anchor id);
- the value is **wrong for the field it is claimed under** — the document
  states a different value for that field, so `goldAnchorId` is `null` and the
  only correct behaviour is to abstain or to route to review.

Two flavours, roughly half each:

- **wrong-field / wrong-quantity** (23): a real, single-occurrence value
attached to a field
  whose true value is different — a colleague from the staff list claimed as
  `report_author`, the hundred (`Smørum herred`) claimed as `parish`, a cited
  reference's DOI claimed as the article's `doi`, the site/locality number
  claimed as `journal_number`, the revision date claimed as `received_date`.
- **wrong-record / wrong-row / wrong-column / wrong-year** (17): a value from
another table
  row, another column, another year or another entity — the Marseilles year
  cell claimed for Altona, the CF group's body weight claimed for the RF group,
  the Federal Reserve notes liability claimed as Treasury securities holdings,
  the 2014 fast-food count claimed for 2024, Spain's fertility rate claimed as
  the EU average.

Six traps re-use a value that `claims.json` already claims under a *different*
field, so `_colliding_values` in `model_benchmark.py` fires on them
(`1300 m2`, `Lone Brorson`, `172 cm`, `Peter Jensen`, `380`, `-6,9%`). The
other 34 are values no other claim carries, which is the ordinary case in
production: nothing tells the pipeline the field is wrong.

Documents without traps: `desnz-annual-report-2024-25-en`,
`us-census-income-2024-en`, `espana-en-cifras-2025-es` (the three documents
too large for the LLM baseline), plus the `_smoke` fixture and `1790-06-17-1`.

## 1. Lexical-only analysis (no GPU)

`lexical_tier` returns a **direct link at confidence 1.0** for all 40 traps —
by construction, since each has exactly one strict hit. The only thing that can
stop the link is the field-collision cap:

| lexical outcome | traps | policy E consequence |
|---|---:|---|
| single hit, value not claimed under another field | 34 | auto-accepted at 1.0, **wrong link**, no scorer ever runs |
| single hit, value also claimed under another field (`_colliding_values`) | 6 | reranked field-aware with `verbatim=False`, capped at 0.25 → review or abstain |

So the wrong-link count is predictable without a GPU: **34 of 40 traps are
auto-linked wrong at confidence 1.0**, and the six that survive do so only
because the extraction happened to claim the same string twice — a property of
the extraction, not of the evidence.

The collision cap is not free: it also drags the six *correct* `claims.json`
links that share those values (`zone_permit_area 1300 m2`,
`conservator Lone Brorson`, `body_height 172 cm`,
`threed_visualization_by Peter Jensen`, `renewableGenerationGermany 380`,
`electricityProductionChange -6,9%`) out of auto-accept and into review.

## 2. Policy E with Nemotron 1B at the frozen thresholds

`--abstain-threshold -9.375 --accept-threshold 0.5625`, all 20 documents,
full report in [`TRAPS_E_NEMOTRON.md`](TRAPS_E_NEMOTRON.md).

| claim set | claims | supported | correct abstains | review | wrong |
|---|---:|---:|---:|---:|---:|
| `claims.json` alone (same frozen thresholds) | 382 | 275/283 | 98/99 | 6 | 1 |
| `claims.json` inside the merged run | 382 | 269/283 | 98/99 | 12 | 1 |
| **traps.json** | **40** | n/a (none linkable) | **2/40** | **4** | **34** |
| merged total | 422 | 269/283 | 100/139 | 16 | 35 |

The one wrong link on the `claims.json` side (`Livorno`, a 11-hit multi-hit
claim resolved at confidence 0.861) is present in the baseline run at these
frozen thresholds too; it is not caused by the traps. The `MODEL_REPORT.md`
figure of 0 wrong comes from the 5-fold CV run, whose per-fold thresholds
differ.

**Policy E's wrong-link rate on the traps is 34/40 = 85 %**, every one of them
auto-accepted at confidence 1.0 with no model in the loop. The remaining six
are the collision cases: four go to review (confidence 0.0–0.25) and two score
below the abstain gate and abstain. Zero traps were caught by the scorer,
because the scorer never saw 34 of them.

The cost side: adding the traps moved six correct `claims.json` links from
supported to review, so the merged run supports 269 instead of 275.

## 3. Policy H — rerank every single hit

Same command plus `--rerank-one-hit`, full report in
[`TRAPS_H_NEMOTRON.md`](TRAPS_H_NEMOTRON.md). H disables the collision
heuristic and sends every strict single hit to Nemotron with the rich claim
rendering (field name + sibling context), keeping real containment.

| claim set | claims | supported | correct abstains | review | wrong |
|---|---:|---:|---:|---:|---:|
| `claims.json` inside the merged run | 382 | 210/283 | 98/99 | 61 | 1 |
| **traps.json** | **40** | n/a (none linkable) | **9/40** | **17** | **14** |
| merged total | 422 | 210/283 | 107/139 | 78 | 15 |

H catches 26 of the 40 traps (9 abstained, 17 routed to review) and cuts the
trap wrong-link rate from 85 % to **35 %** (14/40). Thirteen of the 14 it still
gets wrong are scored at confidence 1.0 (the fourteenth at 0.93) — the
reranker is confident about a cell that contains the value, whatever the field
says.

The price is severe: on the real claims, supported links fall from 275 to 210
and review grows from 6 to 61, i.e. **65 correct auto-accepts are converted
into human review to prevent 20 wrong links**, plus 10 more correct links lost
entirely (12 missed vs 2). Per document the damage is uneven —
`istat-ambiente-2025-it` drops to 8/23 correct decisions, `katrinesminde` to
14/26 — because short numeric table cells score badly in isolation.

## 4. LLM baseline on the traps

The incumbent-shaped LLM grounding (`grounding_lab.llm_baseline`,
`qwen3.8:latest` = qwen3.8 27B Q4_K_M, thinking mode, local Ollama on the
shared RTX 4090), run on the traps only:

```bash
uv run --no-sync python -X utf8 -m grounding_lab.llm_baseline \
  <root> qwen3.8:latest --think --claims traps.json
```

The whole document's anchors go into one prompt per record group, so the three
documents whose `anchors.json` exceeds ~3000 anchors are out of scope:
`desnz-annual-report-2024-25-en` (12 285), `us-census-income-2024-en` (14 609)
and `espana-en-cifras-2025-es` (4 616). None of them carries traps, so all 40
traps were evaluated. No run failed and no retry was needed.

| document | anchors | traps | correct abstains | wrong links | protocol failures |
|---|---:|---:|---:|---:|---:|
| age-related-disease | 302 | 2 | 0/2 | 2 | 0 |
| brondbylund | 62 | 5 | 0/5 | 5 | 0 |
| catfish-collagen | 252 | 2 | 0/2 | 2 | 0 |
| ellekilde | 329 | 2 | 0/2 | 2 | 0 |
| eurostat-key-figures-2025-de | 762 | 2 | 0/2 | 2 | 0 |
| fed-monetary-policy-report-2025-06-en | 770 | 1 | 0/1 | 1 | 0 |
| free-ports-hamburg | 404 | 3 | 0/3 | 3 | 0 |
| herredsvejen | 161 | 5 | 0/5 | 5 | 0 |
| hojbakkegaard | 147 | 5 | 0/5 | 5 | 0 |
| hvissinge | 181 | 2 | 0/2 | 2 | 0 |
| insee-bilan-demographique-2025-fr | 341 | 2 | 0/2 | 2 | 0 |
| istat-ambiente-2025-it | 36 | 3 | 0/3 | 3 | 0 |
| katrinesminde | 152 | 3 | 0/3 | 3 | 0 |
| nederland-in-cijfers-2024-nl | 319 | 1 | 0/1 | 1 | 0 |
| polska-w-liczbach-2025-pl | 1632 | 1 | 0/1 | 1 | 0 |
| suomi-lukuina-2025-fi | 2704 | 1 | 0/1 | 1 | 0 |
| **pooled (16 documents)** | | **40** | **0/40** | **40** | **0** |

| root | traps | per-record calls | avg ms per claim |
|---|---:|---:|---:|
| `dataset` | 29 | 15 | 48 633 |
| `final_dataset` | 7 | 3 | 39 197 |
| `final_dataset_2` | 4 | 4 | 147 232 |
| **pooled** | **40** | **22** | **56 842** |

**The LLM links every single one of the 40 traps**: 40/40 wrong, zero
abstentions, zero protocol failures, at ~57 s per claim. On 39 of the 40 it
picks exactly the anchor the lexical tier would have picked — the one anchor
containing the value. The one exception (`614` in `suomi-lukuina-2025-fi`) is
the row-label failure `LLM_BASELINE.md` already documents: it answers with the
`Inarijärvi` label cell instead of the number cell, so it is wrong twice over.

That the LLM sees only bare values under opaque labels — no field names, no
siblings, per the real `GroundingModelRequest` — is exactly the point: a
grounder that is not told which field a value belongs to cannot tell a
wrong-field value from a right one. Policy E's single-hit shortcut has the
same blindness for a different reason (it never asks), and reaches the same
answer 34 times out of 40 at 62 ms instead of 57 s.

## Appendix — per-trap outcomes

`wrong 1.00` means the link was auto-accepted at confidence 1.0. The LLM
column is the qwen3.8 baseline of section 4.

| document | trap value | flavour | policy E | policy H | LLM |
|---|---|---|---|---|---|
| age-related-disease | `10.1016/j.joca.2021.04.020` | wrong-field | wrong 1.00 | wrong 1.00 | wrong |
| age-related-disease | `1211 Medical Center Drive` | wrong-record | wrong 1.00 | wrong 1.00 | wrong |
| brondbylund | `Lotte Reedtz Sparrevohn` | wrong-field | wrong 1.00 | review | wrong |
| brondbylund | `Smørum herred` | wrong-field | wrong 1.00 | wrong 0.93 | wrong |
| brondbylund | `Morten Lustrup` | wrong-field | wrong 1.00 | abstain | wrong |
| brondbylund | `2000` | wrong-quantity | wrong 1.00 | review | wrong |
| brondbylund | `020202 - 29` | wrong-field | wrong 1.00 | wrong 1.00 | wrong |
| catfish-collagen | `30 August 2024` | wrong-field | wrong 1.00 | review | wrong |
| catfish-collagen | `20.74 ± 0.48 g` | wrong-column | wrong 1.00 | wrong 1.00 | wrong |
| ellekilde | `2.5 x 0.7 meter` | wrong-quantity | wrong 1.00 | wrong 1.00 | wrong |
| ellekilde | `25-35 år` | wrong-record | wrong 1.00 | review | wrong |
| free-ports-hamburg | `1669` | wrong-row | wrong 1.00 | abstain | wrong |
| free-ports-hamburg | `1719` | wrong-row | wrong 1.00 | abstain | wrong |
| free-ports-hamburg | `1595` | wrong-row | wrong 1.00 | review | wrong |
| herredsvejen | `89` | wrong-column | wrong 1.00 | review | wrong |
| herredsvejen | `6. november 2019` | wrong-field | wrong 1.00 | review | wrong |
| herredsvejen | `16.02.09` | wrong-field | wrong 1.00 | review | wrong |
| herredsvejen | `8x10mm` | wrong-record | wrong 1.00 | review | wrong |
| herredsvejen | `1300 m2` | wrong-field, collision | review 0.00 | review | wrong |
| hojbakkegaard | `Hans Christensen` | wrong-field | wrong 1.00 | abstain | wrong |
| hojbakkegaard | `Pia Bennike` | wrong-field | wrong 1.00 | abstain | wrong |
| hojbakkegaard | `2004-10-26` | wrong-field | wrong 1.00 | review | wrong |
| hojbakkegaard | `2.70 m` | wrong-record | wrong 1.00 | wrong 1.00 | wrong |
| hojbakkegaard | `Lone Brorson` | wrong-field, collision | abstain | abstain | wrong |
| hvissinge | `147` | wrong-quantity | wrong 1.00 | review | wrong |
| hvissinge | `172 cm` | wrong-record, collision | review 0.25 | wrong 1.00 | wrong |
| katrinesminde | `55 %` | wrong-quantity | wrong 1.00 | review | wrong |
| katrinesminde | `Peter Jensen` | wrong-field, collision | abstain | abstain | wrong |
| katrinesminde | `180` | wrong-quantity | wrong 1.00 | review | wrong |
| eurostat-key-figures-2025-de | `1,12` | wrong-record | wrong 1.00 | wrong 1.00 | wrong |
| eurostat-key-figures-2025-de | `29,0 Millionen` | wrong-quantity | wrong 1.00 | wrong 1.00 | wrong |
| insee-bilan-demographique-2025-fr | `85,8 ans pour les femmes` | wrong-year | wrong 1.00 | wrong 1.00 | wrong |
| insee-bilan-demographique-2025-fr | `2 550` | wrong-quantity | wrong 1.00 | wrong 1.00 | wrong |
| istat-ambiente-2025-it | `51,4` | wrong-quantity | wrong 1.00 | abstain | wrong |
| istat-ambiente-2025-it | `380` | wrong-column, collision | review 0.00 | review | wrong |
| istat-ambiente-2025-it | `-6,9%` | wrong-field, collision | review 0.25 | wrong 1.00 | wrong |
| fed-monetary-policy-report-2025-06-en | `2,339` | wrong-row | wrong 1.00 | wrong 1.00 | wrong |
| nederland-in-cijfers-2024-nl | `12 560` | wrong-year | wrong 1.00 | abstain | wrong |
| polska-w-liczbach-2025-pl | `1 022` | wrong-row | wrong 1.00 | review | wrong |
| suomi-lukuina-2025-fi | `614` | wrong-column | wrong 1.00 | review | wrong |

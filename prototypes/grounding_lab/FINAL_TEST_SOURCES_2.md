# Final test set 2 — completed, used, diagnostic

Selected, downloaded, and checksummed on 2026-09-02 before any claim was
authored or any model was run on them. This set replaces the invalidated
`final_dataset/` (see `FINAL_TEST_SOURCES.md`). It completed the pre-registered
one-shot evaluation below and was later reused for diagnostic cross-validation,
so it is now used/burned. The exact frozen `model_benchmark.py` source was
uncommitted and is no longer recoverable. These measurements are diagnostic
only; a production decision requires a new frozen set evaluated once from
committed code.

Source documents were chosen for language spread and a mix of narrative and
table-heavy material. No document, publisher edition, or language edition
overlaps with `dataset/` or `final_dataset/`. A Bank of England report was
downloaded first and discarded before parsing finished because its terms allow
non-commercial reuse only; the Federal Reserve report replaced it.

| dataset id | language / material | licence | source | pages | SHA-256 |
|---|---|---|---|---:|---|
| `espana-en-cifras-2025-es` | Spanish; narrative, charts, tables | CC BY 4.0 (INE aviso legal) | [España en cifras 2025](https://ine.es/prodyser/espa_cifras/EEC_2025_PUBLICACION_COMPLETA.pdf) | 60 | `5ef7a40059644ceaae9b26033952eb28128d48ada5a2c47114329951f5134f62` |
| `nederland-in-cijfers-2024-nl` | Dutch; short narrative, tables, infographics | CC BY 4.0 (CBS) | [Nederland in cijfers 2024](https://www.cbs.nl/-/media/_pdf/2024/36/nederland-in-cijfers_2024.pdf) | 45 | `b962ae7f3ea1711bc65764b3e272db20f28140e6946593a65da33742661e4d93` |
| `polska-w-liczbach-2025-pl` | Polish; tables and infographics | GUS: free reuse with attribution | [Polska w liczbach 2025](https://stat.gov.pl/files/gfx/portalinformacyjny/pl/defaultaktualnosci/5501/14/18/1/polska_w_liczbach_2025_v2.pdf) | 42 | `bfc5ceafc4ec4d3b5109f918ca3604fc019d4bd88f0e35ac91159f98b34c1d96` |
| `suomi-lukuina-2025-fi` | Finnish; tables with short narrative | CC BY 4.0 (Tilastokeskus, ISBN 978-952-244-733-3) | [Suomi lukuina 2025](https://otos.stat.fi/server/api/core/bitstreams/84f2a2b6-0c82-46e5-b056-dd8512575f5e/content) | 44 | `1ca76832ea19049cef2ecb99b52f26d013a55f4f19950b4bf2077b04b3b53e51` |
| `fed-monetary-policy-report-2025-06-en` | English; narrative, charts, tables | US federal government work (public domain) | [Monetary Policy Report, June 2025](https://www.federalreserve.gov/monetarypolicy/files/20250620_mprfullreport.pdf) | 81 | `6f8538cb4ce2902ac35cc9ec8311feda6c5c94953b76db50de94192741bb07f4` |

Local copies live in `final_sources_2/`. Each is parsed with
`scripts/parse-source.py` under the Parsing Service's own environment (CPU
torch) and anchored with `dump-anchors`, exactly as the previous final set.

## Claim allocation

100 claims, 20 per document: 15 supported and 5 absent/adversarial
(near-variant numbers, names, or units that appear nowhere in the document).
Every claim passed `label_review` before freezing; the hashes are below.

## Pre-registered evaluation

All configurations were frozen from validation runs before any claim on this
set was authored. Each was run exactly once, with `--split final` and every
flag below passed explicitly (the runner's defaults are now E's policy, so
A–D need `--candidates retrieval`/`--claim-mode bare`/`--zero-hit neural` as
listed), so no calibration occurred on this set. The pre-registered numerical
gate required more correct decisions than the incumbent without more wrong
links; it is retained below as historical experiment context only.

Config E's thresholds were re-derived on 2026-09-02, before any inference on
this set, when `rich-hitset` was corrected to field-name-only rendering (no
sibling context) and dev calibration was rerun: `-∞ / 1.0` replaces the
earlier `-0.375 / 0.9375` from the sibling-context run. Pass
`--abstain-threshold=-inf --accept-threshold 1.0`.

| id | retriever | reranker | K | candidates | claim mode | zero-hit | abstain | accept | source of thresholds |
|---|---|---|---:|---|---|---|---:|---:|---|
| A incumbent | mini | bge | 10 | retrieval | bare | neural | 0.5 | 0.5 | production constants |
| B validation winner | mini | qwen-0.6b | 30 | retrieval | bare | neural | 4.25 | 0.625 | `MODEL_REPORT.md` |
| C hit-set bare | mini | qwen-0.6b | 30 | hitset | bare | neural | 4.25 | 1.0 | validation run (`MODEL_REPORT.md` policy screen) |
| D hit-set rich | mini | qwen-0.6b | 30 | hitset | rich-hitset | neural | 4.25 | 0.5 | validation run (`MODEL_REPORT.md` policy screen) |
| E hit-set rich, zero-hit abstain | mini | qwen-0.6b | 30 | hitset | rich-hitset | abstain | -∞ | 1.0 | validation run (`MODEL_REPORT.md` policy screen) |

Model revisions are the ones pinned in `MODEL_REPORT.md`.

## Frozen labels (2026-09-02 10:00, before any inference)

At freeze, `label_review final_dataset_2` validated all 100 claims with no
errors and 15 warnings, each a deliberate multi-hit disambiguation carrying a
review note. Current normalization produces 14 warnings, so regenerating this
diagnostic report is not a reproduction of the frozen run. The claim files are
frozen at these hashes:

| dataset id | claims.json SHA-256 |
|---|---|
| `espana-en-cifras-2025-es` | `5d78a45f09448d9d84f92001b043f1eae4e0d294ba191e4210586eca448ba1f2` |
| `fed-monetary-policy-report-2025-06-en` | `62dee72240e70136cc4c00f0b1a208d342f80773752016d7064ad211ec75631d` |
| `nederland-in-cijfers-2024-nl` | `58f8a6f6404667478bd48f87248d5193b0d74134c86d6f8c43bdbb8225c70d15` |
| `polska-w-liczbach-2025-pl` | `33ce2c8700f401f57416e48574bc4d4ec51f383aa86dfdaa5092fa4b353c79f9` |
| `suomi-lukuina-2025-fi` | `e21a5b501e15dc556c1a2c5891e8290287e8493e9fa1a4d37d74c700e8daeb95` |

Recorded runner fingerprints at freeze (uncommitted working tree on
`experiment/radical-context-prune`; 48 lab tests passed):

| file | SHA-256 |
|---|---|
| `grounding_lab/pipeline.py` | `6d2d248969c9e710a7c7da2ff2a027608a84d6fd42e1c4724a1f242a6c54ede7` |
| `grounding_lab/model_benchmark.py` | `449b5372d02c70896aeee7996e24148322c09f558072757d00d88b239e0bd58e` |
| `grounding_lab/calibrate.py` | `a01e70decb84e35484c627476b38adab273337e297846af22e1a857f62369f9b` |

The current `model_benchmark.py` does not match its recorded hash, and no commit
contains that frozen source. These fingerprints establish provenance but cannot
reconstruct the evaluated runner.

## Diagnostic result (one shot, 2026-09-02 10:01–10:03, no retuning)

Raw runner output kept for E only (`FINAL2_E_ZEROHIT_RICH_REPORT.md`); A-D numbers are below.
Recall is measured on the 27 linkable claims that reach the neural stage.

| id | recall@K | correct | links | abstains | wrong | auto precision | total 95% CI | neural ms | peak CUDA GiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A incumbent | 4/27 | 70/100 | 52/75 | 18/25 | 16 | 48/48 | 60%–78% | 48 | 2.72 |
| B validation winner | 6/27 | 75/100 | 51/75 | 24/25 | 2 | 51/51 | 66%–82% | 111 | 2.48 |
| C hit-set bare | 27/27 | 84/100 | 60/75 | 24/25 | 1 | 51/51 | 76%–90% | 174 | 2.51 |
| D hit-set rich | 27/27 | 88/100 | 64/75 | 24/25 | 1 | 61/61 | 80%–93% | 169 | 2.51 |
| **E hit-set rich, zero-hit abstain** | 27/27 | **99/100** | 74/75 | 25/25 | **1** | 62/62 | 95%–100% | 144 | 1.71 |

Correct decisions / wrong links per document:

| document | A | B | C | D | E |
|---|---:|---:|---:|---:|---:|
| espana-en-cifras-2025-es | 12/20 / 5 | 13/20 / 1 | 19/20 / 0 | 20/20 / 0 | 20/20 / 0 |
| fed-monetary-policy-report-2025-06-en | 9/20 / 8 | 11/20 / 0 | 13/20 / 0 | 16/20 / 0 | 19/20 / 1 |
| nederland-in-cijfers-2024-nl | 17/20 / 1 | 17/20 / 1 | 17/20 / 1 | 18/20 / 1 | 20/20 / 0 |
| polska-w-liczbach-2025-pl | 16/20 / 1 | 17/20 / 0 | 17/20 / 0 | 18/20 / 0 | 20/20 / 0 |
| suomi-lukuina-2025-fi | 16/20 / 1 | 17/20 / 0 | 18/20 / 0 | 16/20 / 0 | 20/20 / 0 |

Gate (improve correct decisions over the incumbent without increasing wrong
links): B, C, D, and E met the numerical gate, and E was the numerical winner:
29 more correct decisions than the incumbent, 15 fewer wrong links, perfect
abstention, and it never loads the bi-encoder. The unrecoverable runner means
this does not establish a production candidate. Its single wrong link is on the
Federal Reserve document, whose claims include projection-table cells that
share text and row context. A post-hoc per-claim dump on 2026-09-02 (no
relabeling) identified it as `unemploymentRateMedianProjection2027`: every
cell in a table row carries the same row context.

Caveats: n = 100 claims across five documents, so one claim moves a percent;
the retrieval-based rows A and B are dominated by shortlist misses (4/27 and
6/27 recall), which is the same failure seen on `final_dataset/`; values were
authored from the anchor dumps, so paraphrased extractor output is not
represented. This set is now used and must not be relabeled or re-run after
any further model, threshold, or label change. Its later cross-validation reuse
is diagnostic only and supplies no final or adoption evidence.

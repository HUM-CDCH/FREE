# Models on policy v1 — results

Selected matrix: 88 (22 saved baselines + 66 requested retrieval/extraction runs; originally 176). Completed executor artifacts: 88. Pending blind review items: 0.

Agent-reviewed references; no independent human validation. Coverage uses a fixed inventory, including omitted records and fields. Pending claims are neither accepted nor called unsupported. A page match alone does not establish passage support.

Danish inputs with the Beier schema are literal schema-mismatch stress tests. Their grave discovery inventory is diagnostic; populated German catalogue fields require review. These runs do not qualify a deployment.

| Document / schema | Arm | Rep | Outcome | Discovery | Correct units | Linked units | Unsupported | Wrong links | Pending | Fresh LLM s | Composed s |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| beier / beier | baseline | 1 | SUCCEEDED | 29/29 | 163/164 | 163/164 | 1 | 0 | 0 | 80.5 | 80.5 |
| beier / beier | evie | 1 | SUCCEEDED | 29/29 | 163/164 | 162/164 | 1 | 1 | 0 | 37.0 | 111.1 |
| beier / beier | neomme | 1 | SUCCEEDED | 29/29 | 163/164 | 162/164 | 1 | 1 | 0 | 20.9 | 80.3 |
| beier / beier | gliner | 1 | SUCCEEDED | 29/29 | 31/164 | 30/164 | 87 | 0 | 0 | 22.9 | 55.5 |
| beier / beier | baseline | 2 | SUCCEEDED | 29/29 | 163/164 | 163/164 | 1 | 0 | 0 | 71.5 | 71.5 |
| beier / beier | evie | 2 | SUCCEEDED | 29/29 | 163/164 | 162/164 | 1 | 1 | 0 | 20.8 | 80.3 |
| beier / beier | neomme | 2 | SUCCEEDED | 29/29 | 163/164 | 162/164 | 1 | 1 | 0 | 27.5 | 76.5 |
| beier / beier | gliner | 2 | SUCCEEDED | 29/29 | 31/164 | 30/164 | 87 | 0 | 0 | 22.9 | 36.6 |
| Herredsvejen_SBM1694 / beier | baseline | 1 | SUCCEEDED | 2/3 | 0/0 | 0/0 | 0 | 0 | 0 | 30.1 | 30.1 |
| Herredsvejen_SBM1694 / beier | evie | 1 | SUCCEEDED | 2/3 | 0/0 | 0/0 | 0 | 0 | 0 | 0.0 | 30.1 |
| Herredsvejen_SBM1694 / beier | neomme | 1 | SUCCEEDED | 2/3 | 0/0 | 0/0 | 0 | 0 | 0 | 0.0 | 30.1 |
| Herredsvejen_SBM1694 / beier | gliner | 1 | SUCCEEDED | 2/3 | 0/0 | 0/0 | 4 | 0 | 0 | 1.8 | 29.8 |
| Herredsvejen_SBM1694 / beier | baseline | 2 | SUCCEEDED | 2/3 | 0/0 | 0/0 | 0 | 0 | 0 | 30.4 | 30.4 |
| Herredsvejen_SBM1694 / beier | evie | 2 | SUCCEEDED | 2/3 | 0/0 | 0/0 | 0 | 0 | 0 | 0.0 | 30.4 |
| Herredsvejen_SBM1694 / beier | neomme | 2 | SUCCEEDED | 2/3 | 0/0 | 0/0 | 0 | 0 | 0 | 0.0 | 30.4 |
| Herredsvejen_SBM1694 / beier | gliner | 2 | SUCCEEDED | 2/3 | 0/0 | 0/0 | 4 | 0 | 0 | 1.5 | 29.7 |
| Herredsvejen_SBM1694 / danish | baseline | 1 | SUCCEEDED | 3/3 | 16/22 | 15/22 | 9 | 1 | 0 | 46.8 | 46.8 |
| Herredsvejen_SBM1694 / danish | evie | 1 | SUCCEEDED | 3/3 | 16/22 | 12/22 | 9 | 1 | 0 | 4.7 | 56.3 |
| Herredsvejen_SBM1694 / danish | neomme | 1 | SUCCEEDED | 3/3 | 16/22 | 12/22 | 9 | 1 | 0 | 4.9 | 47.5 |
| Herredsvejen_SBM1694 / danish | gliner | 1 | SUCCEEDED | 3/3 | 11/22 | 11/22 | 7 | 0 | 0 | 8.2 | 42.0 |
| Herredsvejen_SBM1694 / danish | baseline | 2 | SUCCEEDED | 3/3 | 16/22 | 15/22 | 9 | 1 | 0 | 47.0 | 47.0 |
| Herredsvejen_SBM1694 / danish | evie | 2 | SUCCEEDED | 3/3 | 16/22 | 12/22 | 9 | 1 | 0 | 4.7 | 50.5 |
| Herredsvejen_SBM1694 / danish | neomme | 2 | SUCCEEDED | 3/3 | 16/22 | 12/22 | 9 | 1 | 0 | 5.1 | 46.6 |
| Herredsvejen_SBM1694 / danish | gliner | 2 | SUCCEEDED | 3/3 | 11/22 | 11/22 | 7 | 0 | 0 | 8.1 | 41.9 |
| Hojbakkegaard_TAK_1177 / beier | baseline | 1 | SUCCEEDED | 7/9 | 0/0 | 0/0 | 8 | 0 | 0 | 28.9 | 28.9 |
| Hojbakkegaard_TAK_1177 / beier | evie | 1 | SUCCEEDED | 7/9 | 0/0 | 0/0 | 8 | 0 | 0 | 2.8 | 41.1 |
| Hojbakkegaard_TAK_1177 / beier | neomme | 1 | SUCCEEDED | 7/9 | 0/0 | 0/0 | 8 | 0 | 0 | 1.8 | 31.8 |
| Hojbakkegaard_TAK_1177 / beier | gliner | 1 | SUCCEEDED | 7/9 | 0/0 | 0/0 | 4 | 0 | 0 | 1.3 | 21.9 |
| Hojbakkegaard_TAK_1177 / beier | baseline | 2 | SUCCEEDED | 7/9 | 0/0 | 0/0 | 8 | 0 | 0 | 28.9 | 28.9 |
| Hojbakkegaard_TAK_1177 / beier | evie | 2 | SUCCEEDED | 7/9 | 0/0 | 0/0 | 8 | 0 | 0 | 1.7 | 33.5 |
| Hojbakkegaard_TAK_1177 / beier | neomme | 2 | SUCCEEDED | 7/9 | 0/0 | 0/0 | 8 | 0 | 0 | 2.5 | 31.3 |
| Hojbakkegaard_TAK_1177 / beier | gliner | 2 | SUCCEEDED | 7/9 | 0/0 | 0/0 | 4 | 0 | 0 | 1.4 | 21.8 |
| Hojbakkegaard_TAK_1177 / danish | baseline | 1 | SUCCEEDED | 9/9 | 60/66 | 60/66 | 7 | 0 | 0 | 53.9 | 53.9 |
| Hojbakkegaard_TAK_1177 / danish | evie | 1 | SUCCEEDED | 9/9 | 60/66 | 50/66 | 7 | 0 | 0 | 10.9 | 57.6 |
| Hojbakkegaard_TAK_1177 / danish | neomme | 1 | SUCCEEDED | 9/9 | 60/66 | 51/66 | 7 | 0 | 0 | 9.4 | 49.4 |
| Hojbakkegaard_TAK_1177 / danish | gliner | 1 | SUCCEEDED | 9/9 | 43/66 | 42/66 | 18 | 1 | 0 | 17.8 | 43.6 |
| Hojbakkegaard_TAK_1177 / danish | baseline | 2 | SUCCEEDED | 9/9 | 60/66 | 60/66 | 7 | 0 | 0 | 54.1 | 54.1 |
| Hojbakkegaard_TAK_1177 / danish | evie | 2 | SUCCEEDED | 9/9 | 60/66 | 50/66 | 7 | 0 | 0 | 9.5 | 55.8 |
| Hojbakkegaard_TAK_1177 / danish | neomme | 2 | SUCCEEDED | 9/9 | 60/66 | 51/66 | 7 | 0 | 0 | 11.1 | 51.4 |
| Hojbakkegaard_TAK_1177 / danish | gliner | 2 | SUCCEEDED | 9/9 | 43/66 | 42/66 | 18 | 1 | 0 | 18.0 | 43.9 |
| Hvissinge_Ost_TAK_1728 / beier | baseline | 1 | SUCCEEDED | 3/6 | 0/0 | 0/0 | 0 | 0 | 0 | 30.6 | 30.6 |
| Hvissinge_Ost_TAK_1728 / beier | evie | 1 | SUCCEEDED | 3/6 | 0/0 | 0/0 | 0 | 0 | 0 | 0.0 | 30.6 |
| Hvissinge_Ost_TAK_1728 / beier | neomme | 1 | SUCCEEDED | 3/6 | 0/0 | 0/0 | 0 | 0 | 0 | 0.0 | 30.6 |
| Hvissinge_Ost_TAK_1728 / beier | gliner | 1 | SUCCEEDED | 3/6 | 0/0 | 0/0 | 6 | 0 | 0 | 2.8 | 30.1 |
| Hvissinge_Ost_TAK_1728 / beier | baseline | 2 | SUCCEEDED | 3/6 | 0/0 | 0/0 | 0 | 0 | 0 | 31.0 | 31.0 |
| Hvissinge_Ost_TAK_1728 / beier | evie | 2 | SUCCEEDED | 3/6 | 0/0 | 0/0 | 0 | 0 | 0 | 0.0 | 31.0 |
| Hvissinge_Ost_TAK_1728 / beier | neomme | 2 | SUCCEEDED | 3/6 | 0/0 | 0/0 | 0 | 0 | 0 | 0.0 | 31.0 |
| Hvissinge_Ost_TAK_1728 / beier | gliner | 2 | SUCCEEDED | 3/6 | 0/0 | 0/0 | 6 | 0 | 0 | 2.4 | 30.1 |
| Hvissinge_Ost_TAK_1728 / danish | baseline | 1 | SUCCEEDED | 6/6 | 39/49 | 39/49 | 21 | 0 | 0 | 102.6 | 102.6 |
| Hvissinge_Ost_TAK_1728 / danish | evie | 1 | SUCCEEDED | 6/6 | 39/49 | 28/49 | 21 | 3 | 0 | 24.2 | 100.7 |
| Hvissinge_Ost_TAK_1728 / danish | neomme | 1 | SUCCEEDED | 6/6 | 39/49 | 27/49 | 21 | 0 | 0 | 27.0 | 92.5 |
| Hvissinge_Ost_TAK_1728 / danish | gliner | 1 | SUCCEEDED | 6/6 | 19/49 | 19/49 | 49 | 0 | 0 | 42.4 | 82.7 |
| Hvissinge_Ost_TAK_1728 / danish | baseline | 2 | SUCCEEDED | 6/6 | 39/49 | 39/49 | 21 | 0 | 0 | 102.6 | 102.6 |
| Hvissinge_Ost_TAK_1728 / danish | evie | 2 | SUCCEEDED | 6/6 | 39/49 | 28/49 | 21 | 3 | 0 | 24.6 | 95.8 |
| Hvissinge_Ost_TAK_1728 / danish | neomme | 2 | SUCCEEDED | 6/6 | 39/49 | 27/49 | 21 | 0 | 0 | 27.5 | 91.6 |
| Hvissinge_Ost_TAK_1728 / danish | gliner | 2 | SUCCEEDED | 6/6 | 19/49 | 19/49 | 49 | 0 | 0 | 42.4 | 82.9 |
| Brondbylund_3_TAK_1506 / beier | baseline | 1 | THREW | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 6.4 | 6.4 |
| Brondbylund_3_TAK_1506 / beier | evie | 1 | THREW | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0.0 | 6.4 |
| Brondbylund_3_TAK_1506 / beier | neomme | 1 | THREW | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0.0 | 6.4 |
| Brondbylund_3_TAK_1506 / beier | gliner | 1 | THREW | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0.0 | 6.4 |
| Brondbylund_3_TAK_1506 / beier | baseline | 2 | THREW | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 5.0 | 5.0 |
| Brondbylund_3_TAK_1506 / beier | evie | 2 | THREW | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0.0 | 5.0 |
| Brondbylund_3_TAK_1506 / beier | neomme | 2 | THREW | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0.0 | 5.0 |
| Brondbylund_3_TAK_1506 / beier | gliner | 2 | THREW | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0.0 | 5.0 |
| Brondbylund_3_TAK_1506 / danish | baseline | 1 | THREW | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 7.9 | 7.9 |
| Brondbylund_3_TAK_1506 / danish | evie | 1 | THREW | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0.0 | 7.9 |
| Brondbylund_3_TAK_1506 / danish | neomme | 1 | THREW | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0.0 | 7.9 |
| Brondbylund_3_TAK_1506 / danish | gliner | 1 | THREW | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0.0 | 7.9 |
| Brondbylund_3_TAK_1506 / danish | baseline | 2 | THREW | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 7.8 | 7.8 |
| Brondbylund_3_TAK_1506 / danish | evie | 2 | THREW | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0.0 | 7.8 |
| Brondbylund_3_TAK_1506 / danish | neomme | 2 | THREW | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0.0 | 7.8 |
| Brondbylund_3_TAK_1506 / danish | gliner | 2 | THREW | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0.0 | 7.8 |
| Katrinesminde_SBM1116 / beier | baseline | 1 | THREW | 0/13 | 0/0 | 0/0 | 0 | 0 | 0 | 21.9 | 21.9 |
| Katrinesminde_SBM1116 / beier | evie | 1 | THREW | 0/13 | 0/0 | 0/0 | 0 | 0 | 0 | 0.0 | 21.9 |
| Katrinesminde_SBM1116 / beier | neomme | 1 | THREW | 0/13 | 0/0 | 0/0 | 0 | 0 | 0 | 0.0 | 21.9 |
| Katrinesminde_SBM1116 / beier | gliner | 1 | THREW | 0/13 | 0/0 | 0/0 | 0 | 0 | 0 | 0.0 | 21.9 |
| Katrinesminde_SBM1116 / beier | baseline | 2 | THREW | 0/13 | 0/0 | 0/0 | 0 | 0 | 0 | 20.1 | 20.1 |
| Katrinesminde_SBM1116 / beier | evie | 2 | THREW | 0/13 | 0/0 | 0/0 | 0 | 0 | 0 | 0.0 | 20.1 |
| Katrinesminde_SBM1116 / beier | neomme | 2 | THREW | 0/13 | 0/0 | 0/0 | 0 | 0 | 0 | 0.0 | 20.1 |
| Katrinesminde_SBM1116 / beier | gliner | 2 | THREW | 0/13 | 0/0 | 0/0 | 0 | 0 | 0 | 0.0 | 20.1 |
| Katrinesminde_SBM1116 / danish | baseline | 1 | SUCCEEDED | 1/13 | 3/130 | 3/130 | 14 | 0 | 0 | 48.5 | 48.5 |
| Katrinesminde_SBM1116 / danish | evie | 1 | SUCCEEDED | 1/13 | 3/130 | 2/130 | 14 | 0 | 0 | 5.4 | 60.1 |
| Katrinesminde_SBM1116 / danish | neomme | 1 | SUCCEEDED | 1/13 | 3/130 | 2/130 | 14 | 0 | 0 | 5.1 | 49.4 |
| Katrinesminde_SBM1116 / danish | gliner | 1 | SUCCEEDED | 1/13 | 0/130 | 0/130 | 10 | 0 | 0 | 7.5 | 35.2 |
| Katrinesminde_SBM1116 / danish | baseline | 2 | SUCCEEDED | 1/13 | 3/130 | 3/130 | 14 | 0 | 0 | 48.7 | 48.7 |
| Katrinesminde_SBM1116 / danish | evie | 2 | SUCCEEDED | 1/13 | 3/130 | 2/130 | 14 | 0 | 0 | 2.1 | 50.3 |
| Katrinesminde_SBM1116 / danish | neomme | 2 | SUCCEEDED | 1/13 | 3/130 | 2/130 | 14 | 0 | 0 | 2.2 | 46.1 |
| Katrinesminde_SBM1116 / danish | gliner | 2 | SUCCEEDED | 1/13 | 0/130 | 0/130 | 10 | 0 | 0 | 1.2 | 29.5 |

Composed seconds add recorded upstream/OCR work and fresh native/model stages; they are not measured end-to-end latency. Native loads and whole-device GPU samples are separate in results.json. OCR boxes localize source crops; canonical boxes localize parser blocks.

No candidate qualifies while required runs or adjudications are missing. After review, compare each intended-use document and repetition with its matching baseline: no loss of correct units or supported-link units; no added unsupported claims, wrong links, missing/duplicate records; at least one measured quality or runtime improvement.

All OCR executor arms were excluded at the user’s request. Their 88 runs are listed as SKIPPED_USER in excludedRuns. Existing OCR outputs are preserved; no further OCR generation or OCR executor runs are included. Frozen per-run scoring and references are unchanged.

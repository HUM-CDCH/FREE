# Pruning completion — 2026-09-05

Status: complete, 9/9 evaluations succeeded. Retain policy E. Both pruning variants retain recoverable gold but pass six fewer supported values; neither consistently improves claim tail latency. These are development comparisons using legacy thresholds, not production acceptance probabilities.

All 16,764 regenerated anchors preserve IDs, text, page, order and neural scoring context exactly. Table cells now carry logical-table, row, column and role metadata. `inventory.json` records each document comparison and source hashes; `source-pdfs.json` pins the six input PDFs.

One pinned Nemotron model was loaded on the RTX 4090, warmed before every timed policy and used for three rotated repetitions: E/bare/all, bare/all/E, all/E/bare. Raw candidate scores, thresholds, selections, gold and timings are in all nine JSONL dumps. `run.json` records configuration, revision, code hashes, per-document results and wall times; `hardware.txt`, `dependencies.json` and `code/` record the environment.

## Counts (identical in every repetition)

| Population | Policy | Correct links | Unsupported links | Wrong anchors | Review/abstain | Recoverable gold retained | Neural pairs |
|---|---|---:|---:|---:|---:|---:|---:|
| all (360) | E | 154 | 18 | 23 | 165 | 214/214 | 12434 |
| all (360) | bare-number-row | 148 | 18 | 18 | 176 | 214/214 | 12038 |
| all (360) | all-value-row | 148 | 18 | 17 | 177 | 214/214 | 11509 |
| withoutStress (300) | E | 153 | 18 | 23 | 106 | 213/213 | 8565 |
| withoutStress (300) | bare-number-row | 147 | 18 | 18 | 117 | 213/213 | 8169 |
| withoutStress (300) | all-value-row | 147 | 18 | 17 | 118 | 213/213 | 7640 |

The 360-claim population contains 256 supported and 104 unsupported values. Without the output-truncated Buchvaldek–Koutecky extraction, there are 255 supported and 45 unsupported values. All three policies catch 86/104 unsupported values overall, but only 27/45 outside that stress case. Exclusion is reporting-only: the historical six-document CV thresholds remain unchanged.

Bare-number pruning affects 14 claims and all-value pruning 45; neither loses recoverable gold. Neural candidate count p95/p99/max remains 417/461/759 for every policy and repetition. The pair count includes all 196 neural routes, including the singleton field-collision route.

## Latency (milliseconds; each row is one warmed repetition)

| Rep | Policy | Claim p50 | Claim p95 | Claim p99 | Grounding Extraction p50 | p95 | p99 | max |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | E | 31.0 | 763.1 | 1679.5 | 5034.5 | 23270.5 | 23270.5 | 25943.1 |
| 1 | bare-number-row | 38.6 | 783.0 | 1689.1 | 5075.9 | 23873.7 | 23873.7 | 27964.5 |
| 1 | all-value-row | 28.5 | 768.3 | 1734.3 | 3462.5 | 23441.6 | 23441.6 | 26805.0 |
| 2 | bare-number-row | 41.0 | 850.9 | 2102.9 | 4334.5 | 25439.4 | 25439.4 | 32112.7 |
| 2 | all-value-row | 29.8 | 823.2 | 1916.5 | 4460.4 | 24375.5 | 24375.5 | 27766.6 |
| 2 | E | 27.9 | 764.4 | 1660.5 | 4443.2 | 23332.6 | 23332.6 | 25302.5 |
| 3 | all-value-row | 35.0 | 778.0 | 1912.9 | 3405.5 | 23576.5 | 23576.5 | 29282.0 |
| 3 | E | 39.1 | 942.9 | 1798.3 | 7414.6 | 27175.0 | 27175.0 | 29311.8 |
| 3 | bare-number-row | 30.6 | 848.0 | 1802.7 | 4203.1 | 25820.6 | 25820.6 | 27648.2 |

Each row has 360 claim timings and six complete document grounding timings. Extraction generation is historical and is not included. Document wall time includes index preparation and routing, and excludes model loading, warmup, calibration and dump writing. p50 uses the median; p95/p99 use the existing lower order-statistic convention `sorted_values[int(q*(n-1))]`. With six documents this makes p95 and p99 identical; maxima are also shown. Repetitions are repeated inputs, not independent observations. Desktop hardware was not an isolated benchmark host.

Across the three repetitions, median claim p95 is E: 764.4 ms, bare-number-row: 848.0 ms, all-value-row: 778.0 ms. Both variants beat the matching E repetition on claim p95 only once out of three.

## Reproduce

From `prototypes/grounding_lab`:

```powershell
.venv/Scripts/python.exe -X utf8 -m grounding_lab.pruning_experiment final_dataset_3 experiments/2026-09-05/pruning-replay
.venv/Scripts/python.exe -X utf8 -m unittest discover -s tests
node --experimental-strip-types --test scripts/dump-anchors.test.mts
```

Validation at implementation time: 84 Python tests and 3 structural-dump Node tests passed. Existing pruning checks cover singleton routing, empty-prune fallback, and neural scoring after pruning to one candidate. New checks cover structural metadata integrity and separated report counts. No production code, automatic acceptance behavior, push or merge was added.

# Bounded development continuation, 2026-09-30

The continuation stopped within the two-hour cap. The development comparison is
**incomplete**; this evidence does not justify promoting an extraction technique.
Production defaults and the stacked branch base are unchanged; all eight held-out
source groups remain untouched.

The continuation ran from **10:54:39 to 12:47:12 UTC (1 h 52 m 33 s)**.
Admission closed at 12:39:40 UTC; the last already-admitted request drained and the
runner exited normally, without forced termination. It made **15 fresh calls**,
completed one cell, left one unsealed, and did not start the remaining 22 admitted
cells. Across both phases, **13 of 48 registered development cells have scores**:
three documents have all four arms and one has A0 only. Five documents received
inference. Eight cells failed ingestion and four exceeded the nominal call cap;
all remain visible in the population. No paired continuation result exists.

## Registered population and admission

The [pinned selection](../../2026-09-30-extractbench-selection.json) remains
20 source groups / 20 representative documents: 12 development and eight held out.
Their related families contain 75 documents (27 development, 48 held out), kept
within their original splits. Length buckets are metadata, not data splits.
The dataset revision is `51bf3a03eb7feeaef8952be1fc2fc7f924ee72dc`; the inspected
official benchmark revision is `c8e59696b19c50d904801390dedef8d292d529e7`.

The three smoke documents were already completed under all four arms. This
continuation retained the original nine remaining development representatives:

| Admission result | Groups | Consequence |
| --- | ---: | --- |
| Native-text ingestion failed | 2 | Byline page 24 and CLIN pages 44–60, 64–66 lack native text; gold was not decoded. |
| Nominal requests exceeded the fixed cell cap | 1 | DD1155 needs 68 calls per arm; the cap remains 60. |
| Admitted to the unchanged A0–A3 matrix | 6 | 24 cells, 268 nominal requests; recovery is additionally constrained by cell, global and elapsed-time caps. |

All 12 development PDFs were downloaded; ten passed native-text ingestion.
Nine groups were eligible for inference including the three smoke groups.
No long-category document was admitted. A 40-page medium-category source was
admitted, but admission is not evidence that its extraction completed.
No held-out PDF was downloaded or parsed, and no held-out annotation was decoded.
See [adapter checksums](adapter-manifest.json), [preflight](preflight.json),
[population counts](population.json), and [parser reproduction](parser-reproduction.json).
The latter reproduced all 218 development pages without inference. PDFs, source
text, gold, raw replies and request caches remain in ignored storage.

## Results and limitations

These are **custom harness scores**, not official ExtractBench or leaderboard
scores. Raw exact JSON-value equality and field-specific canonicalization are
separate, with punctuation preserved. Both views use the same record
correspondence. Empty scores mean unavailable, not zero.

The [48-row per-document table](per-document-all-development.csv) retains every
registered development arm, including ingestion failures, budget exclusions,
unfinished cells and unstarted cells. The [scored report](report-v2-sanitized.json)
contains only sealed results; it must not be used to rank arms on unequal subsets.

| Newly scored document / arm | Raw precision / recall / F1 | Canonical precision / recall / F1 | Repeated matched / gold | Complete repeated records |
| --- | --- | --- | ---: | ---: |
| Illinois fleet rate card / A0 | .5000 / .6628 / **.5700** | .6842 / .9070 / **.7800** | 28 / 28 | 0 under either view |

The scorer counts 29 total records: one wrapper plus 28 repeated records. None
was strictly complete. It found no missing, duplicate or unmatched extra records,
but counted **28 populated fields where gold marks absence**, and **8 wrong
canonical values** (29 under raw equality), over 86 populated gold leaves.
A0 intentionally cites no evidence: its annotated page-grounding hits are 0/86.
This single unpaired case cannot establish a technique effect.

The Viega quote cell consumed **14 calls** and remained unsealed. Across those
calls, **nine replies hit the 4,096-token cap** and **eight calls were the declared
recovery subdivisions**. Its incomplete cached responses retain their costs but
receive no value, record-completeness or grounding score. This truncation and
elapsed-time limitation is the largest new operational failure. No long or
cross-page extraction performance was validated by the continuation.

The earlier [three-case smoke study](../README.md) found duplicate wrapper
fragments, unmatched extra records, missing repeated records and absent/wrong
values. None of its arms produced a fully correct repeated record or document.
These are scorer categories, not human-adjudicated causes. The throughput
[control experiment](../throughput/README.md) found only 0.143 seconds median
harness overhead (0.26%) and essentially identical decode speed near 7.8 tokens/s.
Large generated responses and bounded truncation recovery consume time; this
does not establish a paired quality or cost comparison between techniques.

Raw evidence selection and source-only literal refinement remain separate and
equivalent for quote and ID variants. Sealed artifacts retain both. Unsealed
response caches are not promoted to scored predictions or invented refined
evidence. Only annotated coarse page grounding is scored with this native-line
adapter; semantic support and exact geometric localization remain unavailable.
No verifier, exclusion of flagged values, confidence model or risk certification
was used in this continuation.

## Reproducibility and accounting

| Revision | Purpose |
| --- | --- |
| `16819c72cf1ef54bfdf73d4159c5ee65dce048f8` | Preserved stacked base |
| `f5827cd7ab8df2f6f63e9816608822618c4c6a6f` | Original harness and pilot checkpoint |
| `2a2b6d4586179919accbae7800d5071a7df6cb00` | Evaluator v2, adapter and smoke execution |
| `677ec96f6fc0765d0396df977098b0d373ac0edb` | Final harness source; transport-failure usage accounting correction |
| `f166c0f70467d07fb75522574e2cfee96758f8f5` | Actual continuation launch: prospective protocol, runner and tests |
| `1ecf0fd57a7ab24c294eb47dbf2e04a0092cb3e7` | Preserved throughput evidence and later user-selected runtime amendment |
| `30255ecc1057057c8ca8d2694849708fd499394f` | Offline audit and parser reproduction; harness source unchanged |

The launch [manifest](launch-manifest.json) pins 100 source files with aggregate
`3848aa62401d5185074fdd3321450d8ecc185c5372b17043bb291a7ac4fc1408`.
Model/server, parser, schemas, decoding and recovery remained frozen. A0 explicitly
requests no evidence; A1 adds only continuation flags, A2 quotes and A3 IDs.
The [audit](audit.json) reconstructs effective requests from inference-only inputs
and the pinned provider adapter, checks every saved request and keeps recovery
requests distinct. It is not a network packet capture.

The original smoke gate failed on exact usage; its [prospective amendment](protocol-amendment.md)
allows bounded historical uncertainty without changing that historical result.
The later [two-hour amendment](runtime-cap-amendment.md) is measured from the
original start, with a 105-minute admission window and 15-minute drain. The initial
eight-hour start record is preserved and superseded, never rewritten. Deadline
denial may use the runner's generic `stopped_by_study_budget` status; it does not
mean 400 calls were consumed. No requests are restarted or refunded.

| Phase / cell | Fresh calls charged | Known input tokens | Known output tokens | Unknown requests |
| --- | ---: | ---: | ---: | ---: |
| Earlier smoke, preserved conservative charge | 37 | 56,213 | 28,378 | 1 |
| New Illinois / A0 | 1 | 1,193 | 1,866 | 0 |
| New Viega / A2, unsealed | 14 | 24,319 | 50,434 | 0 |
| **Total development** | **52** | **81,725** | **80,678** | **1** |

The historical unknown request retains its **36,864-token additional upper bound**.
The continuation used 15 of its 400-call allowance, with zero replayed calls and
no unknown usage. Both cell budgets passed. Its known client-response time totals
6,751.14 seconds out of 6,753.19 seconds of runner wall time; this includes network
and server time and is not a separate server-only latency measurement.
The runner's `admission_deadline_reached: false` refers to its original eight-hour
deadline; the later two-hour amendment stopped it through `STOP_REQUESTS`.
Its `not_run_budget_spent` aggregate corresponds to the CSV's 22 `not_run` rows.

`cost_as_if_cold` in the scored report covers sealed results only. Use the journal
in [audit.json](audit.json) and the CSV's operational columns for actual spending,
including the unsealed cell. The earlier operational replay (one response), the
separate 36-response compatibility replay, live synthetic checks and the throughput
benchmark remain separate; none is counted as new development inference.
The [server check](server-verification.json) matched all ten original container
configurations and verified health. The runner exited, and only its owned SSH
tunnel was closed; the model server was never stopped or reconfigured during this
continuation.

The frozen implementation passed 160 fast tests (including the runner fixtures).
Two live-provider tests passed on the same harness source; their synthetic costs
are separate from development. The old 36-call replay and this final audit make
zero fresh requests. Direct optional experiment dependencies declare `scipy`,
`jsonschema` and `requests`; no dependency was installed for this increment.
See [verification](prelaunch-verification.json), [audit fixtures](audit-verification.json),
[reproducible commands](reproduce.md), and [final checks](finish-verification.json).

## Production decision and next protocol

Keep the production extraction configuration unchanged. The complete development
comparison needed to select a challenger is unavailable. Preserve the declared
baseline and candidates; first resolve native-text admission and resource limits
in a separately dated development protocol, without selecting replacements from
model outcomes or silently expanding this study's budget.

The [proposed final protocol](../final-protocol-proposal.md) requires all twelve
development groups before choosing one of A1–A3 against A0. Its primary selection
metric is mean raw field F1 per source group, subject to complete repeated-record
and source-failure safeguards, with output-token cost breaking exact ties. Then
freeze both configurations, evaluator, parser/model artifacts, schemas, requests,
recovery and budgets before a single paired comparison on the eight held-out
groups. That future run is not authorized or performed here.

The [methods audit and FREE gold-data plan](../../2026-09-30-extraction-harness-methods.md)
state LTT/CRC's separate targets and assumptions, replace the universal “22 groups”
rule with method-specific conditions, and propose human annotation of authorized
catalogues. Existing model labels are not human ground truth.

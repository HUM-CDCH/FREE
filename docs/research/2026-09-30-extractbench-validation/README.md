# ExtractBench development validation, 2026-09-30

> Historical smoke-only report. The later [bounded development continuation](development-continuation/README.md)
> preserves these results and records the prospective gate amendment, two-hour cap,
> additional execution, and the still-incomplete development comparison.

The harness is checkpointed and the three-document development smoke study is
complete. Its evidence is insufficient to recommend a technique. The remaining
nine development documents were **not run**: one interrupted request left unknown
usage, failing the prospectively frozen expansion gate. All eight held-out groups
remain untouched. No production default changed; nothing was merged or pushed.

## Revisions and data

| Purpose | Commit |
| --- | --- |
| Stacked base, retained | `16819c72cf1ef54bfdf73d4159c5ee65dce048f8` |
| Original harness, tests and pilot evidence checkpoint | `f5827cd7ab8df2f6f63e9816608822618c4c6a6f` |
| Evaluator v2, adapter and actual smoke execution | `2a2b6d4586179919accbae7800d5071a7df6cb00` |
| Final accounting correction and verification | `677ec96f6fc0765d0396df977098b0d373ac0edb` |

The last correction marks failed transport requests as unknown usage while keeping
their call/token reservations. It was made **after** the smoke study; extraction,
prompts, schemas, parser, evidence processing and evaluator did not change.
The final revision passed **155 fast tests and two live-provider tests**. A separate
replay with new generation disabled reproduced all twelve predictions and quality
counts exactly: zero fresh calls, 36 replayed calls. See [verification](verification.json)
and [replay hashes](final-code-replay.json). `scipy`, `jsonschema` and `requests`
are direct optional experiment dependencies; no new package was installed.

ExtractBench is pinned to dataset revision
`51bf3a03eb7feeaef8952be1fc2fc7f924ee72dc` and official benchmark code
`c8e59696b19c50d904801390dedef8d292d529e7`.
The [selection manifest](../2026-09-30-extractbench-selection.json) has
**20 real source groups / 20 representative documents: 12 development, 8 held out**.
Their metadata-related families contain 75 documents (27 development, 48 held out),
reserved within the same splits. Length categories are metadata. Group independence
is an assumption, not established by filename similarity.

Only three development PDFs were downloaded and ingested: Pepco (3 pages), Grafton
(1), and Mission/Tyler (2). These were selected before model execution, visually
spot-checked against their annotations, and passed gold-as-prediction roundtrips on
20, 27 and 58 populated leaves. The selected population also includes long and
repeated-record cases, but **no long document has yet been validated**. See the
[source and gold audit](../2026-09-30-extractbench-source.md) and
[adapter manifest](adapter-manifest.json). Downloaded PDFs, source text, gold and
model responses remain in ignored task storage, with committed checksums only.

## Results

These are **custom harness scores**, not official ExtractBench scores. Structural
schemas exclude annotation-bearing prose; inputs are PDFium native line text.
Array records are matched within their parent and scored at their leaves. Raw
exact equality and field-specific canonicalized equality are reported separately;
punctuation is preserved. See the frozen [protocol](protocol.md).

Each arm processed the same three source groups, 105 populated gold leaves and
10 repeated gold records. The table pools field counts across documents; macro
F1 averages the three source-group scores equally. All arms had zero completely
correct documents and zero completely correct repeated records under either view.

| Arm | Change from A0 | Pooled raw F1 | Pooled canonical F1 | Macro raw F1 | Macro canonical F1 | Repeated predicted / matched / missing / extra |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| A0 | No evidence, bounded recovery | .4085 | .4930 | .4546 | .5405 | 34 / 7 / 3 / 27 |
| A1 | Continuation flags | .3780 | .4331 | .4312 | .4975 | 11 / 2 / 8 / 9 |
| A2 | Quotes | .4549 | .5490 | .4887 | .5846 | 20 / 7 / 3 / 13 |
| A3 | Evidence IDs | .4444 | .5397 | .4789 | .5724 | 20 / 7 / 3 / 13 |

The repeated-record matcher identified no exact repeated-record duplicates; the
wrapper-document matcher identified 5, 4, 4 and 4 duplicate fragments respectively.
“Extra” means unmatched by this custom matcher, not human-confirmed fabrication.
The report's legacy `hallucinated_records` key has that same limited meaning.
Wrapper documents and nested repeated records are separate counters: their combined
gold count is 13, whereas the repeated-only gold count above is 10.

| Document | A0 raw / canonical F1 | A1 | A2 | A3 |
| --- | --- | --- | --- | --- |
| Pepco, 3 pages | .2564 / .3077 | .2564 / .3077 | .3143 / .3429 | .3030 / .3636 |
| Grafton, 1 page | .7308 / .8462 | .7308 / .8462 | .7308 / .8846 | .7308 / .8462 |
| Mission/Tyler, 2 pages | .3766 / .4675 | .3065 / .3387 | .4211 / .5263 | .4030 / .5075 |

Annotated page grounding is coarse: A2 has 67/104 canonical-value-plus-page hits
and A3 65/104; raw-value-plus-page hits are 55/104 and 54/104. A0/A1 intentionally
provide no citations. One populated leaf lacks a usable evidence annotation.
Raw passage selections and source-only refined literal locations are retained
equivalently for quote and ID arms. A parent citation may cover several nested
leaves. **Exact geometric localization and semantic support are unavailable** for
this parser/annotation pairing; a correct page does not establish either.

The largest observable error categories were:

- Duplicate wrapper fragments and values: 55/51/46/42 duplicate-value penalties
  for A0/A1/A2/A3. Values on unmatched extra records add 43/33/23/24 penalties.
- Missing repeated records, especially Mission/Tyler: A0/A2/A3 miss three of its
  eight records; A1 misses all eight under the fixed matching rule.
- Missing or wrong values: canonical wrong-value counts are 6/8/7/9; populated
  values marked absent are 17/8/16/16. Missing records account for another
  12/34/12/12 missed populated leaves.

These are scorer categories, not independently human-adjudicated causes. They
motivate inspecting record boundaries and matching on development data; they do
not justify tuning against the holdout. The three small source groups cannot
establish generalization or support a challenger selection.

## Execution and limits

All 12 cells sealed with schema-valid replies, complete source-region processing,
no truncation, no recovery subdivision and no reported region failures. The
interruption before one A0 cell sealed is a separate operational failure and is
preserved in [its reconciliation](interruption-reconciliation.json).

| Arm | Completed requests as if cold | Input tokens | Output tokens |
| --- | ---: | ---: | ---: |
| A0 | 9 | 13,835 | 5,579 |
| A1 | 9 | 14,168 | 5,737 |
| A2 | 9 | 14,168 | 9,057 |
| A3 | 9 | 14,042 | 8,005 |

Actual study spending is **36 completed fresh responses plus at most one
interrupted in-flight request**, conservatively charged as 37 of the 100 smoke
calls. Known usage is 56,213 input + 28,378 output tokens, a lower bound; the
unknown request has a conservative 36,864-token upper bound. One saved response
was replayed during resume (1,902 input / 877 output tokens at its original cost);
it is not charged again as fresh. Known fresh-response time totals 3,645.64 seconds;
this excludes unknown interrupted time and is not study wall time.

Both call and conservative token budgets passed. Complete usage accounting did
not, so the reserved 400 calls for the remaining nine development cases were never
opened. The later 36-call compatibility replay was cache-only and does not repair
that gate. Final synthetic live validation used four fresh calls (617 input / 854
output tokens) plus one replay, separately from development. Earlier validation
used four fresh calls plus one replay; two probe token totals were not logged then
and remain unknown in [verification](verification.json).

The existing Spark `baratheon` server generated about 7.8 tokens/second with no
request queue: roughly four minutes for 2,000 output tokens. The observed dense
FP8 workload is consistent with a memory-bandwidth constraint; see the qualified
[serving observation](serving-observation.md). No model, server or worker setting
was changed to accelerate this study.

The [full report](development-smoke-report-v2.json), [per-document CSV](per-document.csv),
[request/configuration audit](development-smoke-audit.json), [execution manifest](execution-manifest.json)
and [reproduction commands](reproduce.md) preserve denominators, failures, effective
request hashes and raw/refined evidence counts. Historical pilot files remain
unchanged; 53 saved cells were rescored into separate v2 reports with no inference.
See [pilot corrections](pilot-correction.md) and [rescore integrity](rescore-integrity.json).

The [proposed final protocol](final-protocol-proposal.md) first completes development
under a prospectively amended execution plan, then freezes A0 against one selected
challenger for a paired eight-group holdout comparison. It selects no challenger
now. The [LTT/CRC audit and FREE catalogue gold plan](../2026-09-30-extraction-harness-methods.md)
replace the universal “22 groups” claim with method-specific conditions and keep
human annotations separate from model labels. No formal certification is claimed.

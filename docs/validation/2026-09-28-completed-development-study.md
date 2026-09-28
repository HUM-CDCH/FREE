# Completed development cells: replay and results — 2026-09-28

Status: **all 95 completed R1/R3/R4 cells exactly replayed; full study unfinished**.
This closes the outstanding replay/reporting work for completed cells without
resuming the user-deferred matrix. The existing 30-cell R2a acceptance and its
result/report hashes were also rechecked. No new model generation occurred.

The main findings remain unfavorable to unconditional adoption of the tested
bounded-context and structured-rendering variants. These are development-corpus
results under frozen historical code, schemas and canonical parses. They do not
evaluate the latest integrated runtime or establish generalization.

## Coverage and integrity

| Study | Results / registered | Verification now | Partial processing | Missing |
|---|---:|---|---:|---:|
| R1: Article/Catalog factors | 79/79 | All cells replayed from 3,351 saved replies | 8 | 0 |
| R2a: value-unit selection | 30/30 | Existing complete conditional-replay receipt and output pins rechecked | See its conditional-study report | 0 |
| R3: plain/structured rendering | 12/12 | All cells replayed from 79 saved replies | 1 | 0 |
| R4: token/structural grouping | 4/12 | All completed cells replayed from 122 saved replies | 0 of 4 completed | 8 |

R1's generic Catalog reference does not report a processing-completeness field;
it is shown separately from the eight explicitly incomplete cells. A sealed
result or successful replay does not make its predictions correct or complete.
No missing result was treated as a model failure, a success, or a zero-cost result.

Replay used each study's original frozen runtime and exact captured requests/replies.
Only top-level clocks are excluded from artifact equality. Initial replay added
609 separately cached tokenizer probes (R1 65, R3 1, R4 543). A second replay
blocked HTTP and used zero fresh tokenizer/model calls. These later counts are
admission checks, not new extraction observations or a weights attestation.

The corrected frozen analyzer is byte-identical to the reporting checkout's
analyzer. It retains repeated metadata disagreements, exact/normalized distinctions,
extra predictions, explicit missing cells and document-level paired effects.
The terminal audit verifies 9,603 distinct pinned capture/result/probe/report/receipt
files. The collector exited normally after about 55 seconds.

## Primary development effects

The metric is the unchanged collagen scorer's populated sample-field accuracy
lower bound after its identity/projection gates. Pending review stays in the
denominator; empty-field scores and unscored predictions remain separate. Every
accuracy comparison below has six development-document pairs. Intervals are
descriptive document-bootstrap intervals (10,000 draws, seed 20260927), not
independent generalization evidence. No hypothesis-test p-values are asserted.
R1 and R3 have one registered repetition per arm. Their observed differences
can include request-to-request model variation; resampling six documents does
not measure or remove that variation. Temperature zero does not guarantee
identical replies, as the later repeated-request audit demonstrates.

| Comparison | Mean accuracy change, pp | Descriptive 95% interval, pp |
|---|---:|---|
| R1 reference → conservative identity | −0.18 | [−0.53, 0.00] |
| R1 identity → schema prompt | −0.76 | [−2.27, 0.00] |
| R1 schema → bounded context | −33.35 | [−49.06, −16.40] |
| R1 bounded → quoted grounding | −1.52 | [−4.55, 0.00] |
| R1 schema → full-source quoted grounding | 0.00 | [0.00, 0.00] |
| R1 bounded → preceding overlap | +3.55 | [−3.79, +14.42] |
| R1 bounded → grounding disabled | −0.82 | [−3.79, +1.34] |
| R3 plain → structured rendering | −24.12 | [−49.79, −3.93] |

All 18 R1 grounding-policy pairs have different regenerated upstream records or
inventory. Grounding cannot cause a preceding raw-value change; those accuracy
deltas are not causal estimates of verifier quality. Even the zero-width interval
does not establish equivalence. The later fixed-upstream R5 pilot addresses this
design issue, but only on one selected development document so far.

The main context/rendering effects by paper are:

| Paper | R1 bounded minus schema, pp | R3 structured minus plain, pp |
|---|---:|---:|
| Akita | −15.51 | 0.00 |
| Harvey | −44.44 | −77.78 |
| Mizuta | −36.36 | +4.55 |
| Sousa | −38.46 | −32.69 |
| Wang | −65.31 | −38.78 |
| Zelechowska | 0.00 | 0.00 |

Harvey structured refuses inventory because 28,974 input plus 4,096 reserved
output tokens exceeds 32,768 by 302; its zero-record outcome stays in the result.
Sousa and Wang retain identity/inventory failures discussed in the
[failure audit](2026-09-27-extraction-failure-cases.md). More returned records or
more explicit table syntax are not themselves evidence of better recall.

R4 has **no paired estimate**. All four completed cells are token-grouping controls
(Harvey, Mizuta, Sousa, Zelechowska); none of the six structural treatments has
run. The remaining token controls are Akita and Wang. Do not compare these four
controls to another study revision and call that a structural-grouping ablation.

## Cost, failure and unscored-output accounting

| Study | Artifact call entries | Failed entries | Saved replies | Reported input tokens | Reported output tokens | Entries with unavailable usage |
|---|---:|---:|---:|---:|---:|---:|
| R1 | 3,355 | 71 | 3,351 | 26,794,576 | 916,377 | 4 |
| R3 | 80 | 1 | 79 | 1,316,661 | 37,827 | 1 |
| R4 completed subset | 122 | 0 | 122 | 765,126 | 43,812 | 0 |

Call entries include pre-inference refusals, explaining why they exceed saved
replies. R1 retains 64 literal-control JSON failures, three truncated replies
and four admission refusals. R3's sole failed entry is Harvey's inventory refusal.
Later decoder/prompt changes did not repair these frozen outcomes retroactively.

R1's completed-attempt receipts count 3,150 fresh and 201 reused saved replies;
R3 and the completed R4 cells count 79 and 122 fresh replies respectively. Replay
does not add to these original generation counts. Reused replies retain historical
tokens/durations and are counted once in artifact totals, not charged again as
new replay inference.

There are also **four unknown prior completions** from interrupted R1 attempts:
Akita full-quoted, Akita overlap, Harvey reference and Harvey quoted. Each has a
started receipt without a finished receipt; the successful recovery records one
unknown prior completion. Their possibly incurred extra work is not measurable
from saved replies. Thus the token totals above are reported usage, not complete
total spend. Shared-provider call durations and recovery wall times are not
end-to-end production latency.

R1 schema-to-bounded costs have 15 document pairs but only 14 with available
input-token deltas: Age's control refused both calls. Mean calls rise by 25.47;
mean input tokens rise by 115,340 among the 14 measurable pairs. Do not impute
Age's unavailable usage as zero. On R3's six pairs, mean calls fall by 1.33 while
input tokens rise by 4,810; the failed Harvey inventory contributes to both figures.

Catalog has one unannotated document. Recipe/no-overlap/verification-off each
make seven calls and return seven records; removing overlap saves 440 input tokens.
Generic Catalog makes 14 calls. These are operational observations, not Catalog
accuracy, exhaustive recall, or a measured benefit of removing verification.

The regenerated accounting preserves output hidden by the gold projection:

| Study | Unscored extra-record rows | Array items not selected by gold projection | Array items on unannotated sources |
|---|---:|---:|---:|
| R1 | 113 | 2,247 | 720 |
| R3 | 6 | 147 | 0 |
| R4 completed subset | 14 | 344 | 0 |

These count rows/items across cells, not unique entities or independent observations.
They include the schema's array structures, not just scientific measurements.
Unscored does not mean false or correct. Full per-item values, canonical links,
quoted support and projection status remain in the accounting JSON review queues.
Human adjudication and exhaustive evidence/record recall remain unavailable.

## Reproduction and outstanding gates

The isolated output directory is
`/home/gennaro/projects/FREE/artifacts/extraction-ablation/completed-development-20260928/`.
It contains `registration.json`, `collect.py`, process receipts/logs, separately
cached token counts, and `r1-`, `r3-`, `r4-` prefixed replay, analysis, accounting
and full Markdown table files. It does not overwrite the original collector's
reserved `*-final` paths, snapshots, source code or captures.

| Artifact | SHA-256 |
|---|---|
| `registration.json` | `6bb0f06726d96fffb9e03cbfb15326fe9712628effe01586390ee4f0252e6392` |
| `complete.json` | `4b4e320fa660f9bae1f8f252e05627f3ce47b9a46ca98ffbbb2fe088f802742d` |
| `terminal-audit.json` | `05e6346cf483a5f47947037de1ce6001ae8398ff91e35e370a965d3011c26372` |

For another replay, use a new report filename, the registered frozen runtime,
the pinned `extraction_capture_replay.py` helper and this directory's token cache.
For example, from `artifacts/extraction-ablation/frozen-execution/r3`:

```sh
PYTHONPATH=src:. PYTHONDONTWRITEBYTECODE=1 \
  /home/gennaro/projects/FREE/prototypes/parsing_service/.venv/bin/python \
  /home/gennaro/projects/FREE/artifacts/extraction-ablation/final-collection-20260928-v2/helpers/extraction_capture_replay.py \
  /home/gennaro/projects/FREE/artifacts/extraction-ablation/20260927-r3-rendering \
  /tmp/r3-replay-new.json \
  /home/gennaro/projects/FREE/artifacts/extraction-ablation/completed-development-20260928/token-counts/r3
```

Without `--allow-tokenize`, missing counts fail instead of contacting the model
service. The completed collector additionally blocks HTTP at the requests boundary.
Its one-shot launcher refuses existing outputs; do not rerun it over this directory.

The [execution record](2026-09-27-extraction-ablation.md) retains R2a's conditional
selection results. The later [R5 pilot](2026-09-28-grounding-pilot.md),
[Opus audit](2026-09-28-grounding-pilot-audit.md) and
[Harvey micro-pilot](2026-09-28-harvey-grounding-micro.md) remain separate experiments.
R4 is still 4/12 and R5 is still 6/90. The full matrix remains user-deferred.
This report closes the completed-cell replay gap, not the full research goal.

Remaining acceptance gates are the deferred comparisons, semantic adjudication
of extra/compound claims, and the [untouched-family evaluation after policy freeze](../plans/2026-09-27-modular-extraction-ablation-study.md#m7--independent-evaluation-after-policy-freeze).
No independently annotated untouched corpus has been supplied. Existing PDFs
remain development data; no production default or accuracy claim is promoted.

# Grounding pilot results — 2026-09-28

Status: **six pilot cells complete and exactly replayed; full matrix deferred**.
The [pilot decision](../plans/2026-09-28-grounding-pilot.md) records the user's
request for faster feedback. Generation and offline collection finished at
07:50 UTC, about 38 minutes after the first model worker started.

On this document, span IDs plus schema policy and unresolved-claim scheduling
used **75% fewer calls, 59.6% fewer input tokens and 68.6% fewer claim–source
decisions** than generated quotes. It retained 35 linked claim paths versus 30.
Those counts do not establish higher semantic accuracy: two baseline paths were
lost, and exact source locations do not prove that a quote supports every part
of a claim. Routing added cost and lost two links relative to the combined arm.

## Controlled scope

The six methods use the same two extracted records, 78 enumerated claims,
two source contexts, canonical generation, schema and Qwen provider. They are
six existing cells of the registered 90-cell R5 matrix, not extra repetitions.
Only the registered grounding settings differ. All inputs and the 80-file runtime
archive remain pinned; execution order and the prerequisite to finish original
collection were explicitly changed for the pilot.

Zelechowska was selected for fast engineering feedback: it was the cheapest
development-gold Article with all six methods and no span-budget refusal in
preflight. It is not representative or held out. Its canonical document contains
122 passages and **no structured table cells**. This pilot cannot establish
table-cell accuracy or long-document behavior.

The inherited claim enumerator excludes two boolean leaves. Policy arms mark
36 status leaves as derived, leaving 42 eligible claims. The report retains the
78-claim denominator; skipped fields are not verified or presumed correct.

## Cost and retained links

All six cells completed without failed model calls, context refusals, retries,
reused replies or unknown usage. Together they made 101 fresh calls. Recorded
call time includes provider contention and request overhead; it is not a
repeatable serving-latency estimate. At most two R4/pilot workers ran together;
the original workers drained while the pilot took their slots.

| Method | Calls | Input tokens | Output tokens | Recorded minutes | Claim–source decisions | Linked / 78 |
|---|---:|---:|---:|---:|---:|---:|
| Generated quotes | 40 | 222,156 | 5,777 | 14.68 | 156 | 30 |
| Span IDs | 16 | 141,942 | 4,413 | 11.27 | 156 | 35 |
| Span IDs + unresolved scheduling | 14 | 131,187 | 3,512 | 9.44 | 122 | 34 |
| Span IDs + schema policy | 10 | 91,753 | 2,518 | 6.74 | 84 | 35 |
| Span IDs + both | 10 | 89,770 | 1,617 | 4.42 | 49 | 35 |
| Previous arm + origin/lexical routing | 11 | 94,641 | 1,725 | 4.57 | 54 | 33 |

Span IDs alone reduce batching/output overhead; they still request all 156
claim–source decisions. Policy and unresolved scheduling reduce the comparisons
themselves. The combined arm saves 132,386 input tokens and 4,160 output tokens
against generated quotes. Its observed recorded time is 69.9% lower, but this
single shared-provider execution cannot support a general speedup claim.

The separate factors matter:

- Schema policy reduces span-only calls from 16 to 10 and preserves all 35
  linked paths, although one selected proof changes.
- Unresolved scheduling alone saves two calls but loses one notes-field link.
  With policy, it reduces decisions from 84 to 49 and output tokens from 2,518
  to 1,617 while retaining the same 35 paths. Calls remain at 10; two proofs change.
- Routing adds one call and 4,871 input tokens over the combined arm and drops
  two links. It provides no observed benefit on this two-context document.
- The scheduling × policy interaction is not additive: the document-level
  difference of differences is +2 calls and +8,772 input tokens. There is only
  one document, so the report correctly provides no bootstrap interval.

## Evidence changes and semantic limits

All 204 retained proofs pass literal source-location checks, including 172 span
offset checks. For the 28 claim paths shared by quoted and span-only arms, 26
retain the same canonical passage, cell, page, geometry and precision. The two
other links move the analyte evidence to the results paragraph. Prose spans
retain coarse segment geometry; they do not invent word boxes or table cells.

The quoted control records six rejected-quote diagnostics. Three saved replies
omit canonical control character `U+000E` near temperature units, making otherwise
matching text fail the exact-substring test. Those three paths later receive
links from another context, so they are not three missing final claims.
Span-only reconstructs 16 proofs containing that character without asking the
model to copy it. This preserves the canonical text; it does not repair OCR.

Assistant inspection of changed links found these review cases:

- Span-only adds seven paths and loses two relative to quoted verification.
  The lost ASC link quotes acetic-acid extraction and may represent lost support.
  The lost NaOH-P baseline link quotes pepsin addition, which does not establish
  NaOH pretreatment on its own. Neither link counts nor exact substrings resolve
  these attribution questions.
- The thermal-condition span contains the solution concentration, heating
  schedule and denaturation criterion in one 461-character source paragraph.
- Policy-only changes a compound notes proof to a dialysis-method paragraph
  that does not contain the claimed conversion factor **15.7**. The combined arm
  instead selects the results paragraph containing that number. Equal linked-path
  counts therefore do not establish equally complete support.
- Unresolved scheduling alone drops record 0's hydroxyproline notes link.
  Routing drops record 0's composition-basis link and record 1's notes link;
  it also changes sample-scope evidence from the title to a section heading.

These are diagnostic inspections of saved source excerpts, not independent human
annotations. The 46-entry change queue remains explicitly unadjudicated. Semantic
precision, evidence recall and unsupported-link rate remain unavailable.

Upstream values and their existing identity-gated scores are unchanged in every
arm: 10 of 11 populated projected values are correct, with one requiring review.
This matches the original bounded result and does not score grounding correctness,
all 78 claims or every extra prediction. No production default is changed.

## Reproduction and remaining work

Artifacts are under
`/home/gennaro/projects/FREE/artifacts/extraction-ablation/20260928-r5-grounding/pilot-zele-20260928/`.
The supervisor completed with exit status 0. `terminal-audit.json` verifies the
collection receipt, full input validation, 356 capture/result/tokenizer pins,
six exact replays with zero fresh model/tokenizer calls, unchanged upstream
scores, literal locations and unchanged prior fields in the uncertainty report.
Earlier two-arm checkpoints agree with the final reports.

| Artifact | SHA-256 |
|---|---|
| `verification.json` | `7a058cfcf42e9a2905acad26813bbed5e9ca3355d95a2e2ae247f847286193a1` |
| `grounding-report.json` | `15d75378f0fe7caa54332ada57fe9d062a74fe41c2e73ca31d52a4382950a7b8` |
| `grounding-report-uncertainty.json` | `cc22e4bfe69cdaa275a815ee26b4b8adb154218b2ecf8aeaac8aa774409bf6e4` |
| `analysis.json` | `c5cb90bae8d44344b878e234ebb50bfc17d90d607c434f9fbfc6bbc08879af6f` |

The manifest still has **6 completed and 84 pending cells**. All six comparisons
and the interaction have one observed document and 14 explicitly excluded pending
documents; unavailable costs are not zero. The original R4 comparison and final
R1/R3/R4 collection also remain unfinished. Keep their admission deferred as the
user requested; do not restart old supervisors or duplicate these six cells.

The useful next engineering target is the span catalogue's input overhead:
the full preflight refused 20.8% of span-only claim–unit pairs, including every
pair for Hvissinge. This pilot was selected outside that failure case. A compact
rendering revision needs new code/input pins and tokenizer checks before further
fresh comparisons. Preserve this pilot and the original registered evidence.
The present result supports further evaluation of span IDs plus policy and
unresolved scheduling, not automatic adoption or a claim that the study is complete.

# Prioritized grounding pilot — 2026-09-28

Status at 07:55 UTC: all six cells completed; exact offline replay, reports and
terminal audit passed. See the [pilot results](../validation/2026-09-28-grounding-pilot.md).
The full matrix remains deferred. This decision supersedes the earlier instruction to wait for all original
collection before R5. It does not complete or cancel the full study.

The user selected “Prioritize a small pilot; defer the full matrix” after the
24–48-hour estimate. Run all six registered R5 methods on Zelechowska first,
report the result, and keep the rest deferred for review. No model, runtime,
manifest, schema, input or method setting changes.

## Scope and interpretation

Zelechowska is the cheapest development-gold Article with all six methods and no
span-pair refusals in tokenizer preflight. Its frozen upstream has two records,
78 enumerated claims and two source contexts. Schema policy excludes 36 claims.
The canonical document has 122 passages and **no structured tables/cells**.
This pilot therefore cannot validate table-cell grounding or the problematic
long-document context cases. Selection favors fast feedback, not a representative
sample or an independent evaluation set.

The six methods are quoted, spans, spans_unresolved, spans_policy,
spans_unresolved_policy and spans_routed. All-NONE preflight predicts 103 model
requests across them. At the observed 33 seconds per request and two workers,
that is about half an hour; allow roughly 30–60 minutes once slots become free.
Actual decisions, request size and provider contention can change that estimate.

Use the existing R5 cell directories and manifest. These are six of the original
90 cells, not six extra repetitions. Quoted and spans enter the first available
worker slots. This changes execution order and the collection prerequisite,
which must remain explicit in any later full-study report.

## Execution ownership

All paths below are relative to the primary artifact root
`/home/gennaro/projects/FREE/artifacts/extraction-ablation`.

- Control: `20260928-r5-grounding/pilot-zele-20260928/`.
- Service: `free-ablation-r5-pilot-zele-20260928`; initial PID 1900012,
  starttime 13016743. Revalidate live state before acting.
- Launcher SHA-256:
  `31731a51b5aaac1fb92116fad295114b898c1c01fd01de128dfd5348af82b2e0`.
- Config SHA-256:
  `45aec7c9d1cc11030a7f2fdaf1bce64a05ee66a1d487a1dc0c5b12e0cbf3262c`.
- Existing R4 supervisor 1614748/start10400811 is stopped with SIGSTOP;
  its two model workers were not interrupted. Each pilot slot waits for one
  exact worker identity to finish and checks its terminal receipt before use.
  Combined R4/pilot concurrency stays at most two.
- The idle full-R5 scheduler and collector v2 were stopped, downstream first.
  Original collector 1863874/start12578818 remains waiting on the held R4
  supervisor. The separately prepared uncertainty follower was never started.

`handoff.json`, `execution-plan.json` and `start-verification.json` pin the
authorization, processes and controls. Full frozen-input validation passed before
launch. The existing registered cell runner retains its 5 GiB admission gate,
model-time budget, captures, failure receipts and no-retry rule.

## Reporting and remaining gates

After six command outcomes, the pilot supervisor runs exact replay, original
reporting, the pinned uncertainty extension and corrected value analysis with
network/model calls disabled. Outputs live in the pilot control directory:
`verification.json`, `grounding-report.json`,
`grounding-report-uncertainty.json` and `analysis.json`.
The comparison guard checks that the uncertainty extension preserves every prior
report field. Its acceptance passed the saved pending-report pair and rejected
seven deliberately altered reports.

`collection-finished.json` must identify six exactly replayed terminal outcomes
and 84 pending cells. It is a report-generation receipt, not study completion.
Review per-method calls, tokens, time, refusals, linked claims and literal source
validity; inspect changed links against canonical text. A valid span ID is not
proof of entailment, and there are no independent semantic labels. One document
cannot support document-bootstrap intervals or generalization claims.

Keep R4 admission and the full R5 matrix deferred while presenting the pilot.
Do not restart the old R5 scheduler: it intentionally rejects existing cells.
Future resumption must audit the six retained outcomes, schedule only remaining
cells and rebuild the final collection dependency with the new scheduler identity.
Never rerun or discard the pilot to restore the old order. The original full-study
replay, complete matrix, final analysis and delivery gates remain open.

## Audit follow-up — 2026-09-28

The [model audit and mechanical recheck](../validation/2026-09-28-grounding-pilot-audit.md)
cover all changed evidence and establish differing replies to identical requests.
Use the new captured-request variation helper before attributing small link changes
to a factor. Five of six rejected quotes omitted U+000E; two became missing final
thermal-condition links. Earlier three-case accounting was incomplete.

Human semantic adjudication remains open. Both model passes prefer the observed
span proofs, but disagree on 26/69 record-attribution judgments. Do not treat the
model audit as human gold or proof of method equivalence. A next micro-pilot should
include real table cells and repeated identical controls; Harvey has one canonical
table with 48 cells. Pin selected claims and source units before any new generation.
The full matrix remains deferred; no new inference is scheduled here.

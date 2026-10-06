# Independent candidate review: PR 188

Date: 2026-10-06. Reviewer: independent Codex review agent, read-only.

**Final verdict: no merge-blocking implementation or required-acceptance
evidence finding remains for accepted runtime candidate `778d62f7`.
Compose, complete browser/recovery, live-provider, interactive operator and
focused manual acceptance passed; their actual artifacts were independently
inspected. The final documentation/archive record commit still has its own
CI and exact-head verification procedure before merge. No future result is
claimed as already executed.**

Runtime candidate first reviewed: `7f1b499d9fc58e9f98efd478d721d6cb452506e1`, which integrates
current `dev` (`935c2457`). Durable implementation is byte-for-byte the
`b6b3cbe2e8c755585db135050494400867dfb942` implementation already verified on
Baratheon. `70e56d23` adds its dated verification record and merge prerequisites;
the `70e56d23..7f1b499d` integration changes ten tracing/launcher/Compose/test/doc
files and no durable implementation. The final accepted candidate is
`778d62f77e32ce9eb1f9c663d53d564ef486ab95`; its additional one-file test-only
change is reviewed below.

The originating independent review is
`/tmp/free-pr185-opus55/opus-review-a7a0919b.md`; its adjacent JSON, including
the per-axis findings and gap findings, was read. The repair comparison is
`a7a0919b..7f1b499d` (71 changed paths), plus the one-file `778d62f7` follow-up.
Runtime, test and current-contract
changes belong to the requested repair; dated verification is supporting
evidence. At the initial review close there were no untracked checkout files and
only the root agent's two-line deployment wording correction. At final review
close the root agent is assembling the documentation/screenshots/OpenSpec
archive record. Those changes are identified as authored acceptance evidence
and contract links, not runtime source or reviewer edits; they were inspected
for truthful scope and counts.

## Correctness and verification

The prior review correctly identified several observable failures and missing
test boundaries. The fixes address those failures rather than adding fallback
paths. The following are **rejected as still-open defects** at this candidate:

| Original obligation | Current evidence and adjudication |
| --- | --- |
| A1 / SPEC-2 / COR-1 | `packages/extraction/src/postgres-admission.ts:98` includes `DURABLE_EXTRACTION_PROTOCOL` in the equal-selection identity. `postgres-batches.ts:82` omits batches without a live member. `durable-admission.postgres.check.ts:147` independently reconstructs and seeds the historical occupied hash, then proves native admission, order-independent replay and unchanged replay counts. This creates disjoint native identities; it does not read historical results. |
| A2 / COR-7 | `durable-repository.ts:161` passes the original schema tree to identity-field validation; `recordScope` remains only on the durable execution tree. `durable-control.postgres.check.ts:56` saves nonempty `identity_fields:['title']`, retains document scope and rejects a nonexistent field. |
| A3 / COR-3 | `useExtraction.ts:138` shares one terminal transition updater. `:240` no longer aborts monitoring on an unchanged reader status, and the workspace effect at `:210` observes active work independently of Results mounting. Reader transitions to idle abort their monitor; late responses fail its identity/signal checks. App cases cover collapsed rail, earlier finalized inspection, open latest Results and Review now selecting the latest attempt. |
| A4 / COR-4 | `App.tsx:772` guards Run with the controller's latest-attempt `canRun`; the enabled state at `:880` uses the same predicate. `useExtraction.ts:257` and `:276` refuse active/resumable latest attempts, including PAUSED and FAILED. Inspected historical state only controls inspection labels. The hook and App test each cover PAUSED/FAILED/PAUSING/STOPPING. Pending schema drafts can still be flushed before a new admission. |
| A5 / COR-5 | `RightRail.tsx:213` renders the error, Reconnect and original-request retry above the tab content even with prior results. `useExtraction.ts:281` retains the unanswered identity and serialized descriptor; changed requests cannot reserve a new identity. Reconnect only reads, while `:319` explicitly retries the retained descriptor. App regressions at `App.test.tsx:514` and `:552` change pages after uncertainty and verify the original ID and page are preserved. The admission callback reports uncertainty to the workspace toast. |
| A6 / STD-1 / COR-10 | `tests/helpers/postgres.py:125` invokes the Node-owned migration/bootstrap through captured stdin, using a guarded database and unique restricted worker role. `packages/db/src/parsing-coordination-fixture.ts:13` guards the target and runs the production migration and `ensureKeiRole`. Recovery and service workers receive that role URL; dependent clients stop before role cleanup. `test_worker_coordination.py` proves protocol readiness, denied application/head/internal-hash access, DBOS ownership and protocol mismatch refusal. No coordination boot stub was introduced. Actual Python tiers passed, as detailed below. |
| A7 / STD-2 / SPEC-1 / COR-2; optional COR-8 | `docs/operations/deployment.md:568` inventories deleted functions by name, operationally closes access, drains or stops all three writers before pinned-client cancellation, and requires zero ENQUEUED/DELAYED/PENDING invocations with writers stopped before replacement images start. Terminal cleanup is a separate explicit reviewed allowlist. The actual installed TypeScript 5.1.10 client declarations and Python 3.1.0 client signatures support the documented list/cancel/delete arguments. No workflow registration is needed for these one-off clients. |
| B admission regressions / SPEC-4 / COR-9 / STD-8 | `durable-admission.postgres.check.ts:68` checks reused IDs with changed methods, fresh stale-method refusals, owned cross-context refusal and unchanged counts. `:109` checks suggested enqueue rollback, schema/revision counts and both suggestion pointers. `:179` exercises source supersession while admission waits on a real document lock; `:192` exercises account Apply under that boundary and immutable single/batch replay afterward. |
| B occurrence ownership / SPEC-5 | `e2e/durable-extraction.spec.ts:61` reads two real anchors from the pinned source, submits one anchor with the other's occurrence, expects 422, and verifies no correction or control change. The API ownership guard is in `api/durable_extractions.ts:58`. The Project decision-version invariant is enforced by validating Evidence before repository mutation. |
| B GC / STD-G1 / STD-G2 | `durable-control.postgres.check.ts:227` deletes an actual owned graph, drives the production collector with a history boundary, retains pins for ENQUEUED/PENDING/DELAYED and false/throwing cleanup, checks queued cancellation and stale-fence refusal, then removes the current-fenced graph and pins. `garbage_acceptance.postgres.test.ts` and the real-process missed-ingestion-cancel scenario exercise cancellation repair after SIGKILL and subsequent history/payload cleanup. Orphan workflow routing and real kei payload checks are also restored. |
| B monitoring / STD-G3 | `useExtraction.test.tsx:186` drives the real hook/API boundary for acknowledged and uncertain admissions, replaces `initialAttempt` on the same document, observes the old signal abort and completes its old response. The replacement remains authoritative and no old terminal callback fires. |
| B producer Evidence / COR-G2 | `durable-contract.test.ts:21` parses every Evidence link from the Python-owned version-3 contract fixture through the durable producer schema. The retained-value validation still checks producing paths and anchors when opening results; the summary optimization does not weaken this result boundary. |
| B pinned schema / STD-G5 | `BatchExtractionsPanel.test.tsx:1733` fails the actual pinned-schema read, observes the error and disabled Run again, then uses Retry Schema Revision and verifies the recovered scope/controls. |
| B password-redaction / STD-11 / SPEC-13 | `test_worker_boot.py:239` targets both coordination and clock startup boundaries with plain and percent-encoded synthetic passwords, records double invocation and explicitly asserts it received the URL. The tests no longer pass without invoking the intended failure. |
| C completed totals / COR-6 | `project-store.ts:406` and `postgres-attempts.ts:104` derive completion from any COMPLETED attempt or current COMPLETED acknowledgement. `postgres-batches.ts:90` publishes that required member fact. PG tests cover Stop/adoption and stopped-member summaries, preserving extracted counts independently of current lifecycle/finalization. |
| C spent identity / STD-10 | `postgres-admission.ts:234` requires a nondeleted durable head before replay. An owned headless identity receives a definite conflict. The PG regression at `durable-admission.postgres.check.ts:171` verifies counts remain unchanged. |
| C invalid schema / STD-G4 | `api/_method_refusals.ts` maps `invalid_schema_revision` to 422; single and batch transport tests cover the definite refusal. |
| C summary contention / COR-G1 | `postgres-attempts.ts:64` loads finalizations once and groups exact current cuts by snapshot version, reading groups sequentially. It parses only summary processing/schema metadata. `postgres-batches.ts:72` bulk-loads schema/owner metadata. `durable-readers.postgres.check.ts:90` supplies two current versions and an invalid historical payload, proves only current cuts contribute and bounds summary pool checkouts to three. Complexity now depends on distinct current versions, without queuing per-member reads concurrently. |
| D1–D13 / associated STD and SPEC documentation aliases | README contract #4 describes revisioned corrections and explicit named-pair finalization. README method history, pipeline and timeout text match current runtime. `DurableResults.tsx:112` shows requested/effective models, options and protocol metadata per producing selection, with Not recorded before effective metadata exists. ADR 0017 supersedes disabled-admission clauses and agrees on COMPLETED-or-finalized counts. The undefined-column fallback is deleted. Deployment/onboarding/local-test-scope/proposal/comments are reconciled. Dead last-value implicit-finalization branches and props are removed. OpenSpec design/tasks and the PR require exact-source Spark acceptance before merge. |

No release flag, environment admission switch, disabled-admission response,
legacy result reader, historical identity upgrade, undefined-column fallback,
or deleted `extract` / `runExtraction` workflow stub is present in the inspected
runtime. Existing Catalog-method choices are a separate supported method
surface; they do not reintroduce historical Extraction execution/readers.

The current merge integration makes Phoenix part of the base topology and
removes the optional overlay. The base exporter settings apply to Studio and
the worker; the isolated system overlay replaces the dashboard publication
with an ephemeral loopback port. No service depends on collector readiness.
The root agent corrected one inherited upgrade-runbook sentence to mention GPU
and nginx overlays, since the tracing overlay no longer exists. No further
concrete integration defect was found.

## Design fundamentals

No additional material design finding remains in this repair surface. The
coordination head continues to own researcher-visible lifecycle; DBOS dispatch
and history cleanup retain explicit boundaries. The hook owns the latest
workspace observer and unanswered admission identity; the Results reader
shares terminal updates without taking exclusive ownership. Original retry
preserves historical intent rather than rebuilding it from current controls.
Corrections and finalizations remain independent of processing state and are
guarded at durable repository boundaries. Producing-method display reads
selection-owned history. Summary readers now concentrate current-cut knowledge
without requiring callers to manage pool concurrency.

The original section E lists optional low-priority terminology, duplication and
scaffolding observations. The user requested A–D; those optional observations
are not claimed as repaired or promoted to merge blockers without an observable
defect. The original REFUTED findings were not revived.

## Scope, commands and evidence

Read repository README, CONTEXT, CONTRIBUTING, Studio CLAUDE, Parsing README and
CLAUDE, the applicable ADRs, synchronized canonical Evidence/admission specs,
active OpenSpec design/tasks, originating Markdown/JSON, production call paths,
focused regressions and dated candidate verification. Compared the repair and
current-dev integration diffs, enumerated tracked/untracked changes and ran
`git diff --check` (passed).

Existing local Baratheon logs were read, not inferred from a green CI job:

- `python-postgres.log`: 45 passed, 18 fixture-dependent skips. The native
  lifecycle/recovery wrappers subsequently execute all 13 lifecycle and 5
  process-recovery cases; both wrapper checks passed without skips.
- `python-recovery.log`: 5 passed, no skips.
- `python-service.log`: 1 passed, no skips.
- `node-postgres-final.log`: db 57, extraction 15 and Studio 63 passed.
- `studio-unit-final.log`: 1,947 passed in 174 files.
- `browser-durable-final.log`: 18 passed.
- `browser-service.log`: 13 passed, with two real-provider and one private
  scanned-PDF cases conditional/skipped at that older implementation run.
- `safety-final.log`: 29 passed; typecheck/lint logs complete successfully.

These original logs accept implementation `b6b3cbe2`, not the new tracing
integration's entire infrastructure surface. The reviewer independently read
the merged `7f1b499d` launcher and safety log tails over SSH: 49 and 29 passed
respectively, with no failures/skips. The reviewer read the current system
report, complete outcome tail, recorded exit 0 and HEAD, source-diff marker,
image hash comparison and teardown JSON at
`repo/artifacts/review-merge-acceptance/system/7f1b499d/`. Full unmodified
Compose passed 15/15 without skips. Image source checks covered 721
Studio/workspace and 93 Parsing source files in each API/worker image against
the candidate, finding no mismatch. Teardown left no owned containers, volumes
or networks. These current artifacts accept the tracing integration and real
Compose path. The browser/recovery and real-provider/manual checks were
subsequently independently inspected as detailed below.

Reviewer attempted `node --test scripts/free.test.mjs` locally. It stopped at
workspace-package resolution (`studio-configuration` missing), because this
disposable checkout's generated dependencies were removed after the prior quota
failure. This is an environmental/harness failure before test execution, not a
candidate behavioral failure. No baseline behavioral failure is claimed; a
detached baseline rerun would have the same missing-package limitation. No
additional PostgreSQL or browser mutation was initiated by this read-only
review; the parallel acceptance agents own those fresh runs.

The installed pinned SDK API shapes were inspected over read-only SSH on
Baratheon: TypeScript client.d.ts exposes `create`, `listWorkflows`,
`cancelWorkflow` and `deleteWorkflows`; workflow.d.ts accepts status arrays.
Python introspection confirms `list_workflows(name=..., status=..., load_input=...,
load_output=...)`, `cancel_workflow(id)` and
`delete_workflows(ids, delete_children=False)`.

## Review boundary and read-only confirmation

No unresolved A–D code finding was found. The later acceptance sections below
inspect the completed e2e/manual/live outcomes and preserve the remaining
conditional private-fixture skip explicitly. Production deployment remains
separate from PR merge.

This reviewer changed no source, tests, docs or generated files in the checkout.
The report is outside it. The initial source verdict was pinned to `7f1b499d`;
the final test-only follow-up and authored record changes are covered below.
`git diff --check` passes.

## Candidate addendum: `778d62f7`

Additional reviewed commit:
`778d62f77e32ce9eb1f9c663d53d564ef486ab95`.
The entire `7f1b499d..778d62f7` delta changes only
`prototypes/studio/e2e/schema-order-lifecycle.spec.ts`: it imports the existing
`e2eStudioPath` helper and wraps all seven direct request/navigation URLs.
`e2e/auth.ts:19` leaves paths unchanged for the root harness and prefixes them
with `/free` for the base-path harness configured in
`playwright.base-path.config.ts`. The existing wildcard artifact route fixtures
continue matching both forms. No product code, fixture state, assertion or
tested behavior changed. The original first GET failure in the `/free` run was
therefore a concrete harness-path defect, and this is the smallest correction.
No additional implementation finding was identified. `git diff --check` passes;
the root agent's already reviewed two-line deployment Markdown correction
remains the only uncommitted checkout diff.

The reviewer independently read the actual Playwright JSON reports and matrix
summary at `/tmp/free-pr185-opus55/merge-acceptance/browser/`:

| Tier | Source | Expected passes | Skips | Unexpected / flaky / report errors |
| --- | --- | ---: | ---: | --- |
| Standard | `7f1b499d` | 71 | 4 | 0 / 0 / 0 |
| Unified opt-in | `7f1b499d` | 3 | 0 | 0 / 0 / 0 |
| Recovery | `7f1b499d` | 5 | 0 | 0 / 0 / 0 |
| Durable | `7f1b499d` | 18 | 0 | 0 / 0 / 0 |
| Base path | `778d62f7` | 1 | 0 | 0 / 0 / 0 |
| Affected standard schema lifecycle | `778d62f7` | 1 | 0 | 0 / 0 / 0 |

Three standard skips are the unified opt-in cases subsequently executed above.
The fourth needs the optional private scanned-PDF and OCR-model inputs and
remains explicitly conditional. The earlier concurrent-network bootstrap
failures did not recur in the full final serialized matrix; they are
environmental/harness failures, not weakened assertions. The base-path failure
was the concrete test-path defect fixed by `778d62f7`, whose root and `/free`
runs both now pass. These outcomes complete the browser/recovery acceptance of
the unchanged runtime. Real-provider and manual acceptance was subsequently
inspected as detailed below.

## Live-provider and operator acceptance: `778d62f7`

Independently inspected
`/tmp/free-pr185-opus55/verification/live-manual/live-provider-final.log`:
the real Article and Unified cases passed, 2/2, without skips, in 36.8 seconds.
The test source at `e2e/durable-service.spec.ts:299` requires the explicitly
selected live reasoning endpoint; Unified also requires the native fields
endpoint. It inspects durable retained requests, requires saved output digests,
checks the real configured reasoning model, and checks native GLiFormer
protocol 1 for Unified. It then opens actual Results and verifies export
retains the exact captures. The current configured model is
`nvidia/Qwen3.8-27B-NVFP4`; the native fields server is separate from the
reasoning endpoint. This is real-provider acceptance, without a scripted
model response.

The operator record and event log are a separate fresh interactive browser
session on exact `778d62f7`. The recorded actions pass through OIDC, create
a Project, upload/convert a native PDF, create/edit and explicitly choose the
document schema scope, choose Qwen for both roles in Model Configuration,
apply the choices and click Run in the actual UI. It records a completed
Extraction with two real captures and producer Evidence anchor `a_p1_s0`
on page 1. The operator selects that saved value, types an EDITED correction
without correction Evidence, checks that no finalization was implicit, then
explicitly finalizes results 3 · decisions 1. Reload and CSV export preserve
the correction and named finalization. The reviewer compared the export's
capture array to `article-history-before.json` and found exact equality.
The correction candidate is explicitly ungrounded; original grounded model
Evidence remains separate. The operator outcome records zero browser page
errors.

The reviewer visually inspected `07-article-finalized-correction-reloaded.png`,
`06-article-method-history-after-reload.png` and the final Unified retained
Results screenshot. These support finalized-pair persistence, corrected/model
value separation, producing-method display using actual Qwen choices, and
visible ungrounded Unified values. The evidence does not claim recall or
accuracy for a live model.

The event log preserves exploratory locator/interaction failures: the empty
Project page uses a different create label, Apply retains Model Configuration
until explicitly closed, the Run label includes its glyph, and a saved edited
row leaves the To check filter. Each was resolved through the actual current
UI, with no source or assertion weakening. The observer also attached after
the completion toast's eight-second lifetime and could not see that toast;
the outcome explicitly does not count this as a passed toast observation.
That behavior was then checked by the separate focused manual scenarios below,
with the observer attached before completion. Both completion/Review now
scenarios passed and their action records were independently inspected.

## Focused interactive manual scenarios: `778d62f7`

Independently inspected `report.json`, `actions.jsonl`,
`browser-errors.jsonl`, `runner-final.log` and `cleanup.json` under
`repo/artifacts/review-merge-acceptance/studio-manual/`.
All five scenarios passed in 52.5 seconds: expected 5, skipped 0, unexpected
0, flaky 0 and report errors 0. The scenarios exercise the real browser and
current app against owned deterministic producer fixtures; the method-history
fixture explicitly labels its provenance and makes no live-model claim.

- Collapsing Results during active work still produces the completion toast;
  Review now opens the latest completed Results and Run becomes enabled.
- Inspecting an earlier finalized pair during later work preserves that pair,
  still observes completion and switches to the latest when Review now is used.
- QUEUED, RUNNING, PAUSING, PAUSED, FAILED and STOPPING latest states each
  disable Run while an older pair is inspected.
- POST 502 followed by status GET 404 retains the original identity, shows
  the alert beside earlier results and keeps Run disabled. Changing to page
  2 and Reconnect keeps one POST and two reads of the same identity. Explicit
  Retry original request then replays the identical full body/ID/startPage 1
  and reaches an actual accepted admission.
- Requested/effective producing-method details render and an earlier named
  finalized pair remains selectable after a newer snapshot. The displayed
  pair and newer-snapshot notice agree with the route's immutable versions.

The three browser console entries are the deliberately injected 502 and two
404 responses from the uncertainty case, rather than unexpected page errors.
Normal teardown removes the owned project containers/volume/network and the
private state/inbox directories. The root reviewer identified that the first
narrow PNG was captured during sidebar motion. The last scenario was rerun
after waiting for the closed sidebar's retained border and disabling capture
animation: `runner-narrow-final.log` records 1 passed in 16.2 seconds. The
reviewer visually inspected `settled-finalization-375px.png`: the entire rail
is readable, shows selected results 1 · decisions 1 and its finalization,
announces newer results 2, retains the approved earlier value, and provides
the explicit newer-cut action. The screenshot correction changes only
capture readiness, not product behavior.

## Final record inspection and merge procedure

The draft `docs/validation/2026-10-06-pr188-merge-acceptance.md` was independently
read against the inspected logs, JSON, source mapping and screenshots. Its
15/49/29/71/3/5/18/1/1/2/5/1 counts and conditional-skip explanation match
the actual outcomes. Typecheck completion and lint output at `778d62f7`
were additionally read over SSH. The root's archived task text retains the
final-record CI and exact-head requirement; current README/ADR links point
to the actual archive path. The completed tests use `7f1b499d` runtime and
the `778d62f7` test correction transparently; the draft does not claim later
record-head checks have already passed.

**Accepted: `778d62f77e32ce9eb1f9c663d53d564ef486ab95`, with no remaining
implementation or inspected-evidence blocker.** The next commit contains
documentation, selected synthetic-source screenshots and archive metadata;
its exact SHA is not yet known in this review. Follow the recorded final-head
CI and literal Compose/browser/live/manual rerun procedure before merging.
Do not transfer this approval to a subsequent runtime-source change without
reviewing that delta. At final review close the checkout edits are exclusively
the root agent's identified documentation/evidence/archive work. This reviewer
left all of them intact and `git diff --check` still passes.

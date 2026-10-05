# Durable Extraction and results-review integration verification

Date: 2026-10-04; updated 2026-10-05. Status: implemented candidate; complete guarded Spark matrix passed; independent Standards/Spec code and evidence reviews complete.
Worktree: `/tmp/free-durable-extraction-implementation`.
Branch: `feat/durable-interactive-extraction`. Admission remains hard OFF.
Origin: [issue 169](https://github.com/HUM-CDCH/FREE/issues/169).

The complete results-review stack through [PR 183](https://github.com/HUM-CDCH/FREE/pull/183),
head `2cacd73aa793accb7e18ecfa60942c4bcbd405c8`, is reconciled. ADR 0016 and
its shared ResultsHeader, ReviewList, ReviewRow and ReviewFocus remain in use.
The durable feature owns its native control, result and correction authority.
The initial integration was `09976f24`; follow-up fixes are `13cdb971`, with
the real queued-Pause capacity check in `17a8817b`. Keyboard Undo/edit cancellation
was corrected in `d93ce2da`. The newer PR 183 fixes were cherry-picked through
`61fa60f8`; native wiring is `38e8a45d`, and the final loading/keyboard follow-up
is `e2944e98`. This feature has not been merged.

PR 183 advanced again during verification. Its final three fixes are imported
as `f86e10ef`, `854a13eb` and `7414e840`. They preserve document-mark DOM focus,
separate explicit document navigation from repainting, exclude whole-page
locations from precise marks, restore unlinked value selections, and keep
status/icons together at narrow widths. Native wiring preserves stable IDs,
chosen correction occurrences and pinned Markdown. `c5b9e3d9` applies the same
navigation intent to native One by one: unchanged callbacks/polls do not scroll,
and a mark-origin selection does not initiate another document navigation.
`969ba923` waits for the matching pinned source before following Model Evidence,
so entering One by one before that source loads cannot lose the navigation.

The newer stack includes running-draft recovery across navigation/reconnect,
uncertain admission, fast settlement, drawer-target reveal, and focus/list-scroll
preservation. Native correction reads remain owned by the durable actor; the
original running-draft machinery does not load or save native corrections.
Shared Article labels, whole-field typed editing and honest retained Evidence
captions are preserved. The nonmerge test-helper fix `0ab3cefb` was already
present and produced an empty cherry-pick; deleted historical compatibility
tests were not restored.

The third agent's risk report in `/tmp/free-durable-review-integration-risk.md`
is a checklist based on an older source cutoff, not a current failure report
or an acceptance result. Its dashboard requires a private access link; this
session has not read or changed saved dashboard decisions. F1/V03 are superseded
by the user's removal of introduced historical compatibility. The following
records this candidate's implementation reconciliation and acceptance evidence
without changing the private dashboard's saved decisions.

## Risk reconciliation

| Risk | Current candidate | Executed acceptance |
| --- | --- | --- |
| F2: controller authority | Native head updates the shared controller, status and review progress; same-source explicit Extraction navigation resets scope and fences old reads. | Passed: V02/V09, native four-method and shared restart browser. |
| F3: stable typed value identity | Decisions name stable whole-field IDs and immutable producing types. A stale whole-object write conflicts; reload preserves the draft and shows saved/draft comparison before explicit recomposition. Undo restores the previous compatible decision with its revision guard; Mark pending is separate. | Passed: V09–V11 typed/history/concurrency fixtures. The editor acts on complete objects/arrays; no typed child editing is advertised. |
| F4: retained batches | Paused, failed and stopped members open in the shared rail and export. Summary counts use actual native states. Direct grid URLs open members while durable typed grid decisions are unsupported. | Passed: V19 all retained states and mixed/empty batch downloads. |
| F5: active editing | Change inputs waits for the existing editing command's acknowledgement. Every active-input draft mutation fences a pending Resume. Schema-tab inspection does not pause work. Apply/Discard precedes Resume. | Passed: V06 PostgreSQL barriers, native pending-Resume cancellation and active-input browser. |
| F6: Evidence | Actual producer metadata remains attached. Model and correction links are distinct. Correction Evidence records explicitly selected occurrences in the pinned source. Composite links do not verify the whole value. | Passed: V16 PDF/Markdown/shared-occurrence/delayed-source browser. |
| F7: shared review | Retained rows use the redesigned list/focus/header, typed editor and responsive rail. Shortcuts are visible-rail scoped, reject repeats and preserve heading focus. | Passed: V14/V17 retained rail and standard shared-review browser. |
| F8: async scope | Command acknowledgements, snapshot reads, value reads and guidance requests have independent generation/lifetime guards. Open drafts remain fixed through polls; comparison after conflict is explicit. | Passed: V09 delayed acknowledgement and whole-value conflict browser; independent generation unit checks. |
| F9: named versions | Finalization names both result and feedback versions. Historical links open that exact pair. Exports fix result/review cuts and label attached operational history as all-at-export-time with per-member observations. Call history exposes exact captured guidance, budget omissions and requests. | Passed: V15/V18/V19 fixed cuts, history links and CSV/XLSX downloads. |
| F10: release evidence | Static, unit, safety, guarded database/recovery and deterministic native-worker checks exist. Spark execution passed; complete Standards/Spec implementation and evidence audits found no remaining material finding. | Passed independent final evidence review on 2026-10-05; admission enablement remains unauthorized. |

## Classified local evidence

All database checks use task-owned disposable PostgreSQL and guarded `free_test_*`
targets. Worker fixtures create temporary restricted roles, source directories,
processes and deterministic HTTP providers, then clean them up. Browser fixtures
use their own OIDC, PostgreSQL, ports, canonical store, inbox and Chromium profile.
No runtime database is a test target.

### Latest PR reconciliation checks

On `38e8a45d`, the complete Studio unit tier passed **2,204 tests** in 181
files, and all **eight authenticated browser cases passed together** in 1.7
minutes. Logs: `/tmp/free-durable-pr183-latest-full-unit.log` and
`/tmp/free-durable-pr183-latest-browser.log`. Focused integration checks passed
220 tests. Studio and extraction typechecks passed; changed-file ESLint had no
errors and one existing controller hook warning.

Independent Spec review found no new issue in that reconciliation. Standards
review found a pending completed-review read could leave a different running
Extraction's `reviewLoading` set. It also identified a carried native keyboard
gap: a menu or details view did not suspend underlying review shortcuts.
`e2944e98` resets loading at its owning scope boundary and uses the shared
`keyAction` priorities for native review. Both independent reviewers confirmed
these findings resolved and reported no new issue in the bounded follow-up.

The earlier production source boundary `e2944e98` passed **2,208 Studio tests**
in 181 files and **29 safety tests**; 97 focused keyboard/editor/controller
checks passed. Studio typechecking passed; changed-file ESLint has no errors
and the same existing hook warning. Logs:
`/tmp/free-durable-pr183-final-full-unit.log`,
`/tmp/free-durable-pr183-final-safety.log`,
`/tmp/free-durable-pr183-final-keyboard-unit.log`,
`/tmp/free-durable-pr183-final-type.log`, and
`/tmp/free-durable-pr183-final-lint.log`.

`09aad14c` adds browser coverage without changing production source: correction
save/reload in every lifecycle state, real menu/details keyboard ownership,
shared correction Evidence over a non-ASCII Markdown byte span, stable value
links, and measured 344px/264px/mobile geometry. Its execution evidence is
recorded after the run below. These checks still use the private local stack;
they do not substitute for Spark acceptance.

The ten-case attempt at `09aad14c` passed six and failed four
(`/tmp/free-durable-pr183-final-browser.log`). Stopped-batch and rail-width
cases encountered observed module `ERR_NETWORK_CHANGED` errors. The lifecycle
reload assertion searched only the default To check filter after the value was
edited; it now explicitly selects All and checks the Edited row. The Markdown
fixture changed an anchor's byte span without changing its owning content block,
so canonical validation correctly refused the artifact. `ae9a06a3` keeps block
and anchor spans aligned and validates the fixture before publication. No
production behavior was changed to satisfy either fixture. These are classified
failed attempts, not passing acceptance evidence.

The corrected four-case rerun at `ae9a06a3` passed the expanded eight-state
save/reload case and measured rail geometry (38.6 s and 9.1 s). Stopped-batch
bootstrap and the Markdown case's final value-link reload encountered observed
module network-change failures. The Markdown span, shared-anchor popover and
selection assertions had passed before that reload failure. Log:
`/tmp/free-durable-pr183-final-browser-recheck.log`.

`27a394cc` keeps the shared Escape priority active during a pending correction
save while decision keys remain suspended. Its focused 18 checks passed;
typecheck/lint passed. The isolated stopped-batch, delayed-acknowledgement and
complete Markdown cases all passed together (three cases, 41.2 s) in
`/tmp/free-durable-pr183-final-isolated-browser.log`. Delayed acknowledgement
checks one POST/revision, heading focus, no automatic finalization and no control
command. Screenshots from the rail-width case were inspected: editing controls
and lifecycle actions fit at 264px and mobile widths.

After the last three PR fixes, focused component/controller/document checks
passed 247 tests (`/tmp/free-durable-pr183-mark-focused.log`). Studio typecheck
and changed-file ESLint passed with no errors or warnings
(`/tmp/free-durable-pr183-mark-type.log`,
`/tmp/free-durable-pr183-mark-lint.log`). The native regression checks one
explicit navigation, no navigation on callback replacement, no navigation from
a mark, selectable stable value IDs, and whole-page precision forwarded for an
explicit Model Evidence action. Final source boundary: `c5b9e3d9`.

### Earlier supporting checks and classified failures

| Check | Observation | Log |
| --- | --- | --- |
| Full Studio unit suite | 2,171 passed with four workers | `/tmp/free-durable-review-fixes-full-unit.log` |
| Focused scope/editor/guidance/history/actor tests | 76 passed; subsequent keyboard/focus tests 14 passed | `/tmp/free-durable-review-fixes-focused5.log`, `/tmp/free-durable-review-keyboard-unit.log` |
| Studio / Extraction typechecking | Passed | `/tmp/free-durable-review-fixes-type5.log`, `/tmp/free-durable-review-fixes-extraction-type.log` |
| Changed Studio ESLint | No errors; two existing useExtraction hook warnings | `/tmp/free-durable-review-fixes-lint2.log` |
| Safety tier | 29 passed | `/tmp/free-durable-review-fixes-safety.log` |
| Restricted routines / control / correction / fixed paging / deletion | Passed | `/tmp/free-durable-queued-lane-pg.log`, `/tmp/free-durable-native-db-boundaries.log` |
| Real DBOS native lifecycle | 13 passed: three scenarios for each of Article/generic/recipe/unified, plus queued Pause and lane release | `/tmp/free-durable-native-extraction-boundaries.log` |
| Eight authenticated browser cases | Six passed together; concurrency/Undo/historical links and paused-batch cases passed in targeted reruns | `/tmp/free-durable-review-fixes-browser.log`, `/tmp/free-durable-review-fixes-browser-recheck.log`, `/tmp/free-durable-review-fixes-paused-browser.log` |

The full browser attempt is not an eight-case green run. Its paused-batch case
failed on observed `ERR_NETWORK_CHANGED` module requests. Its new concurrency
case failed before reaching the behavior because the fixture helper requires a
`title` field; that fixture is corrected. The two-case rerun passed concurrency,
including real whole-object conflict, explicit recomposition, previous-decision
Undo, separate Mark pending and exact historical-link navigation; paused-batch
again encountered observed module network-change errors. The isolated paused
rerun passed in 21.8 seconds. The earlier failures remain classified failures.

An initially misrouted test command ran the full unit suite at default parallelism:
five unrelated workflow/PDF deadline checks failed, and a new test had a wrong
button label. The corrected focused tests pass; the bounded full rerun passed
all 2,171 tests in 94.34 seconds. No failed attempt is relabeled a pass.

The eight-state browser case exercises navigation between Extractions on the
same Source Document. It previously exposed a real Pausing/Paused scope defect,
now covered by hook and browser regressions. Browser-seeded active heads prove
UI behavior, not drain or process recovery: that test stack has no Parsing DBOS
tables, so its reconciler fails closed. The native-worker fixtures supply the
actual execution proof.

The queued-Pause fixture fills both real attempt slots with disposable native
steps, enqueues the paused Extraction, accepts Pause while it is still queued,
and releases only one occupied slot. The paused attempt returns successfully
with zero captures and saved PAUSED. A different Extraction then completes while
the other occupied slot remains PENDING. Resume retains the first visible ID.
This proves slot release without a parent workflow waiting on paused work.

## Spark verification and release evidence

The PR 183 completion report identifies final head `2cacd73a`, completed Spark
checks, and the other agent's merge `1e852811`. That report satisfied the user's
instruction to wait. Only then did this session provision its private checkout
and guarded test resources. The feature branch itself remains unmerged.

### Tested cuts and isolation

- Spark: `baratheon`, Ubuntu/aarch64, Node 24.21.0, pnpm 12.8.1, locked Python
  3.13 environment. No SDK/lockfile update was made for verification.
- Private checkout: `/home/geba/Projects/FREE-durable-extraction-verification`.
  Private logs/artifacts: `/home/geba/Projects/FREE-durable-extraction-verification-artifacts`.
  No other session's checkout, containers, volumes, ports or databases were changed.
- PostgreSQL: task-owned `free-durable-test-spark-pg-91bc1690`, `postgres:17`,
  host loopback 45440. Node and its child worker fixtures share this container's
  network namespace; their guarded target remains loopback:5432 and `free_test_*`.
  Every database fixture provisions and drops its own suffixed database/roles.
  The host's unrelated verification PostgreSQL on 5432 was never a target.
- Each browser tier provisions its own PostgreSQL/mock OIDC stack with a
  `free-durable-test-spark-*` Compose project and lifecycle port leases. Retained
  review uses application 41789/OIDC 41788/PostgreSQL 45439; service uses
  41761/41762/45435; standard uses 41749/41748/45432; recovery uses
  41771/41772/45436. The service database guard also requires user `free_e2e`,
  database `free_test_real_service` and its configured explicit loopback port.
  App state, inbox, worker runs, browser profile and artifacts are private.
- Chromium is task-owned under the artifact directory (`browser`, build 1234).
  Parsing process fixtures use the ARM64 image `free-parsing_worker:latest`,
  SHA `4fc271a2fda83d8fc8297a4ffd4628223f41bb5db929b815225433534d856728`.
- Existing Qwen and GLiFormer servers were used only as stateless inference
  endpoints for the explicitly selected live subset. No model server was
  restarted or reconfigured and no runtime database was accessed.
- All browser stacks removed their own containers/volumes on teardown. After
  the final checks, the owned PostgreSQL container and its exclusively attached
  volume were removed after checking its owner label and mount identity
  (`cleanup-final.log`). No task test container remains; the private checkout
  and logs/artifacts remain available for review.
- Latest production changes: TypeScript/UI `969ba923`; Python `7dffc780` fixes
  explicit Article settings serialization. `6801a88c` and `a69772e2` distinguish
  required reply floors from spare capacity for guidance, and `cbc1d751` keeps
  the actual tokenizer identity under a bounded context ceiling. `f91a3e22`
  removes the last two native source-identity fallbacks. The broad Node
  checks at `12f4137c` and shared UI checks at `08660250` test unchanged production
  blobs. Affected Python/worker/database tests are rerun at `7dffc780`.

### Observed Spark checks

Log names below are relative to the private artifact directory above.

| Check / tested cut | Observed result | Evidence |
| --- | --- | --- |
| Root typecheck and full Studio ESLint / `4d15349d` | Passed; zero lint errors, one existing exhaustive-deps warning in `useExtraction` | `typecheck-final.log`, `lint-final.log` |
| Final root typecheck and Studio ESLint / `7dffc780` | Passed; zero errors, the same existing exhaustive-deps warning | `typecheck-guidance-final.log`, `lint-guidance-final.log` |
| Node unit tiers / `12f4137c` | All packages and script suites passed; Studio 2,220 tests / 181 files | `studio-unit.log`, `node-scripts-unit.log`, package `*-unit.log` |
| Safety / `12f4137c` | 29 passed | `safety.log` |
| Database PostgreSQL / `12f4137c` | 56 passed | `db-postgres.log`, `postgres-results.json` |
| Studio PostgreSQL / `12f4137c` | 68 passed / 12 files | `studio-postgres.log` |
| Extraction PostgreSQL / `4d15349d` | 113 passed; includes 13 real DBOS lifecycle cases and five real SIGKILL recovery boundaries | `extraction-postgres-final.log`, `postgres-final-results.json` |
| Affected Extraction PostgreSQL / `7dffc780` | 113 passed again, 90.35 seconds; all 13 native lifecycle and five SIGKILL boundaries rerun against current source | `extraction-postgres-guidance-final.log`, `postgres-guidance-final-results.json` |
| Python unit / `4d15349d` | 1,440 passed; 72 optional-source skips, 97 marker deselections | `python-unit-final.log` with skip reasons |
| Affected Python unit / `7dffc780` | 1,446 passed; same 72 optional-source skips and 97 marker deselections, 23.81 seconds | `python-unit-guidance-final.log` |
| Article guidance/serialization regressions / `7dffc780` | 24 passed, 1.92 seconds; real stages/root composition, whole-example budget omission, bounded reply floor and immutable effective settings restored after registry changes | `python-guidance-targeted-final.log` |
| Python PostgreSQL / `12f4137c` | 56 passed; 18 separately owned native/recovery skips, 1,535 deselections | `python-matrix.log`; the 13+5 native cases pass in their Node-owned tier |
| Python service/worker recovery / `12f4137c` | Seven passed | `python-matrix.log` |
| Standard authenticated browser / `08660250` | 77 passed; five conditional skips | `default-browser-standard.log`, `default-browser-standard-08660250/` |
| Opt-in unified preferences / `08660250` | Three passed | `unified-preferences-browser.log` |
| Studio restart browser / `08660250` | Five passed, including actual process death/recovery | `recovery-browser.log`, `recovery-browser-08660250/` |
| Complete real-service browser / `08660250` | 22 passed; five conditional skips | `service-matrix.log`, `service-final-08660250/` |
| Native worker controls/deletion browser / `4d15349d` | Five passed; two live-provider cases deferred to their separate run | `native-worker-browser-final.log`, `native-worker-final-4d15349d/` |
| Final native worker/guidance/deletion browser / `7dffc780` | Seven passed together, 1.8 minutes; full and bounded explicit Article settings join an ungrounded UI correction to a later actual provider request; two live cases run separately | `native-guidance-browser-final.log`, `native-guidance-final-7dffc780/` |
| Native live providers / `4d15349d` | Two passed, 36.8 seconds; Article Qwen and unified Qwen + GLiFormer; actual captures/output digests and downloaded history checked | `native-live-provider-browser.log`, `native-live-final-4d15349d/` |
| Final native live providers / `7dffc780` | Two passed again, 36.9 seconds; actual provider identities, saved output and immutable downloaded capture history | `native-live-provider-guidance-final.log`, `native-live-final-7dffc780/` |
| GLiFormer live protocol / `12f4137c` | Two passed against the available real server | `gliformer-live-host.log` |
| Retained rail / `3582ade4` and `4d15349d` | All original 13 cases passed together at both cuts; the expanded security case is recorded separately below | `durable-browser-final.log`, `durable-browser-security-final.log` |
| Expanded all-route access / `1788fcbb` | One passed, 10.0 seconds; fresh connections for refused POST bodies | `api-access-browser-final.log` |
| Final retained rail including access / `1788fcbb` | 14 passed together, 1.3 minutes | `durable-browser-all-final.log` |

The four native control journeys exercise real PDF ingestion, the restricted
worker, a counted held provider call, UI Pause/Pausing, durable drain to Paused,
UI Resume of the same visible Extraction, unchanged captured requests, completed
saved values, manual correction, reload and CSV preservation. The fifth deletes
an owned project while its actual call is held; the tombstone fences publication,
no result is resurrected, and another project's shared source remains readable
through a GC sweep. Browser-seeded lifecycle heads prove presentation and review
only; they are never substituted for these native-worker or recovery proofs.

The two joined guidance journeys save a whole-array correction in Extraction A
through the authenticated UI without linking Evidence, then start B on a
different source in the same Project using A's immutable Schema Revision. B's
capture names the exact correction/revision and original source/record/model
value. The counted provider's actual HTTP body equals the finalized captured
body, with the correction in system guidance and only target facts in the user
source. Excluding that guidance while B's call is held creates a new revision;
the started call and its downloaded history remain unchanged, later captures
omit it, and A's correction remains saved. Both explicit full and bounded
Article settings complete. Their diagnostic JSON, export snapshot and screenshot
are retained in the final native archive.

Article protects its existing required reply allowance before selecting
examples: 4,096 for full context; for bounded roots, at least the original
source-bearing request's count. After whole examples fit, the reply may use
remaining capacity. Tests distinguish these floors near half context, preserve
the complete source, record oversized examples as budget omissions, and replay
the identical finalized input after guidance changes.

### Combined risk matrix

These are this candidate's evidence dispositions for the third agent's stable
V01–V22 IDs; they do not mutate the private dashboard's saved decisions. V03 is
superseded by the user's compatibility removal, not passed. Low-level barriers
are owned by guarded PostgreSQL/real-worker checks, while browser tests prove
normal authenticated UI/API wiring. The independent Spec reviewer explicitly
accepted that division for V04–V07.

| ID | Concrete coverage and disposition |
| --- | --- |
| V01 | Fresh schema, routine readiness, exact kei grants, denied table/internal access, stale fences, restart persistence: database + Extraction PostgreSQL and native recovery passed. |
| V02 | All eight statuses, independent corrections/reload/finalization; no native fallback; environment cannot bypass hard OFF: retained browser, Studio unit/safety passed. |
| V04 | Queued Pause makes zero calls, acknowledges Paused and releases an actual occupied lane; same-ID Resume: 13th native lifecycle fixture passed. |
| V05 | Each method drains concurrent admitted calls; Stop terminal and successful work retained: 12 native method cases, four real-worker browser journeys and retained Stop/export passed. |
| V06 | Repeated/stale control CAS, terminal races and completion-proof precedence; later editing cancels pending Resume; Apply/Discard before Resume; Schema inspection does not pause: PostgreSQL, native lifecycle and active-input browser passed. |
| V07 | Failed sibling preservation, exact unchanged-input Retry, five process-death boundaries and current-attempt completion proof: Extraction PostgreSQL/recovery passed; reload/retained failure browser passed. |
| V08 | Saved provisional/ungrounded review in all statuses, optional own-source Evidence, no authority for candidate rows: eight-state/typed/optional-Evidence browser and publisher/contract checks passed. |
| V09 | Two-session whole-object conflict, retained draft, explicit recomposition, previous-decision Undo; delayed acknowledgement/source reads and lifetime/generation fences: browser and controller checks passed. |
| V10 | Immutable producing selections/schema/types, pending adoption, historical corrections, rename/removal/retype and selected reprocess lineage: PostgreSQL, Python planner, typed browser/history/export passed. |
| V11 | Source-bound record identity, reordered presentation, fixed primary coverage versus overlap, historical contributions and explicit scalar proposals: planner/retained unit + PostgreSQL, off-page/historical browser passed. |
| V12 | Passed: full/bounded real-worker browser journeys join compatible ungrounded UI correction A to B's actual provider body, exact candidate/revision/source attribution, exclusion during a held call, later omissions and immutable history/export. PostgreSQL separately owns capture/correction locking and target/project compatibility; composer/replay checks own unchanged-selection reuse and budget omissions. |
| V13 | Recorded budget omissions, exact provider requests, all four methods, format fallback and actual native fields provider: native fixtures, composer/adapter checks and two live-provider browser journeys passed. |
| V14 | Shared list/focus/header, stable parent typed values, filters, keyboard ownership, undo and separate Mark pending; existing shared bulk review retained: native rail + standard redesign browser/unit passed. No typed child editing or native grid bulk decision is advertised. |
| V15 | Explicit fixed result/feedback finalization, lag, historical links, new work independent, no poll/export/last-decision finalization: PostgreSQL and retained browser passed. |
| V16 | Pinned PDF/Markdown, model versus correction Evidence, exact occurrences, honest precision, shared anchors, UTF-8, off-page IDs and delayed source navigation: producer/projection checks and browser passed. |
| V17 | Measured 344px/264px/narrow rail, editing/menu/status/focus, initial error visibility: retained and standard browser passed; Spark 264px editor screenshot visually inspected. |
| V18 | Typed JSON/CSV/XLSX, partial/failed/stopped data, immutable provenance, incompatible history/proposals/guidance, long workbook provenance: exporter units + authenticated downloads passed. |
| V19 | Fixed >500-value pages during appends/edits; all paused/failed/stopped and mixed/empty batches, direct member fallback and exact member/history cuts: PostgreSQL + off-page/batch/export browser passed. |
| V20 | Every new GET/POST route denies unauthenticated/foreign owners; wrong Origin, >1MiB body, foreign Evidence and unrelated guidance target refused; no endpoint credential capture: expanded access browser + contract/endpoint checks passed. |
| V21 | Paused/terminal reachability, explicit in-flight delete fence, stale publication denied, shared source retained, current-boot cancellation and failed-status read fail closed: native delete browser + PostgreSQL/GC/recovery passed. |
| V22 | Static/unit/safety/database/recovery/service and selected real-provider checks passed. Final 14-case retained run passed; independent Standards/Spec code and evidence reviews found no remaining material finding. Admissions remain OFF. |

### Failed attempts and conditional checks

Failed attempts remain failures, with their logs/traces preserved:

- Corepack initially used a nonwritable cache; collection at `/test/tests` also
  broke a fixture's repository-root assumption. Both are runner setup failures,
  corrected using the private Corepack cache and full repository mount.
- The first retained-source fixture tried to update immutable snapshot bytes,
  later delayed the wrong source endpoint, then asserted an anchor attribute
  when the overlay exposes an occurrence. Fixtures were corrected; production
  navigation itself was fixed in `969ba923` and passed the final delayed-source case.
- Spark's initial 12-case run passed 11 and failed that overlay assertion;
  `b113d326` passed 12 of 13 and raced a typed correction's asynchronous Save.
  The fixture now waits for the persisted value (`301bd972`). Both full 13-case
  reruns passed. Their old logs/traces are retained.
- `7775820d` omitted coordination initialization from the test service worker;
  `3582ade4` fixed the helper. Its first four-method run passed three and failed
  unified because the provider fixture lacked its discovery/quoted-field
  response protocol. `08660250` adds that protocol; all four methods passed.
- The globally forced `FREE_CATALOG_METHOD=unified` standard run passed 78,
  failed the canonical generic fixture and did not run its following serial case.
  Its artifact declared different inputs and was correctly refused. The isolated
  Catalog reproduction failed identically. The normal standard suite then passed
  all 77, and the three opt-in unified preference cases passed separately.
- The expanded access attempt at `4d15349d` passed the original 13 and hit
  `ECONNRESET` when reusing connections after refused POST bodies. `1788fcbb`
  gives each rejected POST a fresh connection. The focused access case and all 14 together passed;
  both executions are recorded above.
- A live GLiFormer check from the isolated PostgreSQL network namespace could
  not reach the model's separate Docker bridge. The host-owned, database-free
  live protocol run passed both cases; native service browser calls also passed.
- The final guidance runner first used an overlong private `TMPDIR`, causing
  Chromium's Unix socket path to exceed its limit before any test body ran.
  A short task-owned `/tmp` directory fixed the runner. Its first executable
  attempt passed the previous five worker/deletion cases but tried to initialize
  a second schema in one Project; the API correctly returned 409. The fixture
  now reuses A's immutable Schema Revision for B (`88eaa2d4`).
- The joined guidance cases at `88eaa2d4` and diagnostic cut `4c5f05f2` failed
  substantively: the SQL capture included the correction at feedback version 1,
  but the composer omitted it for budget because Article had allocated all
  spare context to the reply. `6801a88c` separates the required floor from extra
  reply capacity; `a69772e2` also preserves the bounded root's source-sized
  floor. The six-case browser run at `6801a88c` passed, followed by both full and
  bounded journeys in the final seven-case run at `7dffc780`.
- The new bounded journey at `cbc1d751` failed before a provider call. The
  diagnostic at `3a00b201` identified `PydanticSerializationError`: global
  `exclude_none` removed keys the explicit Article serializer still owned.
  This affected all explicit Article settings. `7dffc780` filters only outer
  nulls after nested serialization; full/bounded settings and immutable restore
  regressions, both browser journeys and the affected matrix passed. These
  failures remain archived; they are not classified as fixture failures.
- The affected PostgreSQL wrapper initially resolved `tsx` from the workspace
  root, where it is not a direct dependency. It failed before connecting; the
  runner uses Studio's explicit installed loader path. The subsequent 113-case
  runs at `cbc1d751` and `7dffc780` passed in the owned PostgreSQL namespace.

Python's 72 unit skips require absent private upstream PDFs (`main.pdf` and
`Beier1988_GAC_02_Catalogue7.pdf`); the generated native PDF fixtures ran. Its 18
PostgreSQL skips are the 13+5 native lifecycle/process-recovery cases run by the
Node orchestrators, not missing acceptance. The standard suite's three unified
preference skips were executed in their separate opt-in run; its other two are
the real GLiFormer/scanned-source specs. The ordinary service suite defers two
native live cases and its original GLiFormer/real-document/scanned-document
specs; the new native live cases and GLiFormer protocol were executed separately.
No optional private scanned/document case is inferred to have passed.

### Reproduction

Use the private checkout and artifact browser path, with one private Compose
project per tier. Configurations enforce their disposable database/port guards:

```sh
pnpm typecheck
pnpm lint
pnpm test:unit:node
pnpm test:safety
pnpm --filter studio exec playwright test
FREE_CATALOG_METHOD=unified pnpm --filter studio exec playwright test unified-catalog.spec.ts
pnpm --filter studio exec playwright test --config playwright.recovery.config.ts
pnpm --filter studio exec playwright test --config playwright.durable.config.ts
pnpm --filter studio exec playwright test --config playwright.service.config.ts
```

The actual live subset uses `FREE_REAL_EXTRACT_URL`, `FREE_REAL_EXTRACT_MODEL`
and `FREE_REAL_GLIFORMER_URL` to select the existing stateless Qwen/GLiFormer
endpoints, then runs the service config's `durable-service.spec.ts` with
`--grep 'real provider requests'`. Qwen identity is
`nvidia/Qwen3.8-27B-NVFP4`; native fields identity/revision and protocol are
captured in each actual request, with GLiFormer input cap 2,048 and threshold
0.05. No stochastic value/count expectation drives the production code.

For PostgreSQL, provision the owned server first and run
`free-durable-spark-postgres-guidance-final.mts` from the artifact directory inside its
network namespace. It imports the repository guard/provision/migrate helpers,
creates a unique `free_test_durable_spark_extraction_*` target, runs the package
PostgreSQL tier, and drops its target in `finally`. The recorded runner sets
`DURABLE_TEST_DOCKER_NETWORK=container:free-durable-test-spark-pg-91bc1690`;
accepted alternatives are host or a strictly task-prefixed container namespace.
The database guard is unchanged. Python generic PostgreSQL/service/recovery
uses the same owned namespace and guard. All database targets are disposable.
The owned server was cleaned up after verification; reprovision a guarded owned
server before reproducing this tier. Browser runs use the short owned `TMPDIR`
to avoid Chromium's Unix socket length limit.

### Independent review and admission

Complete read-only Standards review found two remaining source-identity
fallbacks, removed in `f91a3e22`. Spec review corrected the unrelated guidance
target fixture to the intended 404 and accepted the combined lifecycle proof.
Final evidence review required a joined UI correction-to-provider case for V12;
that execution exposed the Article budget and explicit-settings serialization
defects described above. Both are fixed and verified, including the bounded
reply floor identified during review. Final code reviews of these fixes found
no further concrete defect. On 2026-10-05 both independent reviewers checked
the private Spark checkout's exact `7dffc780` HEAD, final logs, both full/bounded
guidance artifacts and exported snapshots against this record. They confirmed
the exact candidate/revision attribution, ungrounded correction, actual HTTP
body equal to the saved capture, unchanged started-call export and a genuinely
later capture omitting excluded guidance. Standards and Spec reviews found no
remaining material code or evidence finding and no important required acceptance
gap. Their approval covers this implemented candidate and verification scope;
it does not authorize a merge, deployment, production migration or enablement.

The bounded simplify-and-harden self-pass rechecked the modified call/capture,
Article budgeting, serializer, counter identity and authenticated durable API
contracts. It required no refactor, security patch or further source edit; the
existing comments explain reply-floor and nested-serializer ownership. Current
affected checks and the unchanged TypeScript admission/access checks cover it.

```yaml
simplify_and_harden:
  version: "0.1.0"
  scope:
    additional_changes_lines: 0
    budget_exceeded: false
  simplify: {applied: [], flagged: []}
  harden: {applied: [], flagged: []}
  verification_result: pass
  review_followup_required: false
```

`DURABLE_RELEASE_VERIFIED=false` stays hard OFF. Environment flags cannot enable
new durable admissions. Readers/coordination remain available for seeded native
history. These checks authorize neither merging this branch, production database
migration, deployment nor feature enablement.

# FREE service consolidation: coordinator handoff

Created: 2026-09-22. Updated: 2026-09-23. Status: **consolidation implemented;
validation incomplete**. The current update below supersedes the September 22
snapshot, which is retained as historical evidence rather than current resume
instructions.

## Current update: September 23

- Later on September 23 the grounded numbered-catalogue plan was implemented
  (uncommitted) through M5: recipe segmentation, grounded extraction
  version 2, and Studio review. M6/M7 are partial and M8–M10 are blocked on
  data. Current evidence and gates are in the
  [grounded catalogue validation record](2026-09-23-grounded-catalogue.md).
  It adds to the discovery notes below, which still describe generic Catalog
  (the default).
- Consolidation is committed in `b07741d`. Later discovery, launcher, fixture,
  and documentation changes remain uncommitted. Preserve the live working tree.
- The captured 8192-token Qwen reasoning loop was reproduced and addressed by
  `reasoning_effort: "none"`. The old handoff's statement that this was only a
  hypothesis is superseded. Headed sources then exposed separate discovery errors.
- The [completed investigation](../../artifacts/handoffs/2026-09-22-service-consolidation/codex-investigation/report.md)
  made 918 local model calls without changing service code. The current service
  uses three discovery examples; the second was reworded and includes a final
  continuation. `PROMPT_VERSION` is now 4. No second classification call was added.
- A fresh A–Q replay scored 30/34 at the runtime token cap. Q's continuation is
  retained; N's German district headings are now misclassified without a
  discovery issue. The remaining L mismatch reports no records. These are
  development fixtures, not blind catalogue evaluation. See the
  [updated validation record](2026-09-22-monorepo-service.md#september-23-discovery-prompt-validation).
- Focused extraction tests passed: 32. The two-records-in-one-segment limitation
  remains; this prompt change does not implement character-span boundaries.
- The headed real-model local service E2E passed in 6.5 minutes, including
  Article/Catalog results, evidence/review, and API/worker restarts. It used two
  CPU math-library threads under host memory pressure; preceding database
  readiness/upload-timeout failures are preserved. No assertions or timeouts
  were weakened. The deterministic tier was not rerun in this continuation.
- Spark authenticated Catalog checks passed for both native and image-only
  versions of the headed page: two correct records, six grounded values,
  review, evidence navigation, and reload. This is one synthetic scanned page,
  not broad OCR/catalogue-quality validation. Logs, artifacts and screenshots
  are in [`discovery-prompt-v4/`](../../artifacts/handoffs/2026-09-22-service-consolidation/discovery-prompt-v4/).
- With explicit user authorization, `stages.py` and `run.py` were copied into the
  Spark development checkout and its API/worker containers, and only those two
  services restarted. Both load version 4. This validates patched running
  containers, not newly rebuilt images; a recreate from the old image would
  require rebuilding or reapplying the source changes.
- Local launcher code now uses `up --watch`, because Compose rejects combining
  `--watch` with `--no-build`. Production still uses `up --no-build -d --wait`.
- Resource listings and disk limits in the historical snapshot are stale.
  Reinspect before reuse or cleanup. The local task model and Spark development
  stack are retained; synthetic Studio projects and the temporary tunnel were
  cleaned up. Unrelated services were left untouched.
- Remaining consolidation work includes fresh image-build validation and the
  earlier launcher/runbook review leads. The wider KIE segmentation work and
  the German-heading discovery error remain unresolved. Do not describe this
  prompt improvement as completion of the broader plan.
  The [implementation plan for Opus 5.5](../plans/2026-09-23-grounded-kie-opus-5.5.md)
  defines the next catalogue milestones; it is proposed work, not a completion record.

## Historical snapshot: September 22

The remaining sections describe the state at the original pause.

## Start here

The user requested: **“consolidate the existing service into FREE and validate
that complete application”**, then asked to hand the work to another coordinator
and persist the subagents' state. Resume that implementation and validation in
this workspace. The destination is one FREE monorepo containing the existing
kei-exp service, with FREE Studio as its UI.

- Workspace: `/home/gennaro/projects/FREE`.
- Branch: `feat/kei-exp-parser`.
- HEAD at handoff: `3f64cfadfdb4baa0e29c7159630bf281026e9190`.
- All work below is **uncommitted**, including substantial **untracked** imported
  source/tests. `git diff` alone does not show the full implementation.
- No commit, push, PR, production deployment, or external data transfer was
  performed. Do not reset the working tree or overwrite the user’s work.
- Other kei-exp checkouts/worktrees and existing application data were not changed.
- Read `README.md`, `CONTEXT.md`, `CONTRIBUTING.md`, the service README/CLAUDE,
  and Studio CLAUDE before further changes. Preserve existing database and
  authentication contracts. The user dislikes unnecessary confirmation stops.

The source import and application wiring are implemented. The immediate blocker
is a **real Qwen Catalog extraction failure**, followed by unfinished **Docker
image build validation**. Most other checks pass. Do not report the application
as fully validated yet.

## Persistent agent briefs and evidence

These files live on disk and do not require the previous conversation or live
agent memory. Detailed briefs and logs are local, under the gitignored
`artifacts/` directory; retain them for the next session.

| Previous agent | Scope | Persistent brief |
| --- | --- | --- |
| `/root/kei_jobs_status` | Backend import, PostgreSQL/recovery checks, current real-model diagnosis | [kei-jobs-status.md](../../artifacts/handoffs/2026-09-22-service-consolidation/kei-jobs-status.md) |
| `/root/free_migration_status` | Compose, launcher, safety tests, pending Docker build | [free-migration-status.md](../../artifacts/handoffs/2026-09-22-service-consolidation/free-migration-status.md) |
| `/root/extraction_status` | CI, real-service E2E harness, ordinary browser regressions | [extraction-status.md](../../artifacts/handoffs/2026-09-22-service-consolidation/extraction-status.md) |

Recreate agents from these briefs if their previous session identities are
unavailable. They share the same working tree, so coordinate ownership.

- [Preserved root logs/results](../../artifacts/handoffs/2026-09-22-service-consolidation/logs/).
- [Validation record](2026-09-22-monorepo-service.md).
- [Accepted architecture decision](../adr/0009-own-parsing-and-extraction-service-in-free.md).
- The local handoff directory also contains a Git status/patch and a source
  snapshot including untracked files. These are recovery aids; inspect the
  live working tree first and do not blindly replay them.

## What is implemented

Imported the backend from kei-exp commit
`93b9435c2b9a01a5424758d917c058fc79bbc159` into
`prototypes/parsing_service`. Retained the `kei_exp` Python package name and
the `parsing-service` pnpm workspace. Removed the old `app/` parser, obsolete
tests, standalone experimental web launcher, CLI model launcher, and unused
Modal dependency. The standalone Next.js UI, research runs, PDFs, and worktrees
were not imported. Selected internal specifications remain for code contracts.

FREE Compose now owns:

- Studio and its existing research PostgreSQL database;
- parsing API on private port 8001, separate worker, job PostgreSQL, schema
  initializer, and shared durable run storage;
- Ollama extraction model server and a cache-aware model initializer;
- optional GPU overlay with Surya OCR through vLLM.

Studio uses `http://parsing_service:8001`; no sibling checkout or host API is
required. `FREE_GPU=auto|off|required` replaces the obsolete device setting.
Native PDF parsing and extraction support CPU. Scanned PDFs require the OCR
GPU overlay. Production retains FREE's **host nginx** contract.

The launcher builds first, then stops only Studio/API/worker with a 60-second
grace period, then runs Compose `up --no-build` (`--watch` locally, `-d --wait`
in production). Compose runs job migration before replacement processes start.
Build failure leaves the old processes running; failed migration blocks startup.
API/worker entrypoints also validate schema on every process restart. The
worker has no health check; avoid claiming that all processes are health-checked.

Ollama is pinned to
`ollama/ollama:0.34.2@sha256:da6e0dc5651df159e45686fd663c4dbe1624a52c44d7280eeac1551d8f865532`.
Default model is `qwen3:8b`, context 16384, parallelism 1. vLLM settings and an
ARM64 image override are documented, but scanned OCR and Spark are unvalidated.

Root integration fixes:

- Catalog DTO accepts absent local Catalog diagnostics from the delegated
  backend while retaining validation of diagnostics that exist.
- Provider stream cancellation owns its final trace; a pending read no longer
  overwrites cancellation with a failure.
- Extraction artifacts must identify a nonempty model before FREE persists
  them. Fixture success responses now supply an actual default model.

The backend's PostgreSQL test harness guards disposable loopback:5432
`postgres`/`free_test_*` databases and pins `hostaddr` to avoid ambient libpq
redirection. Optional source PDFs remain optional; native smoke/recovery inputs
are generated. Recovery assertions now wait for authoritative Procrastinate
terminal status, not the earlier task finish timestamp.

CI and `test:all` include a new `pnpm test:service` tier. It runs real Python
API/worker, real native parsing, PostgreSQL, authenticated Studio upload,
Article/Catalog extraction, six grounded values per strategy, review, evidence
navigation, and restarts. Its normal model fixture scripts only completions.
An environment override runs the same workflow with a real model.

## Verification at pause

| Check | Result |
| --- | --- |
| `pnpm test:unit` | Pass: 1,777 tests across the aggregate, including 1,032 Studio and 583 backend tests; 73 optional backend PDF cases skipped |
| `pnpm typecheck` | Pass |
| `pnpm lint` | Pass; 3 existing React Hook warnings |
| `pnpm test:safety` | 14 passed |
| Ordinary browser suite | **50 passed, 1 expected developer-UI skip**, 1.6 minutes |
| FREE PostgreSQL | 3 Project Store + 20 extraction tests passed |
| Backend PostgreSQL | 106 passed, 4 optional research-fixture skips |
| Native API + worker + DB smoke | Pass |
| Interrupted-worker recovery | Pass on generated 300-page PDF, CPU, 136.82 seconds |
| Deterministic real-service workflow | Pass, 24.2 seconds |
| Real Qwen workflow | **FAIL**: Article passes; Catalog contains null fields after truncated calls |
| Host Studio production build | Pass |
| Architecture validation | Pass |
| Backend/Studio Docker image builds | **Unfinished**; deliberately interrupted to reduce disk contention |
| Diff whitespace check | Pass before handoff artifacts |

The ordinary browser suite required test-only repairs: actually select Catalog
for its parameterized case, use Catalog's run toolbar instead of Article's
retry button, accept the already-terminal concurrent cancellation response,
await the final batch before shutting down its fixture, and supply model
attribution. The final suite is green; do not revert these as timeout changes.

The `bloat-audit` skill was applied. The scanner found two harmless signals
(README “never fall back” and a moved `process.env` line), with no outstanding
blockers. Imported source was also manually reviewed because untracked files
are outside the scanner's diff. Retained exceptions are durable job/storage
contracts, locked ML dependencies, and explicit hardware/model settings.
Rerun the audit after further model or build fixes.

The migration agent also recorded three review leads at the pause boundary:
Quickstart may omit the `uv` prerequisite; parsing `configs/` changes are not
watched despite broader development wording; and the existing `test:system`
host-model defaults may depend on the removed Studio host-gateway mapping.
These were not fixed or fully validated. Triage them from its brief before
declaring the launch/documentation/verification contract complete.

## Current real-model failure

Most recent complete test command:

```bash
FREE_REAL_EXTRACT_URL=http://127.0.0.1:32769/v1/chat/completions \
FREE_REAL_EXTRACT_MODEL=qwen3:8b pnpm test:service
```

The failure is recorded in preserved `free-monorepo-real-model.log` and
`real-model-service-results/`. Article returns expected values. Catalog
discovers two records but one or more record calls generate up to 8192 tokens
for a tiny prompt, terminate with `finish_reason=length`, and yield null fields.
The backend records these as incomplete results with call issues; the exact
result assertion fails. This must not be papered over by weakening the test.

The service agent finished comparing identical synthetic record requests with
and without `reasoning_effort=none`, using max_tokens=512. Both returned correct
Valley JSON: the default used 185 completion tokens with separate reasoning;
`none` used 30 tokens without reasoning. Both took about 1.7 seconds. This proves
the control works, but **does not reproduce or explain the earlier 8192-token
truncation**. Requests/responses and a replay script are saved beside its brief.
No runtime request fix was made. Reproduce the failing request/settings before
accepting a diagnosis or claiming this control fixes the application.

Earlier real-model attempts were invalidated by shared Playwright output paths
and one transient API port collision. The harness now keeps service result and
state directories under separate siblings of `artifacts/service-tests/`.
The failure above is from the subsequent properly isolated run.

The real-model tier does not instrument model call counts; it checks identical
durable artifacts across restart. The scripted tier additionally proves no
extra calls after restart. Preserve this distinction in the final report.

## Running resources and disk limits

The following two containers belong to this task and are intentionally left
running for continuation:

| Resource | Details |
| --- | --- |
| `free-monorepo-validation-model` | Ollama 0.34.2, NVIDIA GPU, `qwen3:8b`, loopback **32769 → 11434**, label `free.test=monorepo` |
| Model cache | Bind mount `artifacts/monorepo-validation/ollama`; about 5.2 GB, possibly root-owned; keep for repeated tests |
| `free-monorepo-parsing-tests` | PostgreSQL 17, loopback **5432**, labels `free.test=parsing`, `free.owner=codex-monorepo-migration` |
| Disposable DB credentials | `postgres:postgres`; databases `free_test_parsing`, `free_test_project_store`, `free_test_extraction` |

The browser stacks `free-studio-e2e` and `free-studio-service-e2e` were cleaned
up by their harnesses. Verify state again before assuming ports are free.

**Unrelated resources: leave alone.** PostgreSQL containers
`flamboyant_carson` (55175), `modest_zhukovsky` (6789), Docker Model Runner
(12434), Open WebUI (3000), and a host listener on 11435 predate this task.
No global Docker/image/cache prune is authorized.

Docker uses the root partition: approximately **6.7 GB free of 92 GB** at
handoff. The workspace is on another partition with roughly 217 GB free.
Parallel cold builds and model pulls caused severe I/O contention. Build
images **sequentially**. The locked Python environment is about 6.1 GiB, and
its BuildKit UV cache occupies another 6.381 GB.

Planned resource sequence once real-model validation finishes:

1. Stop only the task-owned model container. If disk space is still necessary,
   remove only its newly pulled `ollama/ollama:0.34.2` image after checking no
   other container needs it; keep the workspace model cache. This should free
   enough space for the backend build. Do not remove any user's preexisting image.
2. Resume only the backend image build; use the exact command in the migration
   agent brief. Run its packaged import/API/CLI probe after success.
3. The task-owned BuildKit cache record is
   **`attui0utzrv8x85padkl0dfi1`**, CreatedAt **2026-09-22 18:51:33 UTC**,
   Shared:false, description rooted in the `uv sync --frozen --no-dev
   --no-install-project` cache mount. Only after a successful image/probe, verify
   that record again and prune **only that ID** if space is required. The image
   uses UV copy mode. No broad cache cleanup.
4. Resume Studio image build:

   ```bash
   docker build --progress plain -t free-monorepo-validation-studio \
     -f prototypes/studio/Dockerfile .
   ```

Both earlier build processes were explicitly cancelled, exit 130; no Docker
build should still be running. Their logs are preserved. The backend agent
brief contains the exact build stage/cache progress and runtime probe plan.

Shell `pnpm` in the restricted sandbox repeatedly hung fetching engine
signatures. Commands run with `exec_command`'s `require_escalated` worked.
Docker/socket/GPU checks also used that permission path. This was a sandbox
limitation, not a repository test failure. Keep long-running output in log files
and give the user progress updates while waiting.

## Ordered next actions

1. Read all three agent briefs, verify live Git/resources, and inspect the
   persisted Qwen probe. Preserve every existing edit.
2. Diagnose and narrowly fix the real Catalog model request issue; add a
   meaningful regression and rerun both real and scripted service workflows.
3. Complete backend and Studio Docker builds sequentially, with the resource
   sequence above. Validate packaged entrypoints/imports and startup contracts.
   Do not claim a full container deployment from image builds alone.
4. Run focused checks for new edits. The current aggregate unit, browser,
   PostgreSQL, recovery, type/lint, and safety evidence already passes; repeat
   broad suites only if subsequent changes warrant it.
5. Update the validation record with final real-model/image outcomes, run the
   final bloat/diff check, and stop/remove only task-owned test resources when
   they are no longer needed. Keep useful logs and model cache.
6. Give the user a self-contained completion report with evidence and explicit
   remaining validation boundaries. Leave changes reviewable and uncommitted
   unless the user separately authorizes publishing them.

Known boundaries: scanned Surya quality, GPU overlay execution, ARM64/DGX Spark,
and production HTTPS/Entra deployment have not been validated here. The imported
Catalog algorithm still cannot split two record starts inside one parser
segment; the integration fixture deliberately uses two separate native blocks.
Historical runs from a separate kei-exp deployment were not transferred; FREE
research data was not reset.

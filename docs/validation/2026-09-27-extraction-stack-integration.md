# Extraction stack integration — 2026-09-27

Status: locally verified; live ablation study and its final report remain open.

Tested full stack: `88eed7ce42bf597728c631947de2ccea86d44e84`, whose tree is
identical to tested merge `9fcb6841621606319052f259fcb907d28961f962`.
It combines fixes/Source Ingestion `b0a3190`, study/reporting `457b450` and
repaired parser foundation `93e1ea7`. The intermediate study PR is based on
integration `7c3e5249111e46137f3d06bf10dd2ac9065d2eba`.

Worktree: `/home/gennaro/projects/FREE-worktrees/extraction-current-stack`.
Logs and the disposable-database driver are in `artifacts/extraction-integration/`
there. The primary FREE checkout remains at its pinned R1 runtime; no source,
manifest, captured reply or frozen follow-up archive was changed by integration.

## Resolutions

- Studio's default browser suite excludes both real-service specifications and
  both restart specifications; their dedicated configurations own them.
- The Studio guide preserves asynchronous Source Ingestion and durable
  reprocessing, including the latter's current browser wait. The obsolete
  unconditional baseline-reset instruction is removed.
- Existing GC fixture updates from parser commit `6a26ddd` are carried over:
  new uploads return admission (`202`), scenarios explicitly await their workflow,
  and completed-content replay still returns `201`. Joined held uploads must
  name the same workflow before the recovery scenario kills its own process.
  These replace obsolete handler timeout/poll options and synchronous assertions.
- Source Ingestion's ADR is numbered 0014, with its references updated, so it
  does not collide with foundation ADR 0012. Its decisions are unchanged.
- Both batch cancellation checks and the existing forced check before extraction
  publication survive integration. No workflow step sequence or application
  version changes were introduced by these resolutions.

## Verification

| Check | Result |
| --- | --- |
| Full-stack fast parser suite | 1068 passed, 72 skipped, 74 deselected |
| Parser extraction-workflow and delete-run suites | 74 passed against guarded disposable PostgreSQL |
| `pnpm typecheck` | Passed |
| `pnpm test:unit:node` | 1791 passed: 60 script, 4 configuration, 1556 Studio, 66 database, 72 extraction, 33 export |
| `pnpm lint` | No errors; three existing React hook warnings |
| Studio PostgreSQL GC acceptance | Seven passed, including the four adapted recovery scenarios |
| `pnpm --filter studio test:service` | 14 passed in 4.4 minutes |
| Browser suite collection after config reconciliation | 61 default and five recovery scenarios; collection only, no duplicate service/restart inclusion |
| Subsequent `pnpm test:e2e` on the integrated stack | All 61 default and five recovery scenarios passed; `browser.log` |
| Intermediate study branch fast parser suite | 1024 passed, 72 skipped, 74 deselected |
| Intermediate study branch captured reference replay | Six sources, 88 identical requests/replies and artifacts, excluding only top-level clocks |
| Diff and bloat review | Passed; no new runtime dependencies, compatibility paths or settings |

The first typecheck found four GC fixtures still using removed synchronous
handler options. The existing parser-branch fixture updates resolved this;
their actual PostgreSQL scenarios then passed. No runtime fallback was added.

The full-stack service suite runs real authentication, PostgreSQL, DBOS, Python
parsing, canonical evidence, extraction publication, review and restart recovery.
Only the extraction model boundary is scripted. These results do not establish
fresh model accuracy or production deployment behavior.

The service stack used its own Compose project `free-extraction-stack-service`,
PostgreSQL port 25445, Studio port 41781 and OIDC port 41782; its containers,
network and volume were removed by teardown. The GC acceptance driver guards
its target before creating a random `free_test_extraction_stack_*` database,
migrates it, and removes only that owned database in cleanup. Python tests use
`free_test_parsing` as maintenance and their guarded per-case databases.

Python dependencies came from the existing locked environment, with `PYTHONPATH`
pointing explicitly at this worktree's `prototypes/parsing_service/src`. An import
check confirmed that source path. The temporary `.venv` symlink used by the
service fixture was removed after completion; no sibling runtime was imported.

Bloat review retains the shared test upload helper because three GC scenarios
need the actual admission/completion contract. It removes their duplicate old
request/wait code; its `201`/`202` branches represent current public outcomes.
No additional removal or production abstraction is needed.

The later browser run used `free-extraction-stack-browser`, with PostgreSQL
25448, Studio 24781 and OIDC 24782. Both suites removed their own containers,
network and volume. Recovery exercised open-page and between-poll Studio
restarts, credential resupply and a planted-key storage sweep, plus admitted
upload recovery and dismissal after restart. Browser fixtures stand in for
the external parsing/model endpoints; the separate service tier above uses
the actual Python service with only model replies scripted.

## Remaining gates

### Standalone parent repair and final ancestry

The earliest repair now includes the service fixture and final-publication
cancellation guard at `3c714c9`, so it does not depend on this child PR to pass
its service boundary. It passes 985 fast parser tests, 36 extraction-workflow
tests and typechecking. Twelve of its thirteen service scenarios passed in the
first run; the sole stale ten-minute expectation was corrected to three hours,
and that scenario passed separately. The repair report retains the initial
failure and rerun scope.

The intermediate study branch incorporates this at `4110ca9` and passes 1026
fast parser tests. The full stack incorporates that ancestry at `4492a68`;
its runtime and test files are byte-identical to `24ed4bd` and retain the
full-stack validation above. Only documentation changed when the existing fixes
were moved earlier in the review stack.

Parent repair `9a85f01` additionally carries the existing manual model-picker
fixture fix from the full stack. Its 12 model-configuration browser scenarios
pass; the same timing race had failed CI on repair `93e1ea7` and study
`4110ca9`. Study merge `7fb6616` incorporates it. The full-stack merge changes
only the repair report because the fixture was already identical here. A
separate parent CI failure was an occupied browser PostgreSQL port, before
any browser scenario ran; its owner is unknown. CI success is not inferred
from these local results.

GitHub's complete `verify` job subsequently
[passed at `16b2cb1`](https://github.com/HUM-CDCH/FREE/actions/runs/36334988138).
The final ancestry merge `56cc78e` and this evidence update retain identical
runtime/test files; their differences from that verified commit are documentation.
The independently pushed parent heads still require their own CI conclusions.

Capture replay now covers 37 R1 cells and 1252 saved calls: the original
35-cell offline report plus `increment-37-offline.json` under the primary
checkout's `artifacts/extraction-ablation/replay-verification-20260927/`.
The two additional cells used 101 separately cached tokenizer probes in the
initial verification and then passed again with HTTP disabled, with zero new
model or tokenizer calls. These are later tokenizer observations, not original
inference captures. Remaining cells still require final verification.

The registered R1, R2a, R3 and R4 studies still require all terminal cells,
final capture replay, paired effects and the final development-corpus report.
Their independent-annotation limitation remains unchanged. PRs remain drafts
and are not merged or deployed. Historical validation snapshots remain intact.

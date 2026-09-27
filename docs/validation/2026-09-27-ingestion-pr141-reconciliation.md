# Source Ingestion and PR #141 reconciliation — 2026-09-27

Status: implemented and locally validated on PR #141's branch.

## Scope and ancestry

Recovered T3 thread `dbf0b382-615b-4f13-b346-0b990052f56f` implemented
server-owned Source Ingestion, then merged it into `feat/kei-exp-parser` at
`37c7898`. Its final authorized follow-up stopped at a provider usage limit.

PR [#141](https://github.com/HUM-CDCH/FREE/pull/141), originally at `1fa6a9b`,
now also contains the ingestion branch through `07d7e58`. The ingestion commits
retain their ancestry. The parser branch's unrelated M6 garbage-collection and
configuration changes were not merged into this PR.

The completed follow-up (`49acf3e` on the parser branch, `eedba19` on this
branch) checks cancellation after the final model call and before artifact
publication. It changes the existing step body, not the durable workflow's
step sequence or application version. Article and Catalog regression tests
exercise that boundary with a recent successful status read, proving the final
check bypasses throttling.

The real-service fixture now answers Article inventory, per-record values and
semantic grounding from parsed source text. Its expected call count and the
three-hour Article deadlines match the implemented protocol. Only the model
boundary is scripted; parsing, DBOS, PostgreSQL, evidence and review are real.

The model-configuration browser test now enters a model ID absent from its
probe catalog. Its former listed ID made the manual-entry option disappear
when the asynchronous probe completed, causing PR #141's CI timeout.

## Validation

Checks on the combined PR branch:

| Command | Result |
| --- | --- |
| `pnpm typecheck` | Passed |
| `pnpm lint` | No errors; three existing React hook warnings |
| `pnpm test:unit:node` | Passed: 58 script, 4 configuration, 1,512 Studio, 61 database, 68 extraction and 33 export tests |
| `uv run --no-sync pytest -q -m 'not live_model'` in Parsing Service | 1,100 passed, 72 skipped, 18 deselected |
| `pnpm test:postgres:node` | 42 database, 55 extraction and 53 Studio tests passed |
| `pnpm test:safety` | Passed |
| Default browser suite | 59 passed initially; the two failed scenarios subsequently passed individually (61 distinct scenarios) |
| `FREE_PLAYWRIGHT_POSTGRES_PORT=25436 pnpm exec playwright test --config playwright.recovery.config.ts` in Studio | 5 passed |
| `pnpm test:service` | 10 passed |

Python database tests used guarded loopback `free_test_parsing` and created
their own per-case databases. Node PostgreSQL tests used a newly created,
migrated `free_test_pr141_reconcile`, dropped after the checks. Browser tiers own disposable stacks.
No runtime or production database was used.

One initial 65 MiB upload unit test exceeded its five-second limit while
dependencies were installing; the complete Node unit aggregate passed after
installation finished. The first default browser run overlapped creation of
the service stack's Docker network: browser artifacts show
`ERR_NETWORK_CHANGED` and a failed lazy page load. Results of the isolated
rerun are recorded above; a two-worker rerun also hit a mock-OIDC sign-in
failure before the remaining scenario passed with one worker. No application
retry or timeout workaround was added. The restart stack's first startup could
not bind its default PostgreSQL port; the final run uses the existing
`FREE_PLAYWRIGHT_POSTGRES_PORT=25436` override, below Linux's ephemeral range.

The original parser branch also received `3080dd6`, which adapts its M6
large-conversion GC scenario to asynchronous upload admission. That test does
not exist on this PR's narrower branch. On the parser branch, 985 fast Python
tests and 36 extraction-workflow tests passed. The initial real-service run
passed 11 scenarios; after correcting two stale assertions, the two failed
scenarios and the serially skipped scenario all passed in a focused rerun.

## Boundaries

- No deployment or new model-accuracy claim. The registered extraction studies
  and their frozen execution archives are unchanged.
- Part B reprocessing remains a separate follow-up; it retains its existing
  browser wait. Files not yet admitted cannot survive a reload.
- The original review's deferred ingestion polish remains: the brief transition
  between a successful listing and branch refresh, a stale read after dismissal,
  screen-reader announcement of listing errors, and clearer stopping-state copy.
  The existing dismissal lookup/retention cost and 404 behavior are unchanged.
- The original parser branch is retained with its completed follow-up; this
  reconciliation does not merge PR #141 into that branch.

Bloat audit: passed, with no blockers or new dependencies, runtime options,
fallback paths or parallel execution mechanisms in the follow-up. No extra
removal was needed. The existing reprocessing region remains an explicit
Part B exception and limitation. The regression tests cover publication
cancellation rather than mirroring the implementation; verification is listed
above.

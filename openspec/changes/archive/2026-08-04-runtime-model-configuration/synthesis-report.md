<!-- markdownlint-disable MD013 -->

# runtime-model-configuration groups 3–7 — implementation synthesis

Four candidates implemented task groups **3–7** from baseline `2c34b92`. This
records how they were judged and what was grafted into
`synthesis/runtime-model-config-groups-3-7` (branched from `44b9b55`).

- **Worktrees:** `/tmp/free-runtime-model-config-g3-2c34b92-worktrees/` — **volatile** (tmpfs).
- **Recorder:** `/tmp/free-runtime-model-config-g3-2c34b92-comparison/`.
- **Patch snapshots:** `<session scratchpad>/patches/*.patch` — also volatile. Copy
  these somewhere durable before any teardown; for the three candidates not
  adopted they are the only remaining copy.
- All four candidates ran `openai-codex/gpt-5.6-sol`: `sol-high-1`, `sol-high-2`
  at `high`; `sol-xhigh-1`, `sol-xhigh-2` at `xhigh`.

Baseline choice is safe: `git diff 2c34b92..44b9b55` touches only `.claude/`,
`.codex/` and `.qlty/` — no `prototypes/`, `docs/`, or change-dir files moved
under the candidates, so their patches apply to `44b9b55` unchanged.

## Run status

`survey.py` printed "no recorded checks" for every candidate. That column is
wrong: `survey.py:129` looks up `<worktree-directory-name>.metadata.jsonl`
(`runtime-model-config-g3-2c34b92-sol-high-1.metadata.jsonl`) while the recorder
wrote `sol-high-1.metadata.jsonl`. Parsed by hand, last attempt per check:

| candidate | `group3-tests` | `studio-build` |
| --- | --- | --- |
| sol-high-1 | pass (try 1) | pass (try 1) |
| sol-high-2 | pass (try 3) | pass (try 3) |
| sol-xhigh-1 | pass (try 1) | pass (try 1) |
| sol-xhigh-2 | pass (try 3) | pass (try 2) |

**That green covers task 3.5 only.** The harness was configured with group 3's
two commands; groups 4–7 name their own (4.8, 5.5, 6.7, 7.4 — full suite, lint,
Playwright, `git diff --check`) and none ran for any candidate. Two further
traps in that recorded green:

- `group3-tests` names `api/model_config.test.ts`, which exists in neither the
  baseline nor any candidate. Vitest CLI filters are substring matches and a
  filter matching nothing is silent, so "74 passed / 11 files" was never
  evidence about that file.
- `api/_model_config.test.ts` (600 lines, 24 cases) is **unmodified in all four**
  — it appears in no candidate's `git status`. Groups 3–7 added nothing to it.

Re-running the full suites was done read-only, outside `pnpm`, after the fact:
74 / 79 / 113 / 80 tests, all passing.

## Size

`survey.py`, against `2c34b92`, untracked files included:

| candidate | prod code | comment | blank | test code |
| --- | ---: | ---: | ---: | ---: |
| sol-high-1 | 1417 | 6 | 74 | 153 |
| sol-high-2 | 1653 | 6 | 75 | 247 |
| sol-xhigh-1 | 1810 | 11 | 85 | **785** |
| sol-xhigh-2 | 1836 | 11 | 116 | 232 |

## Coverage — the spec's own named test topics

| task | topic | high-1 | high-2 | xhigh-1 | xhigh-2 |
| --- | --- | :-: | :-: | :-: | :-: |
| 3.4 | seven-provider table, discovery URLs, limits, aliases | 5 cases, **no `model_probe.test.ts` at all** | 6 + 4 | **19 + 4** | 4 + 5 |
| 3.4 | per-provider auth headers without leakage | ✗ | ✗ | ✗ (bearer only) | **✓ (table)** |
| 3.4 | concurrent probes | ✗ | ✗ | ✗ | ✗ |
| 4.6 | ~20 React topics with mocked fetch | **✗** | **✗** | **✗** | **✗** |
| 4.7 | Playwright mocked workflows | 1, never run | 2, never run | 4, never run | 1, never run |
| 5.4 | resolver/factory table tests | partial | partial | **✓** | partial |
| 6.6 | handler/orchestrator/frontend regressions | 7 | 7 | **9 (+3 in `apiEndpoints`)** | 4 |
| 7.2 | repository assertion, no `AI_*` reads | **✗** | **✗** | **✗** | **✗** |

**4.6 is unimplemented by all four.** Each replaced the baseline's 17-line
`renderToStaticMarkup` smoke test with a 12–13 line `renderToStaticMarkup` smoke
test. None of 4.6's topics — debounce, abort/supersede, stale-response
suppression, tri-state credential display — is reachable through SSR; they need
a React testing library that is absent from `devDependencies` and that no
candidate added. The behaviour itself *is* implemented (500 ms debounce and
`AbortController` supersession are in `ProviderConfigPage.tsx`); only the tests
are missing.

## Reachability

Production `AI_*` reads: **zero in all four**. The only occurrences repo-wide are
`vi.stubEnv` calls in the unmodified baseline test that proves they are ignored,
plus the historical interview document 7.5 explicitly exempts. But **no candidate
added task 7.2's required repository assertion**, so nothing prevented the reads
coming back. Added in the graft.

## Machine-global safety

Group 3's stopping boundary forbids any test touching the researcher's real
config directory, keyring, provider network, or CLI process. All four inherit
`modelConfigPath(configRoot = envPaths('FREE Studio').config)` and
`dependencies.credentialStore ?? systemCredentialStore` — defaults that fall
through to real machine resources, so safety depends entirely on every call site
injecting a fake.

| candidate | probe-route tests | verdict |
| --- | --- | --- |
| sol-high-1 | none exist | probe route untested |
| sol-high-2 | `createPostModelProbe({ fetch })` — no `configRoot`, no `credentialStore` | **latently unsafe** |
| sol-xhigh-1 | `{ configRoot: await temporaryRoot(), credentialStore: store(), fetch }` | **safe** |
| sol-xhigh-2 | `createPostModelProbe({ probe })` — no `configRoot`, no `credentialStore` | **latently unsafe** |

For high-2 and xhigh-2, `savedCredential()` calls `readModelConfig(dependencies)`
with no `configRoot`, so it resolves the researcher's real
`envPaths('FREE Studio').config`. Those tests pass today only because no such
file exists on this machine; on a configured machine the behaviour changes and
can reach the real keyring. Empirically confirmed for the graft: the full suite
run under a sandboxed `XDG_CONFIG_HOME` and an unreachable D-Bus session writes
nothing and passes identically.

## Architecture

The one real design disagreement is **where the route resolves**. `sol-high-2`
calls `resolveCapabilityRoute()` inside each of the four public handlers
(`chat.ts`, `extract.ts`, `edit_schema.ts`, `generate_schema.ts`) — four call
sites. The other three resolve once inside `_model.ts`. Task 6.1 puts the
orchestration in `_model.ts` ("Refactor `_model.ts` so each operation receives
its one resolved execution target"), and `CLAUDE.md` names `api/_model.ts` as the
orchestration seam, so the single-site design wins; it also keeps domain logic
out of transport glue.

Cross-cutting points:

- `sol-xhigh-1` and `sol-xhigh-2` removed the `vercel` devDependency, the
  `vercel:dev` script and the `.vercel` ignore entry; `sol-high-1` and
  `sol-high-2` kept all three, though hosted/Vercel deployment is an explicit
  non-goal (7.1/7.3).
- `sol-xhigh-2` re-declares `uuidSchema`/`connectionSchema` inside
  `model_probe.ts`, a probe-specific DTO that `review.md` decision **H**
  explicitly deletes in favour of reusing the shared `ModelConnection` parse. It
  also adds a second injection seam (`probe?: ModelProbeFunction`) on top of
  `fetch`, so its route tests stub the whole probe and never exercise discovery
  through the route.
- `sol-high-2` adds `@playwright/test` but no `test:e2e` script, leaving its e2e
  file with no entry point.
- Indentation: the 464 tab-indented lines at baseline lived **only** in the five
  files this change rewrites; every other Studio source file was already
  space-indented. Converting them makes the tree consistent for the first time,
  so no reformatting was applied.

## Decisions taken from the repo, not from the candidates

`review.md` in this change directory is an interview decision log that was **not**
in the run's `spec.artifacts` — no candidate saw it. Its decisions govern:
one shared `ModelConfig`/`ModelConnection` (A); `nuextractRaw?: true` on the
Extraction Route only with `profile` internal (B); flat
`{ provider, baseUrl | null }` plus centralized validation, *not* a discriminated
union (D); store each adapter's exact API base (C); `temperatureSupported`
carried through as a boolean (F); flattened `ProbeResult` with no echoed
`connectionId` (G); full `ModelConnection` in probe requests (H); UI-only
`supportsNuextractRaw` (E); submitted-only credential actions with post-commit
best-effort cleanup (I); partial credential map limited to
`present | absent | unavailable` (J); completed probes always `200` (K);
`studio-model-operation-contract` owning the error envelope (L); no configuration
version field.

The adopted base satisfies all of these. `profile` appears nowhere under
`prototypes/studio/src` in either xhigh candidate; both `high` candidates leak it
only into a test fixture of the internal target, which is acceptable.

## Outcome

**Base: `sol-xhigh-1`, adopted wholesale** — most test code (785 vs
153/247/232), the only genuine provider-table coverage, the only candidate safe
by construction against the real keyring and config directory, one of the two
that removed the Vercel remnants, ADR-complete, and the only one that ticked its
markers.

| graft | from | why |
| --- | --- | --- |
| everything except the items below | sol-xhigh-1 | see above |
| per-provider auth-header assertions in the `probeConnection` table test | sol-xhigh-2 | its `it.each` was the only one checking `x-api-key` / `x-goog-api-key` rather than bearer alone — task 3.4's "auth headers without leakage". Merged into the base's existing table and extended to assert the credential appears in no other header and not in the URL. |
| `configRoot` injected into the last probe-route test | — | the base omitted it on the one case that rejects before reading config. Injected anyway so no test can ever depend on the researcher's real config path being absent. |
| `api/_environment.test.ts` | **nobody** | task 7.2's required repository assertion. Sweeps `api/` and `src/` for the five removed `AI_*` names, skipping test files. Mutation-checked: appending a `process.env.AI_API_KEY` read to `_http.ts` fails it. |
| concurrent-probe test | **nobody** | a named 3.4 topic no candidate covered. |
| `test-results/` and `playwright-report/` in `.gitignore` | — | two candidates left Playwright output untracked in the tree. |

**Taken from nobody, and still open:**

- **4.6** — React tests with mocked fetch. Shipped at candidate parity by
  operator decision; the behaviour is implemented and unverified. Closing it
  needs `@testing-library/react` + `jsdom`.
- **4.7 / 4.8** — the mocked Playwright workflows are carried in the graft but
  have never been executed by anyone, here or in any candidate. They are written
  and *loadable*, not broken: `pnpm exec playwright test --list` parses the
  config and enumerates all four specs. Only the run is missing.
- **7.4** — cannot be ticked while 4.7 is unrun; every other command in it
  (`test`, `lint`, `build`, `git diff --check`) passes.

`4.6`, `4.7`, `4.8` and `7.4` are left unticked in `tasks.md` for exactly these
reasons. Everything else in groups 3–7 is ticked and verified.

## Verification of the graft

```text
pnpm --filter studio test    13 files, 115 tests, all passing
pnpm --filter studio lint    clean
pnpm --filter studio build   tsc -b + vite build, clean
git diff --check             clean
pnpm install --frozen-lockfile --ignore-scripts   satisfied
pnpm exec playwright test --list                  4 tests in 1 file
```

The candidates' `pnpm-lock.yaml` was **not** grafted; the lockfile here was
regenerated from the merged `package.json` and then checked with
`--frozen-lockfile`, so a fresh clone installs without drift.

Plus the 7.5 repository searches (no plaintext browser credential state, no
fabricated catalogs, no `process.env` reads in Studio production code, no stale
instructional `AI_*` documentation) and the machine-global safety sweep above.

## Note on the environment

Running `pnpm` inside a candidate worktree exhausted the disk mid-analysis. Every
candidate modified `pnpm-lock.yaml`, so pnpm's dependency-status check
auto-installs, the root `postinstall` runs `install:python` recursively, and `uv`
builds a fresh `parsing_service/.venv` per worktree — one reached 6.3 GB. Verify
in the real repository, never in a candidate worktree.

The candidate worktrees were not merged, reset, or cleaned; only the `.venv`
directories that those installs created were removed.

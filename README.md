# PR #267 evidence: Article resolution review and live-model comparison

Evidence for [PR #267](https://github.com/HUM-CDCH/FREE/pull/267) (`fix/article-resolution-v12` into `dev`), gathered
by the author's agent session so another reviewer or agent can inspect it. This is an orphan branch that holds evidence
only. It is not meant to be merged. `CONTRIBUTING.md` puts review and validation evidence with the PR, not in `docs/`.

State when pushed (2026-10-14, about 11:25 UTC):

- PR #267 is an open draft at head `d21f99e6`, 7 commits ahead of `origin/dev` and 2 behind (merge base `b607c36a`).
- **The release hold is in force and has not been lifted.** Only the maintainer (@GennaroBaratta) lifts it, by
  recording acceptance on the PR thread.
- Rerun 2 of the comparison (code `d21f99e6`) is running on Baratheon. Its results are not on this branch yet; they
  will be posted on the PR.

## Layout

| Path | What |
| --- | --- |
| `comparison/protocol.md`, `protocol-seal.json` | The comparison as declared, sealed before any model call (code `e4516d3c`) |
| `comparison/amendment-1.md`, `amendment-1-seal.json` | Amendment 1, sealed after the one uncounted pilot and before any counted run |
| `comparison/deviations.md` | The three deviations of run 1 |
| `comparison/results.md` | Run 1 (`e4516d3c`): verdict, measures, adjudication of every dropped item |
| `comparison/rerun-1/` | Rerun 1 (`6b4a2b9b`): protocol, seal, results |
| `comparison/rerun-2/` | Rerun 2 (`d21f99e6`): protocol and seal only; results pending |
| `comparison/harness/` | `run_paper.py` (one paper, one condition) and the amended `schema.json` |
| `comparison/launch/` | `run.sh` (container invocation on Baratheon) and `queue.sh` (one condition over the 12 papers) |
| `comparison/score.py` | Scorer for criteria A1-A4, unchanged across all three runs |
| `review/bundle-632206f4/` | Reviewer's reproduction bundle at `632206f4` (probes, numeric regressions) plus `range_check.py` and its output |
| `review/before-fix.txt`, `review/after-fix.txt` | The 19 committed matching cases at `632206f4` (10 failed, 9 passed) and at `e4516d3c` (19 passed) |
| `withheld.sha256` | sha256 of every file not published here (see the last section) |

Every file under `comparison/` matches the hashes in `protocol-seal.json`, `amendment-1-seal.json` and
`rerun-2/seal.json`. Both resolver snapshots in the review bundle match the Git blob hashes in its README.

## Commits on the PR branch

| Commit | Change | Resolver blob |
| --- | --- | --- |
| `30a6448f` | Retain Article assembly for every failed resolution (originally reviewed head) | `e89bb663` |
| `632206f4` | Show readings where printed, let lists abstain, keep cross-part repeats | `7dece74f` |
| `e4516d3c` | Find a reading's number only where that number is printed | `df1f4810` |
| `14c79566` | Tests and docs only (independent review's nits); resolver unchanged | `df1f4810` |
| `6b4a2b9b` | A list answer names the items to leave out (OTHER or REPEAT); each item is shown whole | `7a343e26` |
| `d21f99e6` | A list answer labels every item OWN, OTHER or REPEAT; an answer missing a label keeps assembly | `5a284de0` |

## Findings

### 1. Deterministic code findings: closed at `e4516d3c`

- At `632206f4` the resolver matched a positive `10` inside `-10`, `−10`, `1e-10` and `.10`. Three such hits could
  fill all three snippet slots, count the value as "printed 4 times", and hide the genuine `10`. The bundle reproduces
  this: `probes.py` passes 10/10 at `632206f4` and 4/10 at `30a6448f`, and `test_numeric_tokens.py` has 5 intended
  failures at `632206f4`.
- The five proposed regressions only checked unwanted matches. `range_check.py` shows that a naive fix, which rejects
  any `-`, `−` or `.` before a number, passes them but stops finding `10` in `pp. 5-10` and `p.10`, and stops finding
  `Smith` in `Jones-Smith`. A fix that counts a sign only where it starts a number gets every case right
  (`review/bundle-632206f4/range-check-output.txt`).
- `e4516d3c` applies number-boundary rules (`NUMBER_START`) only to values that start with a digit; words keep the
  whole-word rule. It also rejects `1e+10`, and `+10` still matches. The committed cases cover range endpoints, `p.10`,
  numeric strings, signed exponents, `210` / `10.5` / `1,100`, `Smith` / `Jones-Smith`, and four end-to-end cases
  where three false hits precede the genuine `10`.
- The maintainer's review independently confirmed the fix against blob `df1f4810`: 10/10 probes, 5/5 numeric
  regressions, 19/19 combined checks, and `+10`.

### 2. Why release is held

The production caller does not pass `resolve_parts`, and nothing turns resolution off. Long documents are split
into parts automatically, so resolution runs on every long document by default. The hold was chosen over a
default-off opt-in ([hold comment](https://github.com/HUM-CDCH/FREE/pull/267#issuecomment-6165056541)). Nothing on
the branch changes this.

### 3. Live-model comparison

Setup: 12 annotated collagen articles (6 held-out `H1`-`H6`, 6 dev articles re-parsed at 360 dpi). Two conditions:
N uses NuExtract3-FP8 for fields and Qwen3.8-27B-NVFP4 for reasoning; Q uses Qwen for both. Parts are 12,288 tokens.
There is one execution per paper and condition, with no best-of-N. Assembly alone and resolution are captured from
the same part readings. Every criterion must hold in both conditions.

| Run (code) | N | Q | Verdict |
| --- | --- | --- | --- |
| Run 1 (`e4516d3c`) | A1-A4 pass | A1 fail: 1 of 13 covered gold rows lost | not accepted |
| Rerun 1 (`6b4a2b9b`) | A1 fail: 5 of 14 lost; A3 fail: 2 of 2 multi-part rows lost | A1-A4 pass | not accepted |
| Rerun 2 (`d21f99e6`) | pending | pending | pending |

PR comments: [run 1](https://github.com/HUM-CDCH/FREE/pull/267#issuecomment-6165924774),
[rerun 1](https://github.com/HUM-CDCH/FREE/pull/267#issuecomment-6166919663).

- **Scalars are safe in every run.** Resolution recovered own title, DOI and year values from assembly's
  null-on-conflict and lost none. Own values went from 27 to 31 of 36 for N in both runs, 22 to 31 for Q in run 1,
  and 19 to 31 for Q in rerun 1. No unopposed own scalar was set to null by `NONE` (A4).
- **Lists fail by whole-item keep or drop.** Resolution never merges two differently filled readings of the same
  sample. When a second reading in another part carries printed values that the kept copy lacks, dropping it loses
  them: the redfish imino totals 16.5% and 16.0% (both conditions in run 1, Q in rerun 1) and the Baltic cod backbone
  hydroxyproline 6.4% of dry weight (Q in both runs). A1-A4 do not count these losses.
- **Rerun 1's N failure.** The leave-out answer of `6b4a2b9b` was used as its opposite. On H4 (barracuda) the model
  labelled OTHER exactly the 12 own items its run-1 answer had kept, and on H1 the same happened to 2 items. That led to
  `d21f99e6`'s label-every-item form.
- **Contamination kept.** N kept cited Baltic cod skin items: Sadowska et al. 2003 in both runs, and Tylingo
  (unpublished) in run 1. The criteria do not measure this.
- **The model setup is not compared.** Under assembly alone, Q has fewer own values than N (19-22 against 27 of 36
  scalars; 51 against 77 items in run 1). Both reach 31 of 36 after resolution. The comparison shows whether
  resolution is safe in each setup, not which setup to ship.

## Checks run

From `apps/parsing_service` unless stated.

| Head | Check | Result |
| --- | --- | --- |
| `632206f4` | `uv run --no-sync pytest -q -p no:cacheprovider tests/test_article_resolution.py -k "found_where_it_is_printed or never_displace or whole_number" -rA` | 10 failed, 9 passed (intended) |
| `e4516d3c` | Same 19 cases | 19 passed |
| `e4516d3c` | `uv run --no-sync pytest -q -p no:cacheprovider -m "not postgres and not live_model" tests/test_article*.py` | 89 passed |
| `e4516d3c` | Six-file resolution set | 175 passed (157 at `632206f4`) |
| `e4516d3c` | `uv run --no-sync pytest -q -p no:cacheprovider -m "not postgres and not live_model"` | 1,643 passed, 62 skipped |
| `14c79566` merged with `dev` `7d246891` | `pnpm typecheck`, `pnpm lint`; parsing fast tier; scripts, studio-configuration, db, extraction, extraction-result-export; Studio `vitest run --maxWorkers=2` | all pass; parsing 1,645 passed, 62 skipped; Studio 2,119 passed, 3 skipped |
| `d21f99e6` | `uv run --no-sync pytest -q -m "not postgres and not live_model" -p no:cacheprovider` | 1,655 passed, 62 skipped |

Never run at any head: the Postgres and live-model pytest tiers. No merged-result checks have run at `6b4a2b9b` or
`d21f99e6`. The same session observed the new list tests failing on `6b4a2b9b` and passing on `d21f99e6`; that log
is not on this branch.

## Open points

1. **Rerun 2 verdict (pending).** Code `d21f99e6` runs on Baratheon in `/tmp/free-pr267-rerun2/out`. At about
   11:13 UTC, N had 4 of 12 papers done and Q had 7. It will be scored with `score.py` unchanged and posted on the PR.
   It is declared as the last fix-and-rerun cycle without a maintainer decision.
2. **Lifting the hold is the maintainer's decision.** Rerun 2 is the third execution on the same 12 papers, and both
   list fixes were designed from what earlier runs dropped there. A pass shows that the observed failures did not
   recur, not that resolution generalizes. A confirmation on papers outside this corpus is recommended before
   default-on release.
3. **Printed values on dropped second readings.** The redfish imino totals and Baltic cod hydroxyproline losses are
   not counted by A1-A4 and recurred in both completed runs. Decide whether this needs a criterion, or a design change
   (such as merging differently filled readings of one sample) before default-on.
4. **Kept contamination.** Cited items that stay (the Baltic cod skin items) are not measured by any criterion.
5. **Model setup.** Choosing N or Q is a separate decision that this comparison does not settle (finding 3, last
   point).
6. **No variance estimate.** The live servers are not deterministic at temperature 0, and each paper ran once per
   condition. Differences between runs mix reading variance with the code change.
7. **Gold not signed off.** The dev gold is blind-corrected; the held-out gold was model-drafted by two blind agents.
   Both await human sign-off.
8. **Part size.** The comparison used 12,288-token parts. Production falls back to 32,768 tokens, so it would split
   these papers into fewer parts.
9. **Review coverage.** The independent review
   ([comment review](https://github.com/HUM-CDCH/FREE/pull/267#pullrequestreview-5516075182), at `14c79566`) was
   posted as COMMENTED because the author account cannot approve its own PR. `6b4a2b9b` and `d21f99e6`, which change
   list resolution, have had no independent review. `CONTRIBUTING.md` asks for a review before merging into `dev`.
10. **Merge readiness.** The branch is 2 commits behind `dev`; a scratch merge at `14c79566` had no conflicts. PRs into
    `dev` run no CI, so the merged-result checks above need rerunning at the final head with the then-current `dev`.
11. **Studio timeouts (outside this PR).** The default aggregate `pnpm test` stopped on 5-second timeouts in unchanged
    Studio tests (`api/_pdf_pages.test.ts`, `server/workflows.test.ts`, `ProviderConfigPage.test.tsx`) under load.
    They pass alone or with `--maxWorkers=2`. Not investigated.

## Not published here

The repository is public, so these stay off this branch. `withheld.sha256` lists the sha256 of each:

- Raw captures of all runs (`captures/`, `rerun-1/captures/`, `pilot/`). Each holds long excerpts of the source
  articles, which are third-party publications, in its resolution prompts.
- Per-paper scores (`report.json`, `rerun-1/report.json`), which are built from gold rows.
- The gold that `score.py` reads (`ablation-20261007/gold/gold_heldout.json`, `gold/gold_dev_corrected.xlsx`,
  `run-dev-b1prime/extractor-config.json`). Publishing the held-out gold would spend it.

Where they are: on the maintainer's machine under the gitignored `artifacts/pr267-resolution-comparison/` and
`artifacts/ablation-20261007/`, and on Baratheon under `/tmp/free-pr267-comparison/`,
`/tmp/free-pr267-rerun1/` and `/tmp/free-pr267-rerun2/` (temporary, not durable). The H1/Q pilot named in
`deviations.md` was copied from Baratheon into the local `pilot/`. An agent with access to those locations can check
them against the hashes and rerun `score.py`.

## Reproduce

- Review bundle (needs `jsonschema` and `requests`; the parsing service venv has both): `cd review/bundle-632206f4`,
  then `python probes.py`, `python probes.py --baseline`, `python -m pytest -q test_numeric_tokens.py` and
  `python range_check.py`.
- Comparison: `launch/run.sh` runs `harness/run_paper.py` in the `free-parsing_worker` image with the PR source
  mounted read-only at `/app/src`, the corpus at `/abl`, and the live vLLM servers on the `free_app` network.
  `launch/queue.sh CONDITION` runs one condition over the 12 papers. `python score.py OUT_DIR REPORT.json` scores a
  run; it reads the gold from `ablation-20261007/` beside the comparison folder.

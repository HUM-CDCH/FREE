# Unified Catalog discovery: speed and boundaries (loop brief)

Start: `/loop follow /home/gebbaro/Progetti/FREE/.claude/worktrees/unify-catalog/docs/plans/2026-09-29-unified-discovery-loop/README.md`

Work only in `/home/gebbaro/Progetti/FREE/.claude/worktrees/unify-catalog`
(branch `feat/unify-catalog-extraction`), never in the main checkout. Each tick:
read this file and `log.md` next to it, do one step of the protocol, append to
`log.md`, schedule the next tick.

## Why

On the DGX Spark (2026-09-29, `openspec/changes/unify-catalog-extraction/implementation.md`
§ "On the DGX Spark") the unified Catalog got the 4-entry `continuations`
catalogue right. On the rev-8 200-entry `big` catalogue it failed in two ways
(`measure.py --rescore` of the saved result):

| | Legacy recipe (`chunks=4`) | Unified (`chunks=4`, deployment routing) |
| --- | --- | --- |
| Whole run | 105.7 s | 5,556 s (≈ 52×) |
| Discovery | — | 11 Qwen calls, 5,004 model-s, sequential; 5 replies cut off at the 4,096-token reserve and halved; 35,765 output tokens, 15.3k of them in the 6 kept replies |
| Entries | 200 | 251: all 200, plus 51 one-item find lists (`1. Scherben.`) split off as records; ends of 89, 114, 189 unresolved |
| Values of the 200 | right | `site_name` 196 right, 4 empty; `fundart` 200; 0 wrong accepted |

Causes seen so far:

1. **Tokens per place.** The kept replies spent 50.6 output tokens per place
   (302 places). Small windows wrote more than they read (1,656 in → 3,008 out;
   1,621 → 2,345). So the reply's shape or whitespace, not the number of
   places, looks like the dominant cost. At the Spark's ≈ 7.8 generated
   tokens/s (Qwen, thinking off), 15k tokens take ≈ 1,950 s sequentially and
   still ≈ 500 s at 4-way parallel. G2 is unreachable without fewer tokens
   per place.
2. **Reply-blind windows.** `discovery.plan` packs a window to the input
   ceiling (28,672 tokens) and ignores the reply: one window held the whole
   11.5k-token catalogue. A cut-off reply is discarded whole and the window
   halved, so minutes of generation are thrown away, repeatedly.
3. **Sequential windows.** Discovery windows run one at a time, although each
   reply is independent until `_assemble`.
4. **Inconsistent starts.** Whether a nested numbered line (`1. Scherben.`)
   starts a record is left to each window, and windows disagree. Where the 51
   came from (which windows, and how big) is not yet known.

Full result: `~/free-unify-evidence/big-default.json` on the Spark.

## Gates

These numbers are proposals from the 2026-09-29 session, not from
`design.md`; the user may change them. Tune on `big`. The holdout (below) is
written and committed before any method change, and is never tuned on.

| Gate | Metric (from `measure.py`) | `big` target | holdout target |
| --- | --- | --- | --- |
| G1 boundaries | `found`, `false_entries`, `duplicated`, `unresolved_ends` | 200, none, none, ≤ 2 | all, none, none, ≤ 2 |
| G2 speed | discovery `cut_off`, `discovery_wall_s`, `seconds` | 0, ≤ 300 s, ≤ 900 s | reported |
| G3 values | `score` `WRONG`; `site_name`/`fundart` `right` | 0; ≥ 195 each | 0 wrong |
| G4 regressions | local tests, Spark live test, legacy goldens | all pass, byte-identical | — |

A step **moves a gate** when it improves that gate's metric, even if the
target is not yet met. Discovery going from 5,000 s to 600 s moves G2.

Hard rules (from `design.md` and the spec; breaking one fails the step):

- No recipe, language, numbering-convention or field-name rules in the
  method. A regex for `\d+\.` is not allowed. A convention the model derives
  from this document and passes on is this brief's reading of the design, not
  settled: ask the user before relying on it.
- Every nonblank character keeps exactly one ledger disposition; nothing is
  clipped; an unreported tail is `unresolved`, never assumed record-free.
- Acceptance and verification rules do not widen. Heading-context values
  (`bezirk`, `kreis` empty in every record) are **out of scope**: the spec says
  heading context "SHALL NOT silently become a field binding". Record the
  options for the user and change nothing. The 133 `bezirk`/`kreis`
  `type_mismatch` rejections may be investigated as a possible bug.
- Admitted work stays reproducible. If the discovery prompt, the reply shape
  or the window plan changes, bump `discovery.VERSION` or `PROMPT_VERSION`,
  so a published record is never reused under new semantics. `DEFAULTS[1]`
  values are pinned: a new defaults version touches Studio and
  `packages/extraction`, so stop and ask before doing that.

## Tick 1 (setup and offline analysis, no GPU)

1. Commit by explicit path, never `commit -a`:
   - `prototypes/parsing_service/tests/test_unified_catalog_live.py`;
   - `openspec/changes/unify-catalog-extraction/implementation.md`, which
     holds the Spark evidence;
   - this folder.
2. Write the holdout generator `holdout.py:holdout` in this folder, returning
   `{case, schema, truth}` (see `measure.py`). Use a different record marker
   (e.g. unnumbered `◆ Name.` or `Nr. 12 –`) and multi-item nested numbered
   lists (`1. … 2. … 3. …` on their own lines), under headings, in two
   columns, with at least 150 records. Commit it. No baseline run: the
   unchanged method would exceed the timeout.
3. From `big-default.json`, map the 51 false entries to their discovery
   windows: size, depth of halving, context shown. This tells you whether
   smaller windows help or hurt G1.
4. Capture one raw discovery reply. Raw replies are not stored, so make one
   direct call on a small `big` window through the same client, in the
   container. See where the 50 tokens per place go.
5. Rank the hypotheses below from 3 and 4, and log the ranking.

## Hypotheses (starting order; re-rank after tick 1)

1. **Fewer tokens per place.** Compact reply JSON without losing the
   exact-text check or labels: no whitespace, derivable fields dropped,
   shorter keys. This is the biggest lever for both speed and cut-offs.
2. **Parallel discovery.** Ask up to `chunks` windows at once; keep reply
   order, the write-once record and the pairwise continuation rule.
3. **Reply-aware windows.** Keep a window's expected reply
   (`places × tokens/place`, estimated from its text or the first reply)
   under the reserve. After a cut-off, shrink the remaining plan rather than
   only halving that window. This may hurt G1 if small windows caused the 51.
4. **Keep a cut-off reply's complete prefix.** Accept places up to the last
   fully reported line and re-ask from that line; never infer the tail.
5. **Consistent starts.** Show each window how records begin in this
   document, for example the previous window's last few accepted starts as
   examples. See the hard rule on document-derived conventions.

## Protocol (every later tick: one step)

1. Read `log.md`. If a Spark run is in flight, check it and only record its
   result. Never start a second GPU run.
2. Take the highest-ranked open hypothesis. Check it against existing
   evidence before coding.
3. Make the smallest change, with a scripted-model test in
   `tests/test_unified_catalog.py` that fails without it. From the worktree's
   `prototypes/parsing_service`, run
   `PYTHONPATH=$PWD/src:$PWD /home/gebbaro/Progetti/FREE/prototypes/parsing_service/.venv/bin/python -m pytest -q -m "not postgres and not live_model"`.
   Commit it locally on the branch, by explicit path.
4. Measure on the Spark (below): `big` every step, and the holdout for a step
   you would keep. Add a row to `log.md`: commit, `measure.py` numbers, and
   one line of why.
5. Keep the step if it moves a gate and regresses none. Otherwise
   `git revert` it and log why.
6. Schedule the next tick. While a Spark run is going, the background task
   wakes you, with a 1,800 s `ScheduleWakeup` as fallback; otherwise 60 s.

Stop (`ScheduleWakeup` with `stop: true`) and report to the user when:

- every gate passes. Write the final numbers into `implementation.md`, then
  report the commits and gates;
- four steps in a row move no gate;
- a fix needs a spec or design change, a new defaults version, a new
  dependency or a production change. Report the options with evidence.

Never push, never touch production containers or `~/Projects/FREE` on the
Spark, and never delete evidence.

## Spark

- `ssh baratheon` works non-interactively. Node needs
  `export PATH=$HOME/.nvm/versions/node/v24.21.0/bin:$HOME/.local/bin:$PATH`.
- `~/free-unify` is a disposable test clone. To ship the branch:
  1. `git bundle create <your scratchpad>/u.bundle 80686ec4..HEAD`
  2. `scp` it to the Spark's `/tmp/`
  3. `git -C ~/free-unify fetch /tmp/u.bundle HEAD && git -C ~/free-unify reset --hard FETCH_HEAD`
- `~/free-unify-run.sh` is `run.sh` in this folder. It starts a throwaway
  container `free-unify-LABEL` of the production `free-parsing_worker` image
  on `free_app`, with the clone's `src` mounted over `/app/src`, pytest from
  `~/free-unify-deps`, and results in `~/free-unify-evidence` (`/out`).
- Before each run, check that both servers are idle and record it:
  `docker exec free-parsing_worker-1 python -c "import urllib.request as r; print([l for l in r.urlopen('http://extraction_model:8000/metrics').read().decode().splitlines() if l.startswith('vllm:num_requests_')])"`
  and the same for `nuextract_model`.
- Measure with deployment routing and `chunks=4`, as production runs. Put
  the timeout on the Spark side, and start it from a background Bash call:
  `ssh baratheon 'timeout 2400 ~/free-unify-run.sh big-T /repo/docs/plans/2026-09-29-unified-discovery-loop/measure.py big-T big - 4; s=$?; docker rm -f free-unify-big-T >/dev/null 2>&1; echo EXIT $s'`
  A timeout (`EXIT 124`) counts as a G2 fail.
- Rescore a saved result (no GPU):
  `~/free-unify-run.sh rescore /repo/docs/plans/2026-09-29-unified-discovery-loop/measure.py --rescore /out/big-T.json big`.
- Live test: `~/free-unify-run.sh live -m pytest -q -s -p no:cacheprovider tests/test_unified_catalog_live.py`.
- Never print container environments: the worker's database URL holds a
  password.
- Every run of this loop spends shared production Qwen time. Researchers use
  the same servers.

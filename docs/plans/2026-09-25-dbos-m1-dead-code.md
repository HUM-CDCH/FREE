# DBOS M1: Dead Code Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Status: **in progress, reviewed 2026-09-25 against `chore/dbos-m1-dead-code` at `8bd3015` plus its working changes.**

## Remaining review work

Tasks 1–8 are committed, including diagnostics filtering, checkpoint removal, the legacy RUNNING-row test and the RUNNING API read test. Task 9's direct NuExtract fetch is already in the working tree, with its request/abort tests retained. Do not reimplement these. The original steps below remain the implementation record; this checklist supersedes their corresponding instructions.

- [ ] **Catalog action (Task 6 follow-up):** in `App.tsx` → `RightRail.tsx` → `ResultsTab.tsx`, name the current toolbar strategy (`Run Article extraction` / `Run Catalog extraction`) and show the selected Catalog recipe or `Model discovery`. Keep the fresh-run handler and current-schema behavior. Extend `App.test.tsx` to check the next POST after Catalog success/failure and reopening, including selecting a recipe again. No new retry API, persisted state or dialog.
- [ ] **Missing legacy cases (Tasks 7–8 follow-up):** extend the existing PostgreSQL checkpoint test to FAILED with a valid failure; extend the existing API read test to FAILED. Add a completed API read with legacy `diagnostics.retry: null`. Require 200 and the strict response contract, with job values null and failure/result preserved as appropriate. Keep these deliberate legacy fixtures during residue checks; the reader implementation is already present.
- [ ] **Finish Task 9 in progress:** review the direct-fetch change and run the retained `_model.test.ts` request/authorization/body/abort assertions and Studio build. Do not add another transport or live-provider harness.
- [ ] **Close Task 10 with evidence:** reuse valid existing logs; run only missing/failing tiers or those affected by subsequent changes. Before merge, record the tested commit, commands, results and skips for the deterministic tiers, including the rewritten real-service spec and Python smoke. Both need Docling weights and disposable PostgreSQL; the e2e harness starts its scripted model server and the smoke needs none. Run required tiers elsewhere if necessary; collection/typecheck is not a pass. Report additional live-model gaps separately.

Deployment still requires the operator precondition below. Separate task commits help review, but rollback must include dependent tasks in reverse order or M1 together.

**Goal:** Remove the code that M1 of the DBOS plan identifies as having no production caller, with no schema change, as one PR that can merge before M2.

**Architecture:** Each task deletes one dead feature end to end: its route or handler, its types and contract, its UI, its tests and the documentation that names it. The parsing-service tasks run in an order that keeps every surviving route intact, because deleted routes share private helpers. Tests that must survive are rewritten to read the page result, disk or surviving routes directly. Each task ends green on its own test tier.

**Tech Stack:** Studio (TypeScript, React, Vite, Zod 4, Vitest, Playwright), `packages/extraction` (TypeScript, `tsx --test`, Prisma Next), the Parsing Service `kei_exp` (Python 3.13, FastAPI, pytest, uv).

**Spec:** [docs/plans/2026-09-24-unified-durable-execution.md](2026-09-24-unified-durable-execution.md), section *Milestones → M1*. Read that section before starting; this plan argues from it.

## Global Constraints

- **Branch:** create `chore/dbos-m1-dead-code` from `feat/kei-exp-parser`, in a worktree (superpowers:using-git-worktrees). The PR base is `feat/kei-exp-parser`, which is 499 commits ahead of `main`.
- **No schema change:** do not touch any migration, `packages/db/src/prisma/contract.prisma` or `contract.d.ts`. The columns that the removed code read or wrote stay until M2's baseline: `retryOfId`, `retryDocument`, `rediscover`, `retryRecordStartBlockIds`, and ExtractionJob's `complete`, `modelAttribution`, `diagnostics` and `resultPayload`. They are all nullable, so creates can omit them.
- **Do not churn code M3 deletes:** keep `kei_exp/jobs/` as it is (`store.records`, `store.extractions_of`, `store.events_after`, `EVENT_PAGE`, `tokens.read_after`, `DurableEmit`, and their comments). Also keep `runs.summary`, `runs.is_legacy` and the other file-only projections in `runs.py` except `logged_events` and `replay`.
- **Surviving Parsing Service routes** (Studio production uses them; never delete or rename): `GET /api/models`, `GET /api/extraction-models`, `POST /api/runs`, `GET /api/runs/{id}`, `GET …/result`, `GET …/pages/{n}`, `POST …/extract`, `GET …/extractions/{xid}`.
- **No compatibility aliases** for removed request shapes or fields (spec, M4 "no compatibility aliases" applies here too).
- **Python:** run everything from `prototypes/parsing_service` with `uv run --no-sync …`. Lint touched files with `uvx ruff check <files>`. `src/kei_exp/transcription/native.py`, `tests/test_result.py` and `tests/test_table_cells.py` already have 4 ruff findings; they are out of scope.
- **Test tiers:**
  - Parsing fast: `uv run --no-sync pytest -q -m "not postgres and not live_model"`.
  - Parsing Postgres: `uv run --no-sync pytest -q -m "postgres and not live_model"` with `PARSING_TEST_DATABASE_URL` exported.
  - Studio: `pnpm --filter studio typecheck`, `pnpm --filter studio lint`, `pnpm --filter studio test`.
  - Extraction: `pnpm --filter extraction typecheck`, `pnpm --filter extraction test`, and for Postgres `pnpm --filter extraction test:postgres` with `EXTRACTION_TEST_DATABASE_URL` exported and migrated.
- **Disposable databases only:** user `postgres`, loopback host, explicit port 5432, database `free_test_*`; the guards refuse anything else. One way to get one:
  ```bash
  docker run --rm -d --name free-m1-pg --mount type=tmpfs,destination=/var/lib/postgresql/data \
    -p 127.0.0.1:5432:5432 -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=m1-disposable-only \
    -e POSTGRES_DB=free_test_parsing postgres:17
  docker exec free-m1-pg createdb -U postgres free_test_extraction
  export PARSING_TEST_DATABASE_URL=postgresql://postgres:m1-disposable-only@127.0.0.1:5432/free_test_parsing
  export EXTRACTION_TEST_DATABASE_URL=postgresql://postgres:m1-disposable-only@127.0.0.1:5432/free_test_extraction
  DATABASE_URL=$EXTRACTION_TEST_DATABASE_URL pnpm --filter db db:init   # the extraction tier needs a migrated database
  ```
  Check that port 5432 is free first; never stop another service to free it. The commands below assume both
  variables are exported.
- **Commits:** one per task, conventional prefix (`refactor:`/`test:`/`docs:`), message ending with the session's attribution line. Never `git stash`, `reset` or `commit --amend` another task's work.
- **Deployment precondition (Task 6):** block new Extraction submissions, cancel/drain legacy retry jobs with the old code, and wait for terminal status. Stop the old Studio processes before the final SQL check; keep admission blocked until the new code is running. After Task 6, `claim()` would interpret these rows as fresh work:
  ```sql
  select count(*) from "extractionJob"
  where "retryOfId" is not null and "executionStatus" in ('QUEUED', 'RUNNING');
  ```
  Require zero before starting the new Studio worker; a cancellation request alone is insufficient. M1 can deploy before M2's clean-slate reset.

## User decisions for this plan (2026-09-25)

- **Delete the LLM inspector.** This supersedes the 2026-08-28 restore in 5187dfe ("Contract amendment by the researcher"). The CLI providers restored in the same commit stay.
- **Checkpoints:** delete the dead checkpoint code and the provisional-results UI. Move `openspec/changes/preview-extraction-before-grounding/` to the archive as superseded, **without** syncing its specs into `openspec/specs/`.
- **Failed Catalog attempts get the generic Rerun/Retry** once targeted retry is gone.

## Review Focus

1. **A deleted Parsing Service route still has a non-test caller outside `src/` and `tests/`** (nginx templates, Vite proxy, Compose healthchecks, scripts, docs with curl examples). That would be a production 404. Tasks 1–5 each end with a repository-wide residue grep, not only a grep of the package.
2. **`/api/models` becomes the only readiness and health probe** (the Compose healthcheck already uses it, and Task 2 moves the e2e boot probe to it), but nothing tests it. It must answer while the store is down. Task 4 adds that test.
3. **Rows written before e88b08f** can hold checkpoint values on RUNNING or FAILED jobs. After Task 8 they must still read, with no values, instead of failing the stricter contract with a 500. Task 8 adds a Postgres integration test that plants such a row.
4. **A stale browser tab** that still posts the old targeted-retry body must get 422 `invalid_request`, never a 500 or a fresh run. Task 6 replaces the retry-mapping test with that test.
5. **A failed Catalog attempt must still offer a rerun in the Results tab**, now that the targeted retry controls are gone. Task 6 adds that test.

---

## Parsing Service (`prototypes/parsing_service`)

Run order matters here. `run_page_boxes` uses `_committed` and `runs.logged_events` from the event stream, so Task 1 removes it before Task 2 removes the stream.

### Task 1: Delete the page preview and page-box routes

**Files:**
- Delete: `src/kei_exp/boxes.py`
- Modify: `src/kei_exp/api.py`. At 054c9e4:
  - imports: 29 (`page_geometry`), 32 (`publish`), 41 (`PageSource`, `RenderablePage`);
  - `PREVIEW_DPI`/`MAX_PREVIEW_DPI` 52-53, `_requested_page` 56-61, `render_page` 64-77;
  - routes `run_page` 438-442 and `run_page_boxes` 454-470.
- Modify: `tests/test_pages.py`, `tests/test_api_jobs.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `api.py` no longer defines `render_page`, `run_page` or `run_page_boxes`. `_committed` and `runs.logged_events` still exist, and Task 2 removes them.

- [ ] **Step 1: Make the four geometry tests read the page result directly**

  In `tests/test_pages.py`, replace the body of `test_the_page_result_names_the_pdf_page_its_two_units_and_their_crops` with:

  ```python
      # The page result names the PDF page, its two units and their crops, with the crops of the right page on the
      # spread past the gutter.
      result = page_file(converted.result_dir, 1)
      assert [unit["index"] for unit in result["units"]] == [1, 2]
      crops = [(crop, unit["index"]) for unit in result["units"] for crop in unit["crops"]]
      assert [(crop["crop"], unit) for crop, unit in crops] == [(1, 1), (2, 1), (3, 2), (4, 2)]
      assert len(result["segments"]) == 4
      third = crops[2][0]  # the first crop of book page 2, on the spread
      assert 594.2 < third["bbox_pt"][0] < 700, third
  ```

  In `test_a_block_of_a_column_crop_is_placed_through_the_crop_transform_and_the_placement`, replace these two lines:

  ```python
      block = page_geometry(1, SPREAD_PT, result, [])["blocks"][2]["bbox"]
      assert block == segment["bbox_pt"]  # the viewer's block is the page file's box
  ```

  with:

  ```python
      block = list(segment["bbox_pt"])
  ```

  In `test_a_page_range_names_spreads_and_selects_their_book_pages`, replace the last three lines with:

  ```python
      result = page_file(two_spreads.result_dir, 2)
      assert [(crop["crop"], unit["index"], crop["kind"]) for unit in result["units"] for crop in unit["crops"]] == [
          (1, 3, "page"), (2, 4, "page")]
  ```

  In `test_a_whole_page_block_is_placed_through_the_recorded_transform_and_the_placement`, replace everything from `geometry = page_geometry(...)` to the end of the `for` loop with:

  ```python
      assert [unit["index"] for unit in result["units"]] == [3, 4]
      for unit, segment in zip(result["units"], result["segments"], strict=True):
          (crop,) = unit["crops"]
          assert (segment["unit"], segment["crop"], segment["bbox_px"]) == (unit["index"], crop["crop"], [10, 20, 30, 40])
          print("ROTATION2", unit["index"], crop["bbox_pt"], crop["image_px"], crop["pt_per_px"], segment["bbox_pt"])
          assert close(segment["bbox_pt"], placed(two_spreads.book, unit, crop, segment)), (segment, crop)
  ```

- [ ] **Step 2: Run the four tests; they pass while `page_geometry` still exists**

  Run: `uv run --no-sync pytest -q tests/test_pages.py -k "units_and_their_crops or column_crop or page_range_names or whole_page_block"`

  Expected: 4 passed. These tests need the CPU layout model. If pytest deselects them as `live_model` on this host, record that in the task report; Task 10's live-model run covers them.

- [ ] **Step 3: Delete the preview tests and the viewer wording**

  In `tests/test_pages.py`:
  - delete `test_a_run_over_book_pages_previews_its_spreads` and `test_page_two_of_a_one_spread_pdf_is_404`;
  - delete `from kei_exp.boxes import page_geometry`;
  - in the module docstring, replace "and the API's previews and geometry of a run over book pages" with "and the API's summary of a run over book pages";
  - replace the comment above the `api_run` fixture with `# The API: a run over book pages counts its PDF pages (the spreads); there is no page unit in the summary.`

  Keep the `api_run` and `run` fixtures: `test_the_summary_counts_pdf_pages_and_has_no_page_unit` and the store tests below still use them.

  In `tests/test_api_jobs.py`, delete the three `test_run_page_boxes_*` tests (454-514 at 054c9e4).

- [ ] **Step 4: Delete the routes, helpers and module**

  In `src/kei_exp/api.py`:
  - delete `PREVIEW_DPI`, `MAX_PREVIEW_DPI`, `_requested_page`, `render_page`, `run_page` and `run_page_boxes`;
  - make the imports `from kei_exp.files import load_dotenv` and `from kei_exp.pages import PdfPages`;
  - delete `from kei_exp.boxes import page_geometry`.

  Then `git rm src/kei_exp/boxes.py`.

  A request for `/api/runs/{id}/pages/1.png` now reaches `run_page_result` and answers 422, because `1.png` is not an integer. That is expected.

- [ ] **Step 5: Verify**

  ```bash
  grep -rnE "page_geometry|render_page|run_page_boxes|kei_exp\.boxes|PREVIEW_DPI|_requested_page" src tests
  grep -rnE "pages/[^ ]*\.png|/boxes\b" ../../prototypes/studio ../../docker ../../compose*.y*ml ../../scripts ../../docs/architecture --exclude-dir=node_modules
  uvx ruff check src/kei_exp/api.py tests/test_pages.py tests/test_api_jobs.py
  uv run --no-sync python -c "import kei_exp.api"
  uv run --no-sync pytest -q tests/test_pages.py
  uv run --no-sync pytest -q -m "not postgres and not live_model"
  ```

  Expected:
  - both greps print nothing;
  - ruff prints `All checks passed!`;
  - the import succeeds;
  - the two pytest runs pass (or report deselected live-model tests, as in Step 2).

- [ ] **Step 6: Commit**

  ```bash
  git add -A src/kei_exp tests/test_pages.py tests/test_api_jobs.py
  git commit -m "refactor(parsing): remove page preview and page-box routes"
  ```

### Task 2: Delete the run list and the event stream

**Files:**
- Modify: `src/kei_exp/api.py`. At 054c9e4:
  - `list_runs` 265-276;
  - `_same_input`, `_position`, `_committed`, `_cursor`, `sse` 301-335;
  - `run_events` 338-408;
  - imports `asyncio`, `AsyncIterator`, `Header`, `run_in_threadpool`, `StreamingResponse`, `tokens`, `Event`;
  - the module docstring.
- Modify: `src/kei_exp/runs.py` (`logged_events` 180-193, `replay` 196-209, imports `Iterator` 18 and `Event` 25)
- Delete: `tests/test_api_tokens.py`, moving one test to `tests/test_jobs_batching.py`
- Modify: `tests/test_api_lifecycle.py`, `tests/test_api_jobs.py`, `tests/test_service_smoke.py`, `../studio/e2e/realService.ts`, `README.md`

**Interfaces:**
- Consumes: Task 1 has removed `run_page_boxes`, the other user of `_committed` and `logged_events`.
- Produces: no `GET /api/runs` list and no `…/events`. The e2e boot probe uses `/api/models`.

- [ ] **Step 1: Keep the token-reader test, without the stream fixture**

  Add `import json` to the imports of `tests/test_jobs_batching.py` (it already imports `tokens`), then append:

  ```python
  def test_a_partial_file_line_waits_for_its_newline(tmp_path):
      path = tmp_path / "tokens.jsonl"
      line = json.dumps({"type": "token", "page": 1, "text": "é", "seq": -1}, ensure_ascii=False).encode()
      path.write_bytes(line[:-3])
      assert tokens.read_after(path, 0, -1) == ([], 0)
      with path.open("ab") as file:
          file.write(line[-3:] + b"\n")
      read, offset = tokens.read_after(path, 0, -1)
      assert read[0]["text"] == "é" and offset == len(line) + 1
  ```

  Run: `uv run --no-sync pytest -q tests/test_jobs_batching.py -k partial_file_line`. Expected: 1 passed.

  Then `git rm tests/test_api_tokens.py`: every other test in it drives `/events`.

- [ ] **Step 2: Reduce the lifecycle tests to surviving routes**

  In `tests/test_api_lifecycle.py`, replace `test_durable_reads_are_unavailable_not_failed` (with its `parametrize`) and `test_unknown_directory_is_not_a_failed_legacy_run` with:

  ```python
  def test_durable_reads_are_unavailable_not_failed(directory, monkeypatch):
      monkeypatch.setattr(store, "record", unavailable)
      response = TestClient(api.app).get("/api/runs/run-live")
      assert response.status_code == 503
      assert response.headers["retry-after"]
      assert runs.UNRECORDED not in response.text
      assert runs.summary(directory) is None


  def test_unknown_directory_is_not_a_failed_legacy_run(directory, monkeypatch):
      monkeypatch.setattr(store, "record", lambda _: None)
      assert TestClient(api.app).get("/api/runs/run-live").status_code == 404
  ```

  In `test_identifiable_legacy_runs_remain_readable`, delete the last two lines (the `/events` request and its assertion).

  Delete these four tests:
  - `test_sse_database_reads_leave_the_event_loop_free`;
  - `test_completion_between_event_and_state_reads_replays_the_committed_event`;
  - `test_a_finish_stamp_alone_never_closes_with_running`;
  - `test_midstream_outage_does_not_emit_a_terminal_status`.

  Remove the now-unused imports `asyncio`, `threading`, `from datetime import UTC, datetime` and `from types import SimpleNamespace`. Make the docstring `"""Outage and legacy-run reads, without a database or model server."""`

- [ ] **Step 3: Reduce the Postgres API tests to surviving routes**

  In `tests/test_api_jobs.py`:
  - Delete `test_a_historical_file_only_run_is_still_listed_and_replayed`, `test_events_stream_stops_without_inventing_a_missing_status_event` and `test_the_event_stream_delivers_a_history_longer_than_one_page`.
  - `test_read_routes_survive_an_unreachable_store`:
    - delete the `listed = client.get("/api/runs")` check and the `stream = …/events` check;
    - keep the `events.jsonl` write, because `runs.is_legacy` uses it as a marker;
    - make the docstring `"""An identifiable historical run remains readable while the database is unreachable."""`
  - `test_a_historical_run_that_never_finished_gets_a_synthesised_terminal_status`:
    - delete the six `stream`/`blocks`/`last` lines;
    - make the docstring `"""A run recorded before this backend existed, whose API died mid-flight: \`status.json\` never reached a terminal status. \`GET /api/runs/{id}\` must report the run as failed with the UNRECORDED reason, without either file being rewritten to say so."""`
  - Rename `test_a_database_run_is_listed_with_its_job_status` to `test_a_database_run_reports_its_job_status`, and delete its `client.get("/api/runs")` assertion.
  - In `test_step_timings_survive_completion_and_reopening_the_store`, replace the final `for saved in [...]:` loop with:

    ```python
        saved = client.get("/api/runs/timed").json()
        assert saved["step_timings"] == completed["step_timings"]
        assert saved["duration_seconds"] == completed["duration_seconds"]
        assert saved["current_step"] is None
    ```
  - Remove `import threading`; only the deleted stream test used it. In the module docstring, replace "is still listed and still replays from its files" with "is still readable from its files".

- [ ] **Step 4: Drop the stream from the service smoke test**

  In `tests/test_service_smoke.py`:
  - delete `_sse` and `import json` (only `_sse` used it);
  - delete the `stream = client.get(f"/api/runs/{run_id}/events", …)` block (four lines) and the comment above it. Keep the `_persisted` assertions that follow, and replace their comment with `# The store holds O(stages) lifecycle events for this run, ending in its terminal status, and no token.`;
  - in `_persisted`'s docstring, replace "as `api._committed` does" with "as the worker's readers do";
  - in the module docstring, replace "the event stream ends with the run's terminal status and the store holds no token events" with "the store's lifecycle events end with the run's terminal status and hold no token".

- [ ] **Step 5: Point the e2e boot probe at `/api/models`**

  In `../studio/e2e/realService.ts`, inside `boot()`, change

  ```ts
          const response = await fetch(`${url}/api/runs`, { signal: AbortSignal.timeout(1000) })
  ```

  to

  ```ts
          const response = await fetch(`${url}/api/models`, { signal: AbortSignal.timeout(1000) })
  ```

  `schema --apply` has already run to completion before `boot()` (`realService.ts:219-220`), so the probe no longer needs to prove the database is reachable.

- [ ] **Step 6: Delete the routes and helpers**

  In `src/kei_exp/api.py`:
  - delete `list_runs`, `_same_input`, `_position`, `_committed`, `_cursor`, `sse` and `run_events`;
  - remove the imports `asyncio`, `AsyncIterator`, `Header`, `run_in_threadpool`, `StreamingResponse` and `Event`, and change `from kei_exp.jobs import store, tokens` to `from kei_exp.jobs import store`;
  - in the module docstring, replace "routes over `kei_exp.runs`, progress relayed as SSE." with "routes over `kei_exp.runs`." and "asks `runs` for a job, a summary or a replay," with "asks `runs` for a job or a summary,".

  In `src/kei_exp/runs.py`, delete `logged_events` and `replay` and their now-unused imports (`Iterator`, `Event`).

  In `README.md`, change "`GET /api/runs/{id}` is the authoritative job status; `/events` supplies SSE." to "`GET /api/runs/{id}` is the authoritative job status."

- [ ] **Step 7: Verify**

  ```bash
  grep -rnE "run_events|list_runs|_committed|api\.sse|logged_events|runs\.replay|/events\b" src tests ../studio/e2e ../studio/api ../studio/server ../../packages ../../docker ../../scripts --exclude-dir=node_modules
  uvx ruff check src/kei_exp/api.py src/kei_exp/runs.py tests/test_api_lifecycle.py tests/test_api_jobs.py tests/test_jobs_batching.py tests/test_service_smoke.py
  uv run --no-sync python -c "import kei_exp.api"
  uv run --no-sync pytest -q -m "not postgres and not live_model"
  uv run --no-sync pytest -q -m "postgres and not live_model"
  ```

  Expected:
  - The grep prints only comments inside `src/kei_exp/jobs/`, which M3 deletes. They are `store.py` (the `events_after` docstring and the SSE comment above `EVENT_PAGE`), `tasks.py:85` and `events.py:5`. Nothing outside `jobs/` may match.
  - Ruff passes, and both test tiers pass.

- [ ] **Step 8: Commit**

  ```bash
  git add -A src/kei_exp tests README.md ../studio/e2e/realService.ts
  git commit -m "refactor(parsing): remove the run list and the event stream"
  ```

### Task 3: Delete the Markdown and source-PDF routes, and fix the stale result version

**Files:**
- Modify: `src/kei_exp/api.py` (`run_output` 411-416, `run_source` 419-426 at 054c9e4)
- Modify: `tests/test_api_lifecycle.py`, `tests/test_api_jobs.py`, `tests/test_service_smoke.py`, `README.md`, `../../docs/architecture/current.c4`

**Interfaces:**
- Consumes: Task 2's smoke-test edits.
- Produces: no `…/output.md` or `…/source.pdf` routes. The worker still writes `output.md` and `input.pdf` to disk (M3 removes the Markdown).

- [ ] **Step 1: Keep the store-free artifact test on surviving routes**

  In `tests/test_api_lifecycle.py`, replace the body of `test_published_artifacts_do_not_need_the_store` with:

  ```python
      monkeypatch.setattr(store, "record", unavailable)
      (directory / "result" / "pages").mkdir(parents=True)
      artifacts = {"result/result.json": '{"schema_version":4}', "result/pages/1.json": '{"page":1}'}
      client = TestClient(api.app)
      for path, route in [("result/result.json", "result"), ("result/pages/1.json", "pages/1")]:
          (directory / path).write_text(artifacts[path])
          response = client.get(f"/api/runs/run-live/{route}")
          assert response.status_code == 200 and response.content == artifacts[path].encode()
  ```

- [ ] **Step 2: Judge the smoke test on disk instead of on the deleted routes**

  In `tests/test_service_smoke.py`, replace the `source.pdf` block (the comment and three lines after `summary["status"] == "done"`) with:

  ```python
      # The source is kept byte for byte: a consumer holding `source_sha256` can re-hash what was parsed.
      kept = (runs_root / run_id / "input.pdf").read_bytes()
      assert kept == source and hashlib.sha256(kept).hexdigest() == source_sha256
  ```

  Replace the `output.md` request and its two assertions with:

  ```python
      # Text order: the run's Markdown carries the pages in page order, as the page files number them.
      markdown = _flat((runs_root / run_id / "output.md").read_text(encoding="utf-8"))
  ```

  Keep the following `opening, closing = …` lines, and change their messages from "in output.md" to "in the run's output.md".

  Fix the stale version. The code writes `RESULT_VERSION = 5` (`src/kei_exp/pagefile.py:25`), so `== 4` fails today:

  ```python
  from kei_exp.pagefile import RESULT_VERSION, PageResult, read_manifest, read_page
  ```
  ```python
      assert manifest.result_version == RESULT_VERSION  # the version this client contract is written for
  ```

  In the module docstring, replace "the source PDF comes back byte for byte" with "the source PDF is kept byte for byte", and "every artifact it is judged on is fetched back over HTTP" with "its result and page files are fetched back over HTTP".

- [ ] **Step 3: Delete the source-PDF API tests**

  In `tests/test_api_jobs.py`, delete `test_the_source_pdf_is_served_back_byte_for_byte` and `test_a_historical_run_without_its_source_pdf_answers_404`.

- [ ] **Step 4: Delete the routes and fix the docs**

  In `src/kei_exp/api.py`, delete `run_output` and `run_source`.

  In `README.md`, change "A completed parse exposes `/source.pdf`, `/result`, `/pages/{page}` and `/output.md` below `/api/runs/{id}`." to "A completed parse exposes `/result` and `/pages/{page}` below `/api/runs/{id}`."

  In `docs/architecture/current.c4`:
  - change "`POST /api/runs`, run and extraction polling, canonical page manifests, source PDF, and Markdown routes." to "`POST /api/runs`, run and extraction polling, and canonical page manifests.";
  - change 'Read result manifest, source PDF, and canonical pages' to 'Read result manifest and canonical pages'.

- [ ] **Step 5: Verify**

  ```bash
  grep -rnE "run_output|run_source|/source\.pdf|/output\.md" src tests README.md ../studio ../../docker ../../scripts ../../docs/architecture --exclude-dir=node_modules
  uvx ruff check src/kei_exp/api.py tests/test_api_lifecycle.py tests/test_api_jobs.py tests/test_service_smoke.py
  uv run --no-sync pytest -q -m "not postgres and not live_model"
  uv run --no-sync pytest -q -m "postgres and not live_model"
  ```

  Expected:
  - The grep prints nothing. Disk paths such as `runs_root / run_id / "output.md"` do not match.
  - Both tiers pass. `test_service_smoke.py` runs in Task 10.

- [ ] **Step 6: Commit**

  ```bash
  git add -A src/kei_exp tests README.md ../../docs/architecture/current.c4
  git commit -m "refactor(parsing): remove the Markdown and source-PDF routes"
  ```

### Task 4: Delete the server-info, layout-model and debug routes; pin `/api/models`

**Files:**
- Modify: `src/kei_exp/api.py` (`server_info` 104-108, `list_layout_models` 123-126, `run_debug` 544-550 at 054c9e4)
- Modify: `tests/test_api_lifecycle.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `/api/models` is the Parsing Service's only probe route, pinned by a test.

- [ ] **Step 1: Pin `/api/models` as a store-free probe**

  Append to `tests/test_api_lifecycle.py`:

  ```python
  def test_models_answers_without_the_store(monkeypatch):
      """`/api/models` is the only readiness and health probe (Compose healthcheck, e2e boot): it reads no store."""
      monkeypatch.setattr(store, "record", unavailable)
      response = TestClient(api.app).get("/api/models")
      assert response.status_code == 200
      assert isinstance(response.json(), list) and response.json()
  ```

  Run: `uv run --no-sync pytest -q tests/test_api_lifecycle.py -k models_answers`. Expected: PASS (this pins existing behaviour).

- [ ] **Step 2: Delete the three routes**

  In `src/kei_exp/api.py`, delete `server_info`, `list_layout_models` and `run_debug`. Keep the imports they share with `create_run` and `list_extraction_models` (`loaded_model`, `VLLM_URL`, `LAYOUT_MODELS`, `DEFAULT_LAYOUT_MODEL`), and keep the `debug` form field of `create_run`.

- [ ] **Step 3: Verify**

  ```bash
  grep -rnE "server_info|list_layout_models|run_debug|/api/server\b|/api/layout-models|/debug/" src tests ../studio ../../docker ../../scripts ../../compose*.y*ml --exclude-dir=node_modules
  uvx ruff check src/kei_exp/api.py tests/test_api_lifecycle.py
  uv run --no-sync pytest -q -m "not postgres and not live_model"
  ```

  Expected: the grep prints nothing, ruff passes, and the tests pass.

- [ ] **Step 4: Commit**

  ```bash
  git add src/kei_exp/api.py tests/test_api_lifecycle.py
  git commit -m "refactor(parsing): remove server-info, layout-model and debug routes"
  ```

### Task 5: Delete the extraction list route

**Files:**
- Modify: `src/kei_exp/api.py` (`list_extractions` 517-523 at 054c9e4)
- Modify: `tests/test_api_extraction.py`, `../studio/e2e/real-service.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `GET …/extractions/{xid}` stays, while the list `GET …/extractions` goes. `store.extractions_of` stays (M3).

- [ ] **Step 1: Read extraction ids from disk in the real-service spec**

  In `../studio/e2e/real-service.spec.ts`, first test, replace:

  ```ts
      const remote = await (await fetch(`${service.url}/api/runs/${runId}/extractions`)).json()
      expect(remote).toHaveLength(2)
      const acceptedArtifacts = await Promise.all(remote.map(async (job: { id: string }) => {
        const polled = await (await fetch(`${service.url}/api/runs/${runId}/extractions/${job.id}`)).json()
  ```

  with:

  ```ts
      // kei-exp names each extraction's directory by its id; Studio does not keep that id.
      const extractionIds = await readdir(join(service.runs, runId, 'extractions'))
      expect(extractionIds).toHaveLength(2)
      const acceptedArtifacts = await Promise.all(extractionIds.map(async (extractionId) => {
        const polled = await (await fetch(`${service.url}/api/runs/${runId}/extractions/${extractionId}`)).json()
  ```

  In the same callback, change `join(service.runs, runId, 'extractions', job.id, 'result.json')` to `join(service.runs, runId, 'extractions', extractionId, 'result.json')`.

  In the Catalog test, replace `const [job] = await (await fetch(`${service.url}/api/runs/${runId}/extractions`)).json()` with `const [extractionId] = await readdir(join(service.runs, runId, 'extractions'))`. Then change both `extractions/${job.id}` to `extractions/${extractionId}`.

- [ ] **Step 2: Drop the list assertions from the extraction API tests**

  In `tests/test_api_extraction.py`, delete:
  - the two `listed = client.get("/api/runs/run-p/extractions")` lines at the end of `test_a_finished_run_admits_an_extraction_and_answers_202`;
  - the two `listed` lines inside the loop of `test_a_retrying_job_shows_neither_the_failed_attempts_finish_nor_its_error`;
  - `assert client.get("/api/runs/run-p/extractions").json()[0]["error"] is None` in `test_the_worker_retries_a_transient_failure…`;
  - `assert client.get("/api/runs/no-such-run/extractions").status_code == 404` in `test_an_extraction_is_read_only_under_its_own_run`;
  - in `test_an_unreachable_store_answers_503`, the `extractions_of` monkeypatch and the last two lines (`listing = …` and its assertion).

  Keep `assert store.extractions_of("run-p") == []` in `test_a_malformed_body_is_refused_before_admission`; it reads the store directly.

- [ ] **Step 3: Delete the route**

  In `src/kei_exp/api.py`, delete `list_extractions`. Keep `_extraction_status`; `get_extraction` uses it.

- [ ] **Step 4: Verify**

  ```bash
  grep -rn "list_extractions" src tests
  grep -rnF '/extractions`' ../studio/e2e ../../packages/extraction/src
  uvx ruff check src/kei_exp/api.py tests/test_api_extraction.py
  uv run --no-sync pytest -q -m "postgres and not live_model" tests/test_api_extraction.py
  pnpm --filter studio typecheck
  ```

  Expected:
  - Both greps print nothing. The second catches a template URL ending in `/extractions` (the list). `…/extractions/${id}` does not match.
  - The tests and typecheck pass. `real-service.spec.ts` runs in Task 10.

- [ ] **Step 5: Commit**

  ```bash
  git add src/kei_exp/api.py tests/test_api_extraction.py ../studio/e2e/real-service.spec.ts
  git commit -m "refactor(parsing): remove the extraction list route"
  ```

---

## Studio and `packages/extraction`

### Task 6: Remove the targeted Catalog retry request path; generic rerun for Catalog

**Files:**
- Delete: `packages/extraction/src/catalog.ts`
- Modify: `packages/extraction/src/`: `postgres-persistence.ts`, `types.ts`, `index.ts`, `errors.ts`, `module.ts`, `job-worker.ts`, `module.test.ts`
- Modify: `prototypes/studio/`: `shared/extraction.contract.ts`, `shared/extraction.contract.test.ts`, `api/extractions.ts`, `api/extractions.test.ts`, `src/useExtraction.ts`, `src/useExtraction.test.tsx`, `src/ResultsTab.tsx`, `src/ResultsTab.test.tsx`, `src/RightRail.test.tsx`, `src/api.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `RunSingleInput = FreshExtractionInput`, and `ExtractionController` has no `retryExtraction`.
  - `extractionRequestSchema` is the fresh-request schema, with no union.
  - `ExtractionErrorCode` has neither `invalid_retry` nor `extraction_in_progress`.
  - `ExtractionRetrySelection` / `extractionRetrySelectionSchema` still exist, for `diagnostics.retry`; Task 7 removes them.

- [ ] **Step 1: Write the failing API test for a stale retry body**

  In `prototypes/studio/api/extractions.test.ts`, replace the whole test `maps targeted retry requests to retry inputs without caller pins` with:

  ```ts
    it('refuses a targeted retry body from a stale page before scheduling anything', async () => {
      const module = extractionModule()
      const handle = handlerFor(module)
      const response = await handle(
        request({
          id: EXTRACTION,
          retryOfId: '51000000-0000-4000-8006-000000000099',
          retryDocument: false,
          rediscover: true,
          retryRecordStartBlockIds: ['heading-a'],
        }),
      )

      expect(response.status).toBe(422)
      expect(module.runSingle).not.toHaveBeenCalled()
    })
  ```

  Run: `pnpm --filter studio exec vitest run api/extractions.test.ts -t "stale page"`. Expected: FAIL, because the retry union still accepts the body and answers 201.

- [ ] **Step 2: Write the failing ResultsTab test for a failed Catalog attempt**

  In `prototypes/studio/src/ResultsTab.test.tsx`, add next to the Catalog tests:

  ```tsx
    it('offers Retry extraction for a failed Catalog attempt', () => {
      const failed: ExtractionAttempt = {
        ...articleAttempt,
        strategy: 'CATALOG',
        executionStatus: 'COMPLETED',
        outcome: 'FAILED',
        complete: null,
        failure: { code: 'catalog_no_records', message: 'Catalog discovery returned no records.' },
        resultPayload: null,
        evidenceLinks: null,
        reviewable: false,
      }
      const onRunExtraction = vi.fn()
      render(
        <ResultsTab
          {...defaultRunProps}
          onRunExtraction={onRunExtraction}
          controller={controller({ status: 'error', message: 'Catalog discovery returned no records.' }, failed)}
          schemaReady
          documentMarkdown="# Source"
          sourceDocumentName="Catalog.pdf"
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Retry extraction' }))
      expect(onRunExtraction).toHaveBeenCalledOnce()
    })
  ```

  In `renders Catalog diagnostics with targeted retry controls behind Run details`:
  - rename it `renders Catalog diagnostics behind Run details and offers a generic rerun`;
  - delete the `retryExtraction` mock and the `retryExtraction,` controller override, so it passes `controller(...)` directly;
  - replace `// No generic rerun for a Catalog attempt.` and the assertion under it with `expect(screen.getByRole('button', { name: 'Rerun' })).toBeInTheDocument()`;
  - delete everything from `// Retry controls offer only failed or limit-skipped components.` to the end of the test body.

  Delete `offers rediscovery after an empty failed discovery`. Its fixture is a checkpointed FAILED job, which Task 8 makes impossible, and its subject was the retry control.

  Run: `pnpm --filter studio exec vitest run src/ResultsTab.test.tsx -t "Catalog"`. Expected: both changed tests FAIL (no Retry extraction and no Rerun for Catalog).

- [ ] **Step 3: Remove the retry request path from `packages/extraction`**

  1. `git rm packages/extraction/src/catalog.ts`.
  2. `types.ts`: delete `RetryExtractionInput` and make `export type RunSingleInput = FreshExtractionInput`. Keep `ExtractionRetrySelection` and `ExtractionDiagnostics.retry` (Task 7).
  3. `index.ts`: remove the `RetryExtractionInput` export.
  4. `errors.ts`: remove `'extraction_in_progress'` and `'invalid_retry'` from `ExtractionErrorCode`.
  5. `module.ts`: delete the first two lines of the executor (`if (input.kind === 'retry') throw new ExtractionError('invalid_retry', …)`).
  6. `job-worker.ts`: replace the timeout expression with:

     ```ts
         const timeout = AbortSignal.timeout(
           job.input.strategy === 'CATALOG' ? CATALOG_MEMBER_TIMEOUT_MS : MEMBER_TIMEOUT_MS,
         )
     ```
  7. `postgres-persistence.ts`:
     - delete `import { sameRetrySelection, validateCatalogRetry } from './catalog.js'`;
     - `ScheduledJob`: delete `retryOfId`, `retryDocument`, `rediscover` and `retryRecordStartBlockIds`;
     - replace `jobIdentityMatches` with the version below. It keeps a legacy-row guard: a fresh request must never replay onto a row that was a retry.

       ```ts
       function jobIdentityMatches(
         row: Readonly<{
           kind: 'INTERACTIVE' | 'BATCH_MEMBER'
           sourceRepresentationRevisionId: string
           schemaRevisionId: string
           strategy: ExtractionStrategy
           catalogRecipe: string | null
           requestedModels: unknown
           retryOfId: string | null
         }>,
         job: ScheduledJob,
       ): boolean {
         return row.kind === 'INTERACTIVE' &&
           row.retryOfId === null &&
           row.sourceRepresentationRevisionId === job.sourceRepresentationRevisionId &&
           row.schemaRevisionId === job.schemaRevisionId &&
           row.strategy === job.strategy &&
           row.catalogRecipe === job.catalogRecipe &&
           isDeepStrictEqual(modelChoice(row.requestedModels), job.requestedModels)
       }
       ```
     - `resolveScheduledJob`: delete the whole `if (input.kind === 'retry') { … }` branch, and delete the four `retry…: null` fields from the fresh return;
     - `scheduleInteractiveExtraction`:
       - reduce the `existingJob` select to `'kind', 'projectContextId', 'sourceRepresentationRevisionId', 'schemaRevisionId', 'strategy', 'catalogRecipe', 'requestedModels', 'retryOfId'`;
       - delete `retryRecordStartBlockIds: job.retryRecordStartBlockIds,` from the `ExtractionJob.create` call;
     - `claim()`:
       - delete `'retryOfId', 'retryDocument', 'rediscover', 'retryRecordStartBlockIds',` from both selects;
       - delete `const retryRecordStartBlockIds = …` and the `candidate.retryOfId ? { kind: 'retry' … } :` arm, so `input` starts at `candidate.batchExtractionId ? …`.
  8. `module.test.ts`: in `keeps batch identity and rejects unsupported targeted retries`, delete the retry assertion and rename the test `keeps batch identity`.
  9. Keep `canonicalIds`: the batch code still uses it (`postgres-persistence.ts:104,1727,1798`).

- [ ] **Step 4: Remove the retry request path from Studio**

  1. `shared/extraction.contract.ts`: delete `extractionRetryRequestSchema`. Replace `extractionFreshRequestSchema` and the union with one schema that keeps its name and its type exports:

     ```ts
     export const extractionRequestSchema = z
       .object({
         id: requestUuid,
         sourceRepresentationRevisionId: requestUuid,
         schemaRevisionId: requestUuid,
         strategy: extractionStrategySchema,
         catalogRecipe: catalogRecipeSchema.optional(),
         // The server applies the configured Extraction Model Choice.
         models: z.never().optional(),
       })
       .strict()
       .refine((request) => request.catalogRecipe === undefined || request.strategy === 'CATALOG', {
         path: ['catalogRecipe'],
         message: 'A recipe applies to a Catalog Extraction only.',
       })
     ```
     `.strict()` already refuses the retry keys, so the `z.never()` retry fields go. Keep `extractionRetrySelectionSchema` (Task 7).
  2. `api/extractions.ts`: remove `case 'extraction_in_progress':` and `case 'invalid_retry':` from the error mapping. Replace the `models`/`input` block in `create` with:

     ```ts
         const models = await extractionModels()
         const input = {
           kind: 'fresh' as const,
           extractionId: parsed.data.id,
           sourceRepresentationRevisionId: parsed.data.sourceRepresentationRevisionId,
           schemaRevisionId: parsed.data.schemaRevisionId,
           strategy: parsed.data.strategy,
           ...(parsed.data.catalogRecipe ? { catalogRecipe: parsed.data.catalogRecipe } : {}),
           ...(models ? { models } : {}),
         }
     ```
  3. `src/useExtraction.ts`:
     - remove the `ExtractionRetrySelection` import and `ExtractionRetryInput`;
     - make `ExtractionRunRequest` the single fresh object type (delete the `| Readonly<{ retryOfId: string } & ExtractionRetryInput>` arm);
     - delete `retryExtraction` and its entry in the returned object.
  4. `src/ResultsTab.tsx`:
     - change the import to `import { extractionStateFromAttempt, type ExtractionController } from './useExtraction'`;
     - delete `emptyRetrySelection` and `CatalogRetryControls` (from `const emptyRetrySelection` to the line before `function InfoIcon()`);
     - make `AttemptDetails` take only `{ attempt }: { attempt: ExtractionAttempt }`, delete its `CatalogRetryControls` mount, and change the call site to `<AttemptDetails attempt={attempt} />`;
     - delete `&& attempt?.strategy !== 'CATALOG'` from the `Rerun` condition and `&& attempt?.strategy !== 'CATALOG'` from the `Retry extraction` condition.
  5. Tests:
     - `shared/extraction.contract.test.ts`: rename `separates fresh requests from strict targeted retry selections` to `accepts fresh requests and refuses retry fields`. Keep its first two blocks: the normalizing parse, and the fresh request with `retryOfId: id('5')` that must fail. Delete everything from `const retry = extractionRequestSchema.safeParse({` to the end of the test. Delete the retry-with-models case (around line 300 at 054c9e4).
     - `src/useExtraction.test.tsx`: delete `submits targeted Catalog retries only for a Catalog parent`.
     - Delete the `retryExtraction: async () => null` controller stubs in `src/ResultsTab.test.tsx`, `src/RightRail.test.tsx` and `src/api.test.ts`.

- [ ] **Step 5: Run the new tests; they pass**

  Run: `pnpm --filter studio exec vitest run api/extractions.test.ts src/ResultsTab.test.tsx src/useExtraction.test.tsx shared/extraction.contract.test.ts`. Expected: PASS.

- [ ] **Step 6: Verify**

  ```bash
  grep -rnE "RetryExtractionInput|extractionRetryRequestSchema|retryExtraction|CatalogRetryControls|invalid_retry|extraction_in_progress|validateCatalogRetry|sameRetrySelection|kind: 'retry'|kind === 'retry'" prototypes packages docs/architecture --exclude-dir=node_modules
  pnpm --filter extraction typecheck && pnpm --filter extraction test
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test
  pnpm --filter extraction test:postgres
  ```

  Expected: the grep prints nothing, and every command passes.

- [ ] **Step 7: Commit**

  ```bash
  git add -A packages/extraction/src prototypes/studio
  git commit -m "refactor(extraction): remove targeted Catalog retry; rerun failed Catalog attempts"
  ```

### Task 7: Remove the retry fields from the read contract

**Files:**
- Modify: `packages/extraction/src/`: `types.ts`, `index.ts`, `dependencies.ts`, `module.ts`, `postgres-persistence.ts`, and test fixtures in `module.test.ts` and `job-worker.test.ts`
- Modify: `prototypes/studio/`: `shared/extraction.contract.ts`, `api/_extraction_runtime.ts`, plus every fixture that carries `retry: null` or `retryOfId: null`. At 054c9e4 these are:
  - `shared/extraction.contract.test.ts`, `api/extractions.test.ts`, `api/document_reopen.test.ts`;
  - `src/useExtraction.test.tsx`, `src/ResultsTab.test.tsx`, `src/App.test.tsx`, `src/api.test.ts`, `src/api.reviewDraft.test.ts`;
  - `src/projectContexts/BatchExtractionsPanel.test.tsx`, `src/ProjectNavigation.test.tsx`, `src/useBatchExtractionReviewGrid.test.tsx`;
  - `e2e/batch-extraction-export.spec.ts`.

**Interfaces:**
- Consumes: Task 6.
- Produces:
  - `ExtractionDiagnostics` has no `retry`, and snapshots and the attempt DTO have no `retryOfId`.
  - The only remaining `retryOfId` references are the legacy-row guard in `postgres-persistence.ts`: the `existingJob` select, `jobIdentityMatches`' row type, and its `row.retryOfId === null` check.

- [ ] **Step 1: Write the failing contract test**

  In `prototypes/studio/shared/extraction.contract.test.ts`, add:

  ```ts
    it('carries no retry lineage on attempts or diagnostics', () => {
      expect(extractionAttemptSchema.safeParse({ ...completed, retryOfId: null }).success).toBe(false)
      expect(extractionAttemptSchema.safeParse({
        ...completed,
        diagnostics: { ...completed.diagnostics, retry: null },
      }).success).toBe(false)
    })
  ```

  First delete `retryOfId: null` and `retry: null` from the `completed` fixture at the top of this file, so it states the new shape.

  Run: `pnpm --filter studio exec vitest run shared/extraction.contract.test.ts`. Expected: FAIL. The new test fails because both extra keys are still accepted, and tests that parse `completed` fail because `retryOfId` is still required. Step 2 makes them all pass.

- [ ] **Step 2: Remove the fields**

  1. `shared/extraction.contract.ts`: delete `extractionRetrySelectionSchema` and `ExtractionRetrySelection`, the `retry:` line of `extractionDiagnosticsSchema`, and `retryOfId` from `extractionAttemptSchema`.
  2. `api/_extraction_runtime.ts`: delete `retry: diagnostics.retry ?? null,` and `retryOfId: extraction.retryOfId,`. `transportDiagnostics` builds diagnostics field by field, so stored rows that still hold `retry: null` in their JSON keep parsing.
  3. `packages/extraction/src/types.ts`: delete `ExtractionRetrySelection`, `ExtractionDiagnostics.retry`, and `retryOfId` from both snapshot types.
  4. `index.ts`: remove the `ExtractionRetrySelection` export.
  5. `dependencies.ts`: delete `TerminalExtraction.retryOfId`.
  6. `module.ts`: delete `retry: null,` from the diagnostics literal and `retryOfId: null,` from the terminal literal.
  7. `postgres-persistence.ts`:
     - delete `'retryOfId'` from the `loadExtraction` select and from the `loadExtractionAttempt` select;
     - delete both `retryOfId: row.retryOfId,` mappings;
     - delete `retryOfId: input.retryOfId,` from `Extraction.create` in `complete()`;
     - keep the Task 6 guard.
  8. Fixtures: `grep -rln "retryOfId: null\|retry: null" prototypes/studio packages/extraction --exclude-dir=node_modules`. In each file listed, delete every `retryOfId: null,` and `retry: null,` entry (and the key, where it sits on a longer line). Do not touch `retry: true/false` in review-draft code, which is unrelated.

- [ ] **Step 3: Run the tests; they pass**

  ```bash
  grep -rnE "retryOfId|retry: null|ExtractionRetrySelection|extractionRetrySelectionSchema" prototypes packages/extraction --exclude-dir=node_modules
  pnpm --filter extraction typecheck && pnpm --filter extraction test
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test
  pnpm --filter extraction test:postgres
  ```

  Expected:
  - The grep prints only the three guard lines in `packages/extraction/src/postgres-persistence.ts`.
  - Everything passes. The strict schemas and the excess-property typecheck catch any missed fixture.

- [ ] **Step 4: Commit**

  ```bash
  git add -A packages/extraction/src prototypes/studio
  git commit -m "refactor(extraction): drop retry lineage from the read contract"
  ```

### Task 8: Remove extraction checkpoints and provisional results; archive the OpenSpec change

**Files:**
- Modify: `packages/extraction/src/`: `dependencies.ts`, `postgres-persistence.ts`, `job-worker.test.ts`, `extraction-module.integration.test.ts`
- Modify: `prototypes/studio/`: `shared/extraction.contract.ts`, `shared/extraction.contract.test.ts`, `api/extractions.test.ts`, `src/ResultsTab.tsx`, `src/ResultsTab.test.tsx`, `src/useExtraction.test.tsx`
- Move: `openspec/changes/preview-extraction-before-grounding/` → `openspec/changes/archive/2026-09-25-preview-extraction-before-grounding/`

**Interfaces:**
- Consumes: Task 7's fixtures, which have no `retry`/`retryOfId`.
- Produces:
  - A QUEUED/RUNNING/FAILED job never carries `complete`, `modelAttribution`, `diagnostics` or `resultPayload`: persistence reads them as null and the contract requires null.
  - `InternalExtractionJobStore` has no `checkpoint`, and `ClaimedExtractionJob` has no `checkpoint`.

- [ ] **Step 1: Write the failing contract test**

  In `shared/extraction.contract.test.ts`, replace `accepts queued and checkpointed running jobs but rejects partial checkpoints` with:

  ```ts
    it('accepts queued and running jobs only while they carry no values', () => {
      const queued = {
        ...completed,
        executionStatus: 'QUEUED',
        outcome: null,
        complete: null,
        modelAttribution: null,
        diagnostics: null,
        resultPayload: null,
        evidenceLinks: null,
        reviewable: false,
      }
      expect(extractionAttemptSchema.safeParse(queued).success).toBe(true)
      expect(extractionAttemptSchema.safeParse({ ...queued, executionStatus: 'RUNNING' }).success).toBe(true)
      expect(extractionAttemptSchema.safeParse({
        ...queued,
        executionStatus: 'RUNNING',
        complete: true,
        modelAttribution: completed.modelAttribution,
        diagnostics: completed.diagnostics,
        resultPayload: completed.resultPayload,
      }).success).toBe(false)
      expect(extractionAttemptSchema.safeParse({
        ...queued,
        executionStatus: 'RUNNING',
        resultPayload: completed.resultPayload,
      }).success).toBe(false)
    })
  ```

  Run: `pnpm --filter studio exec vitest run shared/extraction.contract.test.ts -t "carry no values"`. Expected: FAIL (a checkpointed running job is still accepted).

- [ ] **Step 2: Write the failing legacy-row integration test**

  In `packages/extraction/src/extraction-module.integration.test.ts`, inside `describe('ExtractionModule on disposable PostgreSQL', …)`, add:

  ```ts
      it('reads a job holding legacy checkpoint columns as having no values yet', async (t) => {
        t.after(cleanup)
        const project = await seedProject()
        const { module } = createRuntime(project.researcherAccountId)
        const input = freshInput(project)
        await module.runSingle(input)
        // Rows written before e88b08f could hold checkpointed values; nothing writes them any more.
        await db.orm.public.ExtractionJob.where({ id: input.extractionId }).updateAll({
          executionStatus: 'RUNNING',
          complete: true,
          modelAttribution: { provider: 'kei-exp', modelId: 'legacy' },
          diagnostics: { phase: 'grounding' },
          resultPayload: { records: [{ place: 'Rome' }] },
        })
        const attempt = await module.readExtractionAttempt(input.extractionId)
        assert.equal(attempt?.executionStatus, 'RUNNING')
        assert.equal(attempt?.result, null)
        assert.equal(attempt?.complete, null)
        assert.equal(attempt?.modelAttribution, null)
        assert.equal(attempt?.diagnostics, null)
      })
  ```

  `seedProject`, `createRuntime` (it returns `{ module, … }`), `freshInput`, `db` and `cleanup` are the file's existing helpers.

  Run: `pnpm --filter extraction test:postgres`. Expected: the new test FAILS (it reads the legacy values).

- [ ] **Step 3: Stop reading and writing checkpoints**

  1. `dependencies.ts`: delete `ExtractionValueCheckpoint`, `ClaimedExtractionJob.checkpoint` and `InternalExtractionJobStore.checkpoint`.
  2. `postgres-persistence.ts`:
     - remove `ExtractionValueCheckpoint` from the type import;
     - in `loadExtractionAttempt`, delete `'complete'`, `'modelAttribution'`, `'diagnostics'` and `'resultPayload'` from the job select, and map the four fields of the non-completed return as `complete: null`, `modelAttribution: null`, `diagnostics: null`, `result: null`;
     - in `claim()`:
       - delete `'complete', 'modelAttribution', 'diagnostics', 'resultPayload'` from both selects;
       - make the cancel failure `phase: 'extracting'`;
       - delete `const checkpoint = …` and `checkpoint,` from the returned object;
     - delete the `checkpoint()` method;
     - in `complete()`, delete the four `complete/modelAttribution/diagnostics/resultPayload: null` lines of the job update. Nothing sets them any more.
  3. `shared/extraction.contract.ts`: in the `superRefine`, delete `checkpointFields`, `checkpointed` and `emptyCheckpoint`, and replace `(checkpointed || emptyCheckpoint) &&` with:

     ```ts
           attempt.complete === null && attempt.modelAttribution === null &&
           attempt.diagnostics === null && attempt.resultPayload === null &&
     ```
  4. `src/ResultsTab.tsx`:
     - `statusLabel`, `case 'ready'`: delete the three lines for QUEUED/RUNNING, FAILED and CANCELLED, leaving `return attempt?.complete === false ? 'Completed · incomplete' : 'Completed'`;
     - delete `const provisional = …`, the `{provisional && (<p … role="status">…</p>)}` banner, and `|| provisional` in the export control's `disabled`;
     - keep `activeAttempt`.
  5. `job-worker.test.ts`:
     - delete every `async checkpoint() …` stub and every `checkpoint: null,` field;
     - in `does not promote a remote artifact after cancellation of a reclaimed job`, delete the `checkpoint: { … }` object from `job`. Its final `assert.equal(failurePhase, 'extracting')` must still pass.

- [ ] **Step 4: Rewrite the UI tests that depended on provisional values**

  In `src/useExtraction.test.tsx`, add below `attempt()`:

  ```ts
  /** A QUEUED or RUNNING attempt: a job carries no values, attribution or diagnostics until it completes. */
  function jobAttempt(overrides: Partial<ExtractionAttempt> = {}): ExtractionAttempt {
    return attempt({
      executionStatus: 'RUNNING', outcome: null, complete: null, modelAttribution: null,
      diagnostics: null, resultPayload: null, evidenceLinks: null, reviewable: false, ...overrides,
    })
  }
  ```

  Then:
  - `polls a queued job through provisional values to completion`:
    - rename it `polls a queued job to completion`;
    - make `provisional` `jobAttempt()`;
    - replace the `toMatchObject({ status: 'ready', … })` assertion with `expect(result.current.state).toEqual({ status: 'running', step: 'extraction' })`.
  - `keeps a checkpointed restored job cancellable`: rename it `keeps a restored running job cancellable`, make `restored` `jobAttempt()`, and expect `state.status` to be `'running'`.
  - `keeps polling through transient schema hydration for a restored job` and `ignores a stale restored-job read after its document changes`: make `restored` `jobAttempt()`.
  - `monitors a restored previous-schema run after a document switch and offers its review`:
    - `restored = jobAttempt({ extractionId: '77777777-7777-4777-8777-777777777777', schemaRevisionId: previousRevisionId })`;
    - `finished = attempt({ extractionId: restored.extractionId, schemaRevisionId: previousRevisionId, resultPayload: { records: [{ title: 'Grounded' }] }, evidenceLinks: [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-1' }], reviewable: true })`;
    - expect `state.status` `'running'` right after the rerender.

  In `src/ResultsTab.test.tsx`:
  - Delete `shows checkpointed values while Evidence linking…`.
  - Replace `keeps the last known status and offers Reconnect after a lost connection` with:

    ```tsx
      it('keeps the last known status and offers Reconnect after a lost connection', () => {
        const reconnect = vi.fn()
        render(
          <ResultsTab
            {...defaultRunProps}
            controller={{
              ...controller({ status: 'running', step: 'extraction' }, {
                ...articleAttempt, executionStatus: 'RUNNING', outcome: null, complete: null,
                modelAttribution: null, diagnostics: null, resultPayload: null, evidenceLinks: null, reviewable: false,
              }),
              monitorError: 'Unable to update status. The extraction may still be running.',
              reconnect,
            }}
            schemaReady
            documentMarkdown="# Source"
            sourceDocumentName="running.pdf"
          />,
        )

        expect(screen.getByText('Unable to update status. The extraction may still be running.')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
        expect(reconnect).toHaveBeenCalledOnce()
      })
    ```

  In `api/extractions.test.ts`, delete `reads provisional job values…`.

- [ ] **Step 5: Archive the OpenSpec change as superseded**

  ```bash
  git mv openspec/changes/preview-extraction-before-grounding \
    openspec/changes/archive/2026-09-25-preview-extraction-before-grounding
  ```

  Insert at the top of the moved `proposal.md`:

  ```markdown
  > **Superseded 2026-09-25; specs not synced.** e88b08f delegated extraction to kei-exp and removed every
  > checkpoint write, so provisional values stopped appearing. M1 of
  > `docs/plans/2026-09-24-unified-durable-execution.md` removed the remaining code; M4 replaces Extraction Jobs
  > with DBOS workflows. Kept for the record only.
  ```

- [ ] **Step 6: Verify**

  ```bash
  grep -rnE "ExtractionValueCheckpoint|\.checkpoint\(|checkpointed|emptyCheckpoint|provisional results|partial results|linking Evidence" prototypes/studio packages/extraction --exclude-dir=node_modules
  pnpm --filter extraction typecheck && pnpm --filter extraction test
  pnpm --filter extraction test:postgres
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test
  ```

  Expected:
  - The grep prints only batch-schema-suggestion "checkpoint" wording, if any (`api/_project_operations.ts`, `api/project_operations.test.ts`, the suggestion integration test). Those are unrelated and out of scope.
  - Everything passes, including the new integration test.

- [ ] **Step 7: Commit**

  ```bash
  git add -A packages/extraction/src prototypes/studio openspec/changes
  git commit -m "refactor(extraction): remove dead checkpoints and provisional results"
  ```

### Task 9: Delete the LLM inspector

**Files:**
- Delete:
  - `prototypes/studio/api/_llm_inspector.ts`, `api/llm_inspector.ts`, `api/llm_inspector.test.ts`;
  - `shared/llmInspector.contract.ts`, `src/llmInspector/` (both files), `src/main.test.tsx`;
  - `e2e/developer-ui.spec.ts`, `playwright.developer-ui.config.ts`.
- Modify: `prototypes/studio/`: `api/_model.ts`, `api/_model.test.ts`, `src/main.tsx`, `src/developerUi.ts`, `server/api-dispatcher.ts`, `server/api-dispatcher.test.ts`, `server/app.ts`, `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: no inspector wrapper around any model. `generateWithNuExtract(target, input, requestFetch?)` has no `operation` parameter, and `dispatchDevelopmentApiRequest` no longer exists.

- [ ] **Step 1: Remove the production hooks**

  In `api/_model.ts`:
  - delete `import { inspectHttpExchange, inspectTarget } from './_llm_inspector.js'`;
  - make the resolver return `return resolved`;
  - remove the `operation: ModelOperation,` parameter from `generateWithNuExtract`, and drop `'schema-suggestion',` from its one call site;
  - replace the `inspectHttpExchange(…)` call with a direct fetch:

    ```ts
      let response: Response
      try {
        response = await requestFetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(target.authorization === null ? {} : { authorization: target.authorization }),
          },
          body: requestBody,
          signal: input.signal,
        })
      } catch (error) {
        throw asModelOperationError(error, 'NuExtract generation failed.')
      }
    ```

  In `api/_model.test.ts`, delete the `clearLlmInspector` import and its `afterEach` call.

- [ ] **Step 2: Remove the endpoint, dispatcher branch and mount**

  1. `server/api-dispatcher.ts`: delete the `llmInspector` import, `llm_inspector: true,`, `'!../api/llm_inspector.ts',`, `developmentRegistry` and `dispatchDevelopmentApiRequest`.
  2. `server/app.ts`:
     - delete the `dispatchDevelopmentApiRequest,` import;
     - make `const dispatcher = options.apiDispatcher ?? dispatchApiRequest`;
     - delete `'/src/llmInspector/mount.tsx': true,` from `VITE_DEVELOPMENT_ASSETS`;
     - run `grep -rn "developerUi\|ModalDialog" src/main.tsx src/auth src/studioUrl.ts src/ui/Button.tsx`. If neither file is imported before sign-in any more, also delete `'/src/developerUi.ts': true,` and `'/src/ui/ModalDialog.tsx': true,`. `mount.tsx` was their only pre-auth importer (5078c62).
  3. `src/main.tsx` becomes:

     ```tsx
     import { StrictMode } from 'react'
     import { createRoot } from 'react-dom/client'
     import AuthApplication from './auth/AuthApplication.tsx'
     import './index.css'
     import 'pdfjs-dist/web/pdf_viewer.css'
     import './pdf-viewer.css'

     createRoot(document.getElementById('root')!).render(
       <StrictMode>
         <AuthApplication />
       </StrictMode>,
     )
     ```
  4. `src/developerUi.ts`: change the comment to "Developer UI flag: controls display of developer/debug tooling like the raw Evidence tab in RightRail." Keep the file; `RightRail.tsx` uses it.
  5. `package.json`: delete the `test:e2e:developer` script.
  6. `server/api-dispatcher.test.ts`: delete the `dispatchDevelopmentApiRequest` import and the test `adds the inspector only to the explicit development registry`. Keep the assertions that `/api/llm_inspector` answers 404; they now guard its absence.
  7. Delete the files listed under **Delete**.

- [ ] **Step 3: Verify**

  ```bash
  grep -rnE "llmInspector|_llm_inspector|inspectTarget|inspectHttpExchange|clearLlmInspector|dispatchDevelopmentApiRequest|developer-ui|test:e2e:developer|FREE_PLAYWRIGHT_DEVELOPER_UI" prototypes/studio .github scripts package.json --exclude-dir=node_modules
  pnpm --filter studio typecheck && pnpm --filter studio lint && pnpm --filter studio test
  pnpm --filter studio build
  ```

  Expected:
  - The grep prints only the `/api/llm_inspector` 404 assertions in `server/api-dispatcher.test.ts`.
  - typecheck, lint, test and build pass. The build proves the production bundle no longer imports the inspector.

- [ ] **Step 4: Commit**

  ```bash
  git add -A prototypes/studio
  git commit -m "refactor(studio): remove the LLM inspector"
  ```

---

### Task 10: Full verification and bookkeeping

**Files:**
- Modify: `docs/plans/2026-09-24-unified-durable-execution.md` (the M1 heading), this plan's `Status:` line

- [ ] **Step 1: Run every tier**

  ```bash
  pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:safety
  DATABASE_URL=$EXTRACTION_TEST_DATABASE_URL pnpm --filter db db:init
  DATABASE_URL=… pnpm test:postgres
  pnpm test:e2e
  pnpm test:service
  (cd prototypes/parsing_service && uv run --no-sync pytest -q tests/test_service_smoke.py)
  pnpm --filter parsing-service test:live-model
  ```

  Expected: all pass. `test:service`, the smoke test and `test:live-model` need Docling models (and `test:service` a scripted model server). If this host cannot run one, record which, and why, in the PR description. Never report it as passed.

- [ ] **Step 2: Repository-wide residue search**

  ```bash
  grep -rnE "llm_inspector|inspectTarget|retryExtraction|RetryExtractionInput|invalid_retry|extraction_in_progress|ExtractionValueCheckpoint|page_geometry|render_page|run_page_boxes|run_events|list_runs|list_extractions|server_info|list_layout_models|run_debug|result_version == 4" \
    prototypes packages scripts docker compose*.y*ml docs/architecture --exclude-dir=node_modules
  ```

  Expected: only the `/api/llm_inspector` 404 guard assertions from Task 9. Historical records under `docs/plans/`, `docs/validation/` and `openspec/changes/archive/` are not residue.

- [ ] **Step 3: Record completion**

  In the DBOS plan, change `**M1: dead code (no schema change; can merge first).**` to `**M1: dead code (no schema change) — done YYYY-MM-DD, PR #<n>.**`, using the real date and PR number. In this plan, set `Status: **done YYYY-MM-DD.**`

  ```bash
  git add docs/plans/2026-09-24-unified-durable-execution.md docs/plans/2026-09-25-dbos-m1-dead-code.md
  git commit -m "docs(plans): record DBOS M1 completion"
  ```

- [ ] **Step 4: Finish the branch**

  Use superpowers:finishing-a-development-branch. The PR description:
  - lists the three user decisions above;
  - states the deployment precondition from Global Constraints;
  - names any tier that could not run on this host.

# View-Ordered Streaming Extraction — Service, Package and API Implementation Plan (Part A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make kei read the records nearest the page the researcher is looking at first, publish each entry's candidates and finished work as it happens, serve that progress over a read route, and have Studio's API return it as a `partial` view of a running Extraction — so the client plan (Part B) can show values as they exist.

**Architecture:** Everything stays inside existing step bodies and read paths (no workflow step changes, nothing behind `DBOS.patch()`). kei gains `Options.start_page`, excluded from `dumped()` so the artifact and its fingerprint are unchanged; the unified Catalog submits entries to its pool in distance order and assembles in source order; Article calls bounded value contexts in the same order. kei writes stage files beside the write-once records it already publishes (a header naming the strategy, start page and this execution's token; a reading marker and a candidates file per entry; for Article a context file carrying the root assembled so far and a grounding file per batch), and `GET /api/runs/{run}/extractions/{id}/progress` reads them, validating each file and skipping what is unreadable, stale or malformed, with the artifact's own link code for finished entries. Studio stores `startPage` on the Extraction row (one migration, not part of the admission identity), hands it to kei inside the existing `submitToKei` request, and `read()` of a RUNNING attempt asks kei for progress under a two-second timeout, converting and validating it inside one best-effort boundary; anything slow, missing or malformed is `partial: null`.

**Tech Stack:** Python 3.13 (pydantic 2, FastAPI, pytest), TypeScript (zod 4, node:test, Vitest), prisma-next migrations, DBOS 5 (unchanged), kei stand-in (`packages/extraction/src/testing`).

**Spec:** `docs/superpowers/specs/2026-10-02-view-ordered-streaming-extraction-design.md` (base: `origin/dev` at 332a845b, after PR #159). Worktree: `/home/gennaro/projects/FREE-worktrees/view-ordered-streaming`, branch `feat/view-ordered-streaming`. Companion: `docs/superpowers/plans/2026-10-03-view-ordered-streaming-client.md` (Part B: the Studio client, on a fresh worktree after this plan and the workspace redesign have merged).

## Global Constraints

- No new dependency, Python or Node. No `uv add`, no `pnpm add`.
- Node install in the worktree: `pnpm install --prefer-offline --frozen-lockfile --ignore-scripts` then `DATABASE_URL=postgresql://contract:emit@127.0.0.1:5432/free pnpm db:generate` (the URL is never dialled); never a bare `pnpm install` (the postinstall builds a multi-GB Python venv).
- Python tests run against the main checkout's venv with this worktree's sources first on the path. **"pytest" in this plan means**, run from `prototypes/parsing_service`: `/home/gennaro/projects/FREE/prototypes/parsing_service/.venv/bin/python -m pytest -q` (that venv holds an editable install of the main checkout; Task 1 adds `pythonpath = ["src"]` to the pytest options, so the worktree's `src` wins; until that lands, add `-o pythonpath=src`). Never `uv sync`, never a second venv, no environment-variable prefixes (a harness may refuse them). The fast tier is `-m "not postgres and not live_model"`; every test this plan adds is in the fast tier (file reads, scripted chats, no database).
- No change to a workflow's step sequence: `runExtraction` keeps `loadAdmitted, submitToKei, pollKei…, publishResult|publishFailure`; kei's `extract` keeps its one `extract_run` step. Nothing goes behind `DBOS.patch()` (`prototypes/studio/CLAUDE.md`, `prototypes/parsing_service/CLAUDE.md`).
- The artifact identity and fingerprint do not change: `start_page` is excluded from `Options.dumped()` exactly as `pages` was; the execution, discovery and entry records keep their identities, so a retry from another page reuses them.
- Stage files are a view: written by rename, marked with their execution's token, never read by `unified.read` or `_entry_reusable`, never an input to the artifact; a write that fails is logged and dropped, never an extraction failure; a file that is missing, unreadable, malformed or from another execution is skipped by the reader.
- kei accepts `start_page` before Studio sends it: `Options` has `extra="forbid"`, so this plan is one pull request deployed as one unit, and its kei tasks come first in the branch.
- Contract fixtures under `prototypes/parsing_service/tests/fixtures/contracts/` pin both sides: a change is made once and both test suites read it (`extract.input.json` gains `start_page`; `extract.progress.json` is new).
- Every commit: the touched Python tests pass under the pytest command above; `pnpm -r typecheck`, `pnpm --filter studio lint`, and the touched Node test files pass. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; `git add` scoped paths only.
- Line numbers in this plan point at the base commit 332a845b; every task shifts the next one's. They are anchors to the text named beside them, not addresses: find the text, then edit.
- Copy in error messages and docstrings follows `CONTEXT.md`: "researcher", "Extraction", "Evidence"; never "user".

## Rulings taken while planning (the controller may re-rule; each cites the spec text it resolves)

1. **kei's extraction id is the Studio extraction id.** §5 says "the extraction id from `keiExtractWorkflowId(extractionId)`"; kei's `extraction_id_of` strips the `kei-extract:` prefix, and `publishResult` already reads the artifact with the plain id. The progress route takes the same plain id.
2. **A `reading` stage and a reading marker file.** §1's table needs `reading` ("the values call for this record is in flight"); §3's enum has no stage for it, and no file in §2 lets the reader tell an entry in flight from one waiting (with `KEI_CATALOG_CHUNKS` entries in flight at once, the next unfinished entry is not the one being read). kei writes `catalog-entry-<n>.reading.v1.json` before an entry's first values window; the route's `stage` gains `"reading"`.
3. **One header stage file, `extraction-progress.json`,** carries the strategy, `start_page` and an execution token. §3 returns `started_at_page`, but the execution and discovery records are identity-bound (a retry from another page must reuse them), so neither may hold the page.
4. **Stage files belong to one execution.** A retried `extract_run` (a transient failure after some stages) runs the implementation again in the same directory; its stage files would otherwise mix with the previous attempt's (an Article grounding file from yesterday's values beside today's root). Every stage file carries the header's execution token, the header is rewritten first, and the reader skips files of another execution. §2's "write-once" for the Article files is read as "never read by a resume path": they are rewritten per execution.
5. **A finished entry's `record` is the entry's own conformed fields** (`work.record`), without the document-level and filename fields `merge` adds. §3 says "what `_artifact` would assemble for that entry alone (`merge` and `_link`)": the route has no schema to merge with, and the document fields are read only after every entry, so they cannot appear earlier. The evidence links are `_link`'s, through `unified.entry_links`; an unresolved arbitration (`work.contest`) travels as `contested`, so the view shows Contested where the settled result will.
6. **Article's progress root is assembled by kei, not by the reader.** §3's `document: { contexts, links }` says nothing about how the contexts' answers combine; the artifact combines them with `assemble_document` (lists kept, objects merged, disagreeing scalars null with a conflict) and `conform`, both of which need the schema and the contexts' passages the reader does not have. After each value context kei writes the root assembled so far from the contexts answered so far, with its conflicts; the reader takes the latest.
7. **Nulls are `empty` only when the call that could have answered them succeeded.** A values window that failed (`work.failed`) or a context whose call failed leaves its fields unknown, not empty: the candidates file carries `failed`, the context file `ok`, and such nulls stay `reading` until the attempt settles. §1: "`empty`: nothing found" requires a call that found nothing.
8. **`preprocessId` joins the attempt snapshots** (`pinsOf`), so `read()` can name the kei run; it never reaches the DTO or the wire.
9. **`partialFromProgress` lives in `packages/extraction/src/partial-result.ts`** (the spec's Files section) rather than in `kei-artifact.ts` (§5), importing the link code `kei-artifact.ts` now exports; the API validates its output against the wire schema inside the same best-effort boundary that catches kei's failures (§5: "a 404, a timeout or an error yields `null` and never fails the read").
10. **The route loads the run's passages with a per-process cache** keyed by the result manifest's mtime, so a two-second poll does not re-verify every page file; the route stays a plain `def` like its siblings, so FastAPI's threadpool waits, not the event loop. A result that cannot be loaded gives finished entries an empty `evidence` list.
11. **The Article grounding hook is a keyword on `grounding.verify` and its four wrappers** (`semantic`, `quoted`, `spans`, `off`), threaded from `ground_records` through `verify_routed`'s `**verification`: `on_batch(links)` after each batch's reply. §2 says "after each grounding batch (the links it made)"; the batches live inside `verify`.
12. **`partial` is optional-nullable on the read response** (`partialResultSchema.nullable().optional()`), as `reviewDraft` already is: the server always sets it (null unless RUNNING), and the dozens of mocked read responses in the client tests stay valid. Part B reads `response.partial ?? null`.
13. **Records are read by distance from the start page** (§4: "sorted by distance of their page from `start_page` (ties in source order)"); §1's shorter wording ("those on the start page first, then the rest in source order") is read as that rule. A start page beyond the document orders the work from the document's end.

## Review Focus

1. **kei's progress route answers slowly or not at all** (a model call holds the API's threadpool, kei restarting): `read()` returns `partial: null` within the two-second timeout and the attempt as before — Task 6 (the client's timeout) and Task 7 (the read's catch).
2. **A `loadAdmitted` checkpoint written before the column existed** replays `submitToKei` with the request it checkpointed: no `start_page` in the options, the step sequence unchanged — Task 5.
3. **`startPage` of `0`, `1.5`, `"6"` or beyond the document:** the first three are refused with 422 before admission (and by kei, strictly); a page beyond the document is admitted and only orders kei's work — Task 7 (422) and Task 1.
4. **A progress document or stage file outside the contract** (a kei newer or older than Studio, a half-written or empty file): the reader skips the file, `partialFromProgress` returns null, the read still answers 200 — Tasks 4, 6 and 7.
5. **A retried step leaves the previous attempt's stage files behind:** the reader shows only this execution's, so an old grounding link never vouches for a new value — Tasks 3 and 4.

---

## File structure

New, Parsing Service: `src/kei_exp/kie/extract/progress.py` (stage file names, the writer, the header, the stage models, the reader and `ProgressDocument`), `tests/test_extract_progress.py`, `tests/fixtures/contracts/extract.progress.json`.

Edited, Parsing Service: `pyproject.toml` (pytest `pythonpath`), `src/kei_exp/kie/extract/run.py` (`Options.start_page`, `dumped()`, `dispatch` hands `extraction_id` to Article), `kie/extract/unified.py` (work order, stage files, `entry_links`), `kie/extract/article.py` (`extraction_id`, `context_order`, `on_context` with the running assembly, stage files), `kie/extract/assembly.py` (`ground_records` `on_batch`), `kie/extract/grounding.py` (`verify` and wrappers `on_batch`), `api.py` (the route), `README.md`; tests `test_unified_catalog.py`, `test_contracts.py`, `test_api_reads.py`; fixture `extract.input.json`.

New, Node: `packages/extraction/src/partial-result.ts`, `packages/extraction/src/partial-result.test.ts`, `packages/db/migrations/app/<timestamp>_start_page/` (generated), `packages/db/src/start-page-migration.test.ts`.

Edited, Node: `packages/db/src/prisma/contract.prisma`, `packages/db/migrations/app/refs/db.json`, `packages/db/src/schema-revision-record-scope-migration.test.ts`; `packages/extraction/src/types.ts`, `workflows.ts`, `kei-artifact.ts`, `kei-exp.ts`, `postgres-admission.ts`, `postgres-attempts.ts`, `postgres-workflow-store.ts`, `index.ts`, `package.json`, `testing/kei-stand-in.ts`, `testing/extraction-fixture.ts`; tests `workflows.test.ts`, `kei-artifact.test.ts`, `module.test.ts`, `postgres-admission.integration.test.ts`, `kei-contract.integration.test.ts`; Studio `api/extractions.ts`, `shared/extraction.contract.ts`; tests `api/extractions.test.ts`, `api/_extractions.test.ts`, `api/document_reopen.test.ts`. (`kei-handoff.ts` is untouched: `keiExtractInputSchema.options` is already a record.)

---

### Task 1: `Options.start_page` on kei's request (§4, Constraints)

**Files:**
- Modify: `prototypes/parsing_service/src/kei_exp/kie/extract/run.py:43-78` (`Options`), `:180-203` (`dispatch`), `prototypes/parsing_service/pyproject.toml` (`[tool.pytest.ini_options]`)
- Modify: `prototypes/parsing_service/tests/fixtures/contracts/extract.input.json`
- Test: `prototypes/parsing_service/tests/test_unified_catalog.py` (beside `test_unified_options_refuse_legacy_limits_and_record_no_character_limits`, 838), `prototypes/parsing_service/tests/test_contracts.py:34-41`

**Interfaces:**
- Produces: `Options.start_page: int | None` (one-based, strict integer, `ge=1`), absent from `Options.dumped()`; `article.extract(..., extraction_id=...)` is called by `dispatch` with the extraction id (the keyword exists after Task 3; this task adds the call site together with a no-op keyword so the tree stays green).

- [ ] **Step 1: Write the failing tests.** In `tests/test_unified_catalog.py`, after `test_unified_options_refuse_legacy_limits_and_record_no_character_limits`:

```python
def test_a_start_page_is_a_strict_one_based_integer_that_the_artifact_never_records():
    """The start page orders the work (design §4); the artifact and its fingerprint are those of the request without it."""
    with_page = run.Options.model_validate({"strategy": "catalog", "unified": {"defaults": 1}, "start_page": 6})
    assert with_page.start_page == 6
    assert "start_page" not in with_page.dumped()
    assert with_page.dumped() == run.Options.model_validate({"strategy": "catalog", "unified": {"defaults": 1}}).dumped()
    assert run.Options.model_validate({"strategy": "article", "start_page": 400}).start_page == 400  # beyond the document: an order from its end
    for refused in (0, -1, "6", 6.0, True):  # strict, as UnifiedOptions is: a page is an integer, never coerced
        with pytest.raises(ValidationError):
            run.Options.model_validate({"strategy": "article", "start_page": refused})
```

Add `from pydantic import ValidationError` to the module's imports. In `tests/test_contracts.py`, extend `test_the_extract_fixture_carries_a_request_kei_accepts` with two lines before its last assertion:

```python
    assert request.options.start_page == 2  # Studio sends the page the researcher was reading; kei orders its work by it
    assert "start_page" not in request.options.dumped()
```

- [ ] **Step 2: Run them to verify they fail** — from `prototypes/parsing_service`: `/home/gennaro/projects/FREE/prototypes/parsing_service/.venv/bin/python -m pytest -q -o pythonpath=src tests/test_unified_catalog.py tests/test_contracts.py -k "start_page or fixture_carries"` → FAIL (`extra_forbidden` on `start_page`).

- [ ] **Step 3: `pyproject.toml`.** In `[tool.pytest.ini_options]` add, before `testpaths`:

```toml
# The sources beside the tests, first on the path: a worktree's tests read its own `src`, not the editable install of
# another checkout that a shared venv may hold.
pythonpath = ["src"]
```

Confirm from `prototypes/parsing_service`: `/home/gennaro/projects/FREE/prototypes/parsing_service/.venv/bin/python -m pytest -q tests/test_api_reads.py` → PASS (the fast tier's own command from here on).

- [ ] **Step 4: `run.py`.** In `Options`, after `unified: UnifiedOptions | None = None  # ...` (49):

```python
    # The page the researcher was reading when the run started, one-based: the order the unified Catalog reads its
    # entries and Article its bounded value contexts in (nearest first), never which of them are read. Excluded from
    # `dumped()`, so the artifact and its fingerprint are those of the same request without it (design §4). Strict,
    # as UnifiedOptions is: "6" is no page. A page beyond the document orders the work from the document's end.
    start_page: int | None = Field(default=None, ge=1, strict=True)
```

In `dumped()` (70-78), the first statement becomes:

```python
        result = self.model_dump(exclude={name for name in ("catalog", "article", "unified")
                                          if getattr(self, name) is None} | {"start_page"})
```

and the docstring gains the sentence `The start page is never recorded: it orders the work, not the result.` In `dispatch` (193-194) the Article call becomes:

```python
        result = article.extract(run_dir, evidence, request, chat, counter=counter, chunks=chunks,
                                 before_entry=before_entry, extraction_id=extraction_id)
```

and in `article.py:55-57` the signature gains `extraction_id: str | None = None` (unused until Task 3; add to the docstring's last sentence: `; \`extraction_id\` names the directory its stage files are published under (Task 3)`).

- [ ] **Step 5: The fixture.** In `tests/fixtures/contracts/extract.input.json` the options line becomes:

```json
      "options": {"strategy": "catalog", "catalog": {"recipe": "numbered-catalogue-de@1"}, "start_page": 2}
```

- [ ] **Step 6: Run the tests to verify they pass** — `/home/gennaro/projects/FREE/prototypes/parsing_service/.venv/bin/python -m pytest -q tests/test_unified_catalog.py tests/test_contracts.py tests/test_extract_workflow.py tests/test_article.py` → PASS. Then `cd packages/extraction && pnpm test` (the fixture round-trips through `keiExtractInputSchema`, whose `options` is a record) → PASS.

- [ ] **Step 7: Commit** — `feat(kei): a start page on the extract request, ordering the work and never recorded`.

---

### Task 2: The unified Catalog reads nearest the start page first and publishes its stages (§2, §4)

**Files:**
- Create: `prototypes/parsing_service/src/kei_exp/kie/extract/progress.py`
- Modify: `prototypes/parsing_service/src/kei_exp/kie/extract/unified.py:275-345` (`extract`), `:597-621` (`_entry_json`, `_work_of`), `:657-676` (`_Run.entry`), `:911-917` (`_link`)
- Test: `prototypes/parsing_service/tests/test_unified_catalog.py` (`request`/`extract` helpers 130-142; the globs at 966, 1042, 1048; new tests after `test_an_entry_with_a_failed_call_or_undecided_verdict_is_never_published_so_a_retry_asks_again`)

**Interfaces:**
- Produces: `progress.PROGRESS_NAME = "extraction-progress.json"`, `progress.reading_name(n)`, `progress.candidates_name(n)`, `progress.context_name(k)`, `progress.grounding_name(b)`, `progress.write_stage(path, record) -> None` (never raises for a write failure), `progress.started(directory, strategy, start_page) -> str` (the execution token), `progress.CANDIDATES_VERSION = 1`, `progress.ARTICLE_STAGE_VERSION = 1`, `progress.PROGRESS_VERSION = 1`; `unified.work_order(entries, pages, start_page) -> list[int]`; `unified.entry_links(record, passages) -> list[dict]`; `_Run.entry(number, entry, on_candidates: Callable[[_Work], None] | None = None)`.
- The reading marker: `{"version": 1, "execution", "index"}`. The candidates file: `{"version": 1, "execution", "index", "discovery_sha256", "ranges", "candidates": [{"path", "value", "quote", "window"}], "record", "failed"}` where `record` is `conform(_placed(found, "candidate"), nodes)` and `failed` the entry's failed values windows so far.
- Consumes: `Options.start_page` (Task 1).

- [ ] **Step 1: Write the failing tests.** In `tests/test_unified_catalog.py`, the helpers at 130-142 become:

```python
def request(schema=SCHEMA, start_page: int | None = None, **settings) -> run.ExtractRequest:
    return run.ExtractRequest.model_validate({"schema": schema, "options": {
        "strategy": "catalog", "unified": {"defaults": 1, **settings},
        **({"start_page": start_page} if start_page is not None else {})}})


def extract(source: Evidence, model=None, *, schema=SCHEMA, counter=None, run_dir=None, extraction_id=None,
            start_page: int | None = None, **settings):
    chat = CountingChat(model or Model(source))
    result = unified.extract(run_dir, source, request(schema, start_page, **settings), as_router(chat),
                             counter=counter or WordCounter(), extraction_id=extraction_id)
    assert_links_resolve(result)
    return result, chat
```

Add near `entry_file` (937):

```python
def entry_records(directory) -> list[str]:
    """The finished entry records: the partial view's stage files (`.reading`, `.candidates`) are not records."""
    return sorted(path.name for path in directory.glob("catalog-entry-*.json")
                  if re.fullmatch(r"catalog-entry-\d+\.v\d+\.json", path.name))
```

(not `finished`: `test_finished_entries_are_published_once_and_reused_after_a_crash` binds a local of that name, which would shadow the helper) and replace every `sorted(path.name for path in directory.glob("catalog-entry-*.json"))` (966, 1042, 1048) with `entry_records(directory)`. Then add, after `test_an_entry_with_a_failed_call_or_undecided_verdict_is_never_published_so_a_retry_asks_again`:

```python
def test_entries_are_read_nearest_the_start_page_first_and_assembled_in_source_order():
    source = evidence("1. Adorf. Material: Holz.", "2. Bdorf. Material: Stein.", "3. Cdorf. Material: Gold.")
    plain, _ = extract(source)
    ordered, chat = extract(source, start_page=3)
    asked = [section(call["user"], "RECORD")[:8] for call in chat.calls
             if call["system"].startswith("You extract structured data")]
    assert asked == ["3. Cdorf", "2. Bdorf", "1. Adorf"]  # distance from page 3, then source order
    assert [record["label"] for record in ordered["records"]] == ["1", "2", "3"]  # assembled in source order
    assert untimed(ordered) == untimed(plain)  # the same artifact, whatever the order of work
    assert unified.work_order([{"ranges": [{"segment": "p1_s0"}]}, {"ranges": [{"segment": "p3_s0"}]},
                               {"ranges": [{"segment": "p2_s0"}]}, {"ranges": []}],
                              {"p1_s0": 1, "p2_s0": 2, "p3_s0": 3}, 2) == [2, 0, 1, 3]  # unknown page last
    assert unified.work_order([{"ranges": [{"segment": "p3_s0"}]}, {"ranges": [{"segment": "p1_s0"}]}],
                              {"p1_s0": 1, "p3_s0": 3}, None) == [0, 1]  # no start page: source order


def test_each_entry_publishes_a_reading_marker_and_its_candidates_before_verification_and_a_retry_ignores_both(tmp_path):
    source = evidence("1. Adorf. Material: Holz.\n2. Bdorf. Material: Stein.")
    directory = tmp_path / "extractions" / "x1"
    model = Model(source)
    seen: dict[str, bool] = {}

    def failing_verification(system, user, schema):
        if system.startswith("You check values") and "Bdorf" in section(user, "RECORD"):
            seen["reading"] = (directory / progress.reading_name(1)).exists()
            seen["candidates"] = (directory / progress.candidates_name(1)).exists()
            raise requests.ConnectionError("connection reset")  # transient: the step is retried
        return model(system, user, schema)
    with pytest.raises(requests.ConnectionError):
        extract(source, failing_verification, run_dir=tmp_path, extraction_id="x1", start_page=1)
    assert seen == {"reading": True, "candidates": True}
    header = json.loads((directory / progress.PROGRESS_NAME).read_bytes())
    assert {key: header[key] for key in ("version", "strategy", "start_page")} == {"version": 1, "strategy": "catalog", "start_page": 1}
    written = json.loads((directory / progress.candidates_name(1)).read_bytes())
    assert (written["version"], written["execution"], written["index"], written["failed"]) == (1, header["execution"], 1, 0)
    assert written["ranges"] == json.loads((directory / "catalog-discovery.json").read_bytes())["entries"][1]["ranges"]
    assert {tuple(row["path"]) for row in written["candidates"]} == {("label",), ("site",), ("material",)}
    assert written["record"]["material"] == "Stein" and written["record"]["gilded"] is None  # conform fills every field
    assert json.loads((directory / progress.reading_name(1)).read_bytes()) == {"version": 1, "execution": header["execution"], "index": 1}
    assert entry_records(directory) == [entry_file(0)]  # entry 1 is not a record
    again, chat = extract(source, run_dir=tmp_path, extraction_id="x1")
    assert any("Bdorf" in section(call["user"], "RECORD") for call in chat.calls)  # asked again, the stage files ignored
    assert not any("Adorf" in section(call["user"], "RECORD") for call in chat.calls)
    assert again["records"][1]["material"] == "Stein" and entry_records(directory) == [entry_file(0), entry_file(1)]
    retried = json.loads((directory / progress.PROGRESS_NAME).read_bytes())
    assert retried["start_page"] is None and retried["execution"] != header["execution"]  # the retry's own header


def test_a_failed_values_window_is_counted_in_the_candidates_file(tmp_path):
    source = evidence("1. Adorf. Material: Holz.")
    model = Model(source)

    def refusing(system, user, schema):
        if system.startswith("You extract structured data"):
            raise server_error(500)  # the window fails and is halved; a one-unit window fails alone
        return model(system, user, schema)
    extract(source, refusing, run_dir=tmp_path, extraction_id="x1")
    written = json.loads((tmp_path / "extractions" / "x1" / progress.candidates_name(0)).read_bytes())
    assert written["failed"] >= 1 and written["candidates"] == [] and written["record"]["material"] is None


def test_a_stage_file_that_cannot_be_written_never_fails_the_extraction(tmp_path, monkeypatch):
    source = evidence("1. Adorf. Material: Holz.")

    @contextmanager
    def full_disk(target):
        raise OSError(28, "No space left on device", str(target))
        yield  # pragma: no cover
    monkeypatch.setattr(progress, "publish", full_disk)
    result, _ = extract(source, run_dir=tmp_path, extraction_id="x1")
    assert result["records"][0]["material"] == "Holz" and result["complete"] is True
    directory = tmp_path / "extractions" / "x1"
    assert not (directory / progress.PROGRESS_NAME).exists() and not (directory / progress.candidates_name(0)).exists()
    assert entry_records(directory) == [entry_file(0)]  # the write-once records are not stage files


def test_entry_links_are_the_artifacts_links_for_that_entry(tmp_path):
    source = evidence("1. Adorf. Material: Holz.\n2. Bdorf. Material: Stein.")
    result, _ = extract(source, run_dir=tmp_path, extraction_id="x1")
    passages = {passage.id: passage for passage in source.passages}
    published = json.loads((tmp_path / "extractions" / "x1" / entry_file(1)).read_bytes())
    assert unified.entry_links(published, passages) == [link for link in result["evidence"] if link["path"][1] == 1]
```

Add `from contextlib import contextmanager` and `from kei_exp.kie.extract import discovery, progress, run, unified` (replacing the existing `discovery, run, unified` line) to the imports; `server_error` exists in the module (791).

- [ ] **Step 2: Run them to verify they fail** — `pytest tests/test_unified_catalog.py -k "start_page or reading_marker or failed_values_window or cannot_be_written or entry_links or published_once or never_published or persistent_server"` → FAIL (`progress` has no attribute; `work_order` missing).

- [ ] **Step 3: `kie/extract/progress.py`** (the leaf module: nothing here imports `unified` or `article` at load, since both import these names):

```python
"""What a running extraction publishes for Studio's partial view, and (Task 4) the reader behind
`GET /api/runs/{run}/extractions/{id}/progress` (design, *What kei publishes during a run*, *kei's progress route*).

Stage files are best effort for the view only: written by atomic rename, a write that fails logged and dropped, never
read by a resume path (`unified.read` and `_entry_reusable` know only `entry_name`), and removed with the extraction
directory by garbage collection. Every file carries the token of the execution that wrote it: the header is written
first by each execution of the step, and the reader skips files of another execution, so a retry's view never mixes
with the previous attempt's. Under `runs/<run>/extractions/<extraction>/`:

  extraction-progress.json                the strategy, the start page and this execution's token, written first
  catalog-entry-<n>.reading.v1.json       the entry's values windows are in flight
  catalog-entry-<n>.candidates.v1.json    the values call returned these candidates; verification runs
  article-context-<k>.v1.json             one value context's answered fields and the root assembled so far
  article-grounding-<b>.v1.json           the links one grounding batch made
"""
from __future__ import annotations

import logging
import secrets
from pathlib import Path

from kei_exp.canonical import canonical_json
from kei_exp.files import publish

PROGRESS_VERSION = 1       # the header's layout
CANDIDATES_VERSION = 1     # the reading marker's and the candidates file's layout
ARTICLE_STAGE_VERSION = 1  # the context and grounding files' layout
PROGRESS_NAME = "extraction-progress.json"
_LOG = logging.getLogger(__name__)


def reading_name(number: int) -> str:
    return f"catalog-entry-{number}.reading.v{CANDIDATES_VERSION}.json"


def candidates_name(number: int) -> str:
    """Distinct from `unified.entry_name`, so no resume path can mistake it for a finished entry."""
    return f"catalog-entry-{number}.candidates.v{CANDIDATES_VERSION}.json"


def context_name(index: int) -> str:
    return f"article-context-{index}.v{ARTICLE_STAGE_VERSION}.json"


def grounding_name(batch: int) -> str:
    return f"article-grounding-{batch}.v{ARTICLE_STAGE_VERSION}.json"


def write_stage(path: Path, record: dict) -> None:
    """`record` at `path`, renamed into place: a reader finds the previous file or the whole new one, never a part.
    Best effort: a write that fails (a full disk, a permission) is logged and dropped; the extraction never fails for
    its view (design, Error handling)."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with publish(path) as part:
            part.write_bytes(canonical_json(record))
    except OSError as error:
        _LOG.warning("progress stage %s not written: %s", path.name, error)


def started(directory: Path, strategy: str, start_page: int | None) -> str:
    """The header every reader starts from, and the token this execution marks its stage files with."""
    execution = secrets.token_hex(8)
    write_stage(directory / PROGRESS_NAME, {"version": PROGRESS_VERSION, "execution": execution, "strategy": strategy,
                                            "start_page": start_page})
    return execution
```

- [ ] **Step 4: `unified.py`.** Imports: add `from kei_exp.kie.extract import discovery, progress` (replacing `from kei_exp.kie.extract import discovery`). In `extract` (275-345):

1. After `directory = run_dir / "extractions" / extraction_id if run_dir is not None and extraction_id else None` (287) add:

```python
    # Not `execution`: that name is the execution record, assigned a few lines below.
    stage_execution = progress.started(directory, "catalog", request.options.start_page) if directory is not None else None
```

2. `read` (312-324) becomes:

```python
    def read(number: int, entry: dict) -> _Work:
        """A published entry's work, or the entry read now: published only when nothing in it failed or stayed
        undecided, so a retry of the step asks again for an entry a failed call or window left short. The reading
        marker and the candidates file are the partial view's (design §2): written here, read by no resume path."""
        if directory is None:
            return run.entry(number, entry)
        path = directory / entry_name(number)
        if path.exists():
            return _work_of(_published(path, dict, _entry_reusable(number, entry, discovery_sha256)), run.nodes)
        progress.write_stage(directory / progress.reading_name(number),
                             {"version": progress.CANDIDATES_VERSION, "execution": stage_execution, "index": number})
        work = run.entry(number, entry, on_candidates=partial(_candidates_stage, directory, stage_execution, number, entry,
                                                              discovery_sha256, run.nodes))
        record = _entry_json(number, entry, discovery_sha256, work)
        if work.failed or work.undecided or any(not call.ok for call in work.calls):
            return _work_of(json.loads(canonical_json(record)), run.nodes)  # read as a published one is, unpublished
        return _work_of(_publish(path, record), run.nodes)  # one published first meanwhile is a conflict
```

3. The pool (332-333) becomes:

```python
    pages = {passage.id: passage.page for passage in (*evidence.passages, *evidence.withheld)}
    with ThreadPoolExecutor(max_workers=max(1, chunks), thread_name_prefix="catalog-entry") as pool:
        futures: list = [None] * len(found["entries"])
        for number in work_order(found["entries"], pages, request.options.start_page):
            futures[number] = pool.submit(one, (number, found["entries"][number]))
```

(`futures` keeps source order for the loops that follow it; the pool runs submissions in submission order.) The docstring's last sentence becomes `Entries run \`chunks\` at a time, nearest \`options.start_page\` first (\`work_order\`), assembled in source order.`

4. Add after `_entry_reusable` (264-269):

```python
def work_order(entries: list[dict], pages: dict[str, int], start_page: int | None) -> list[int]:
    """Entry indices in the order they are read (design §4): by distance of each entry's first page from `start_page`,
    an entry whose page is unknown last, ties in source order; without a start page, source order. Assembly keeps
    source order whatever this returns, so the artifact is the same."""
    def distance(number: int) -> tuple[float, int]:
        ranges = entries[number].get("ranges") or []
        page = pages.get(ranges[0]["segment"]) if ranges else None
        return (0.0 if start_page is None else abs(page - start_page) if page is not None else float("inf"), number)
    return sorted(range(len(entries)), key=distance)


def _candidates_stage(directory: Path, execution: str, number: int, entry: dict, discovery_sha256: str,
                      nodes: list[Node], work: _Work) -> None:
    """The entry's candidates after its values windows and before verification (design §2): the partial view shows
    them as candidates, visibly so, and knows from `failed` whether a window left fields unknown. `read` never looks
    at this file; a retried values call rewrites it."""
    progress.write_stage(directory / progress.candidates_name(number), {
        "version": progress.CANDIDATES_VERSION, "execution": execution, "index": number,
        "discovery_sha256": discovery_sha256, "ranges": entry["ranges"],
        "candidates": [{"path": list(each.path), "value": each.value, "quote": each.quote, "window": each.window}
                       for each in work.found if each.kind == "candidate"],
        "record": conform(_placed(work.found, "candidate"), nodes), "failed": work.failed})
```

(`Path` is already imported; `Node`, `conform` and `_placed` exist in the module.)

5. `_work_of` (612-621) splits so the route can share its row decoding:

```python
def _found_of(rows: list[dict]) -> list[_Found]:
    return [_Found(tuple(row["path"]), row["value"], row["quote"], row["window"], _spans_from(row["spans"]),
                   [_spans_from(spans) for spans in row["alternatives"]], row["support"], row["kind"], row["reason"],
                   None if row["item"] is None else (tuple(row["item"][0]), *row["item"][1:]),
                   None if row["anchor"] is None else tuple(tuple(place) for place in row["anchor"]))
            for row in rows]


def _work_of(record: dict, nodes: list[Node]) -> _Work:
    work = record["work"]
    return _Work(_found_of(work["found"]), conform(work["record"], nodes), work["contest"], work["items"],
                 work["omitted"], [_call_of(call) for call in work["calls"]],
                 [_issue_of(issue) for issue in work["issues"]], work["windows"], work["failed"], work["undecided"])


def entry_links(record: dict, passages: dict) -> list[dict]:
    """The evidence links a published entry record's accepted values make, exactly as `_artifact` writes them, so the
    partial view converts them with the artifact's own code (design §3). `passages` maps segment ids to passages."""
    return [_link(each, record["index"], passages) for each in _found_of(record["work"]["found"])
            if each.kind == "accepted"]
```

6. `_Run.entry` (657-676) gains the hook: signature `def entry(self, number: int, entry: dict, on_candidates: Callable[[_Work], None] | None = None) -> _Work:` and, right after `out.found, out.items = _merged(found, view, _edges(replies), out.issues, number)`:

```python
        if on_candidates is not None:
            on_candidates(out)
```

- [ ] **Step 5: Run the tests to verify they pass** — `pytest tests/test_unified_catalog.py tests/test_extract_workflow.py` → PASS (every existing test too: the globs now ignore the stage files).

- [ ] **Step 6: Commit** — `feat(kei): the unified Catalog reads nearest the start page first and publishes each entry's reading and candidates stages`.

---

### Task 3: Article publishes its contexts, the root assembled so far, and its grounding batches, nearest the start page first (§2, §4)

**Files:**
- Modify: `prototypes/parsing_service/src/kei_exp/kie/extract/article.py:14-37` (imports), `:55-150` (`extract`), `:155-208` (`document_root`)
- Modify: `prototypes/parsing_service/src/kei_exp/kie/extract/assembly.py:126-178` (`ground_records`)
- Modify: `prototypes/parsing_service/src/kei_exp/kie/extract/grounding.py:161-338` (`verify`), `:351-390` (the four wrappers)
- Test: `prototypes/parsing_service/tests/test_extract_progress.py` (new)

**Interfaces:**
- Consumes: `progress.started`, `progress.write_stage`, `progress.context_name`, `progress.grounding_name`, `progress.ARTICLE_STAGE_VERSION` (Task 2); `article.extract(..., extraction_id=None)` (Task 1).
- Produces: `article.context_order(groups, start_page) -> list[int]`; `document_root(..., start_page=None, on_context=None)` where `on_context(index, total, answered, failed, group, fields, root, contested, ok, calls)` runs after each value context's call with the root assembled and conformed over the contexts answered so far, its scalar conflicts, and `failed`, the number of those contexts whose call failed (cumulative, so a dropped stage write loses no failure); `ground_records(..., on_batch=None)`; `grounding.verify(..., on_batch=None)` and the same keyword on `semantic`, `quoted`, `spans`, `off`, where `on_batch(links)` runs after each batch's reply with the links that batch made.
- The context file: `{"version": 1, "execution", "context", "of", "answered", "failed", "passages", "fields", "root", "contested": [{"path", "candidates"}], "ok", "calls"}`. The grounding file: `{"version": 1, "execution", "links": [artifact link dicts]}`.

- [ ] **Step 1: Write the failing tests.** `tests/test_extract_progress.py`:

```python
"""The stage files a running extraction publishes for Studio's partial view, and (Task 4) the reader that serves them."""
import json

import pytest

from kei_exp.kie.extract import article, progress, run
from kei_exp.kie.extract.contexts import Context
from kei_exp.kie.extract.llm import Reply
from kei_exp.kie.extract.models import Router
from kei_exp.kie.passages import Passage
from tests.test_extract_grounded import CountingChat, WordCounter
from tests.test_extract_stages import SCHEMA, evidence, passages


def page(number: int, text: str | None = None) -> Passage:
    return Passage(id=f"p{number}_s0", page=number, index=0, text=text or f"Page {number}.", label="Text",
                   bbox_pt=(0, 0, 100, 100), extent="block")


def test_value_contexts_are_called_nearest_the_start_page_first_and_assembled_in_source_order():
    groups = [Context((page(1), page(2))), Context((page(3),)), Context((page(4), page(5)))]
    assert article.context_order(groups, 3) == [1, 0, 2]      # page 3 first; pages 2 and 4 tie, source order wins
    assert article.context_order(groups, 5) == [2, 1, 0]
    assert article.context_order(groups, None) == [0, 1, 2]   # no start page: source order
    assert article.context_order([Context(())], 2) == [0]     # an empty context has no page: it is last, and alone


def test_each_context_publishes_the_root_assembled_so_far_in_the_order_contexts_are_called():
    first, second = page(1, "31. Hill. Finds: spear."), page(2, "Results: Hill 1828.")
    told: list[tuple] = []

    def fields(system, user, schema):
        if "Results" in user:
            return {"entry_no": None, "site": "Hill", "year": 1828, "finds": []}
        return {"entry_no": "31", "site": "Hill", "year": None, "finds": ["spear"]}
    article.document_root([first, second], SCHEMA, CountingChat(fields), counters={role: WordCounter() for role in ("fields", "reasoning")},
                          record_chars=24_000, check=lambda: None, contexts=[Context((first,)), Context((second,))],
                          start_page=2, on_context=lambda *call: told.append(call))
    assert [(index, total, answered) for index, total, answered, *_ in told] == [(1, 2, 1), (0, 2, 2)]  # page 2 first
    (_, _, _, failed_1, group, fields_1, root_1, contested_1, ok_1, calls_1), (_, _, _, failed_2, _, _, root_2, contested_2, ok_2, _) = told
    assert group.passages == (second,) and fields_1["year"] == 1828 and ok_1 and [call.stage for call in calls_1] == ["record"]
    assert root_1 == {"entry_no": None, "site": "Hill", "year": 1828, "finds": None} and contested_1 == []  # conform: an empty list is None
    assert root_2 == {"entry_no": "31", "site": "Hill", "year": 1828, "finds": ["spear"]} and contested_2 == [] and ok_2
    assert failed_1 == 0 and failed_2 == 0

    def disagreeing(system, user, schema):
        return {"entry_no": None, "site": "Brook" if "Results" in user else "Hill", "year": None, "finds": []}
    told.clear()
    article.document_root([first, second], SCHEMA, CountingChat(disagreeing), counters={role: WordCounter() for role in ("fields", "reasoning")},
                          record_chars=24_000, check=lambda: None, contexts=[Context((first,)), Context((second,))],
                          start_page=None, on_context=lambda *call: told.append(call))
    assert told[-1][6]["site"] is None and told[-1][7] == [{"path": ["site"], "candidates": ["Hill", "Brook"]}]

    def failing_first(system, user, schema):
        if "Results" not in user:  # the first context's call fails: a reply that is no JSON is a failed call (`calls.complete`)
            return Reply(text="{not json", input_tokens=10, output_tokens=1, finish="stop", seconds=0.0)
        return {"entry_no": None, "site": "Hill", "year": 1828, "finds": []}
    told.clear()
    article.document_root([first, second], SCHEMA, CountingChat(failing_first), counters={role: WordCounter() for role in ("fields", "reasoning")},
                          record_chars=24_000, check=lambda: None, contexts=[Context((first,)), Context((second,))],
                          start_page=None, on_context=lambda *call: told.append(call))
    assert [(answered, failed, ok) for _, _, answered, failed, _, _, _, _, ok, _ in told] == [(1, 1, False), (2, 1, True)]  # failed is cumulative


def test_article_publishes_the_header_each_context_and_each_grounding_batch_for_the_partial_view(tmp_path):
    source = passages(["31. Hill; 32. Brook.", "Results: Hill 1827. Brook 1828."])
    directory = tmp_path / "extractions" / "x2"

    def fields(system, user, schema):
        if "title" in schema["properties"]:
            return {"title": "Sites"}
        return {"entry_no": "31", "site": "Hill", "year": 1827, "finds": ["spear"]}

    def reason(system, user, schema):
        assert (directory / progress.context_name(0)).exists()  # the context file is there before grounding asks
        return {claim: "E1" for claim in schema["properties"]}
    request = run.ExtractRequest(schema=SCHEMA, options={"strategy": "article", "start_page": 2})
    result = article.extract(tmp_path, evidence(source), request, Router(CountingChat(fields), CountingChat(reason)),
                             counter={role: WordCounter() for role in ("fields", "reasoning")}, extraction_id="x2")
    header = json.loads((directory / progress.PROGRESS_NAME).read_bytes())
    assert {key: header[key] for key in ("version", "strategy", "start_page")} == {"version": 1, "strategy": "article", "start_page": 2}
    context = json.loads((directory / progress.context_name(0)).read_bytes())
    assert (context["version"], context["execution"], context["context"], context["of"], context["answered"], context["failed"], context["ok"]) == \
        (1, header["execution"], 0, 1, 1, 0, True)
    assert context["fields"]["site"] == "Hill" and context["root"]["finds"] == ["spear"] and context["contested"] == []
    assert context["passages"]["primary"] == ["p1_s0", "p1_s1"] and [call["stage"] for call in context["calls"]] == ["record"]
    batches = sorted(directory.glob("article-grounding-*.v1.json"))
    assert batches and all(json.loads(batch.read_bytes())["execution"] == header["execution"] for batch in batches)
    published = [link for batch in batches for link in json.loads(batch.read_bytes())["links"]]
    assert published == result["evidence"]  # the links a batch made, as the artifact writes them
    assert all(link["linked_by"] == "model" and link["segment"] == "p1_s0" for link in published)


def test_without_an_extraction_id_article_publishes_nothing(tmp_path):
    source = passages(["31. Hill."])
    chat = CountingChat(lambda system, user, schema: {"title": "T"} if "title" in schema["properties"]
                        else {claim: "NONE" for claim in schema["properties"]} if "C1" in schema["properties"]
                        else {"entry_no": "31", "site": "Hill", "year": None, "finds": []})
    request = run.ExtractRequest(schema=SCHEMA, options={"strategy": "article"})
    article.extract(tmp_path, evidence(source), request, Router(chat, chat),
                    counter={role: WordCounter() for role in ("fields", "reasoning")})
    assert not (tmp_path / "extractions").exists()
```

- [ ] **Step 2: Run them to verify they fail** — `pytest tests/test_extract_progress.py` → FAIL (`context_order` missing; `document_root` takes no `start_page`).

- [ ] **Step 3: `grounding.py`.** `verify` (161-166) gains the keyword `on_batch: Callable[[Sequence[Link]], None] | None = None` after `projected: bool = False`; the docstring gains `\`on_batch\`, when given, runs after each batch's reply with the links that batch made (the partial view's grounding stage, design §2).` In the `while batches:` loop, record `made_before = len(links)` right after `batch = batches.pop(0)`, and at the very end of the loop body (after the `for claim in batch:` loop, inside `while`) add:

```python
        if on_batch is not None:
            on_batch(links[made_before:])
```

(The two `continue` statements before the model call skip it: a batch that was split or refused made no links.) Each of `semantic`, `quoted`, `spans` and `off` (351-390) gains the same keyword `on_batch: Callable[[Sequence[Link]], None] | None = None` after `projected: bool = False` and passes `on_batch=on_batch` into its `verify(...)` call; `off` accepts and ignores it.

- [ ] **Step 4: `assembly.py`.** `ground_records` (126-130) gains `on_batch: Callable[[Sequence[Link]], None] | None = None` after `resume: frozenset = frozenset()`; the docstring gains `\`on_batch\` runs after each grounding batch with the links it made.`; `verification = dict(...)` (153-155) gains `on_batch=on_batch`.

- [ ] **Step 5: `article.py`.** Imports: add `from dataclasses import asdict, dataclass`, `from functools import partial`, `from itertools import count`, `from kei_exp.kie.extract import progress`, and `Link` to the names imported from `stages`. `extract` (55-150):

1. The docstring's last sentence becomes: `\`chunks\` is not used: Article runs unsplit. With \`run_dir\` and \`extraction_id\`, the header, each value context's answered fields with the root assembled so far, and each grounding batch's links are published under the extraction directory for the partial view (design §2); \`options.start_page\` orders bounded value contexts, nearest first.`
2. After `method = options.article or REFERENCE` (66) add:

```python
    directory = run_dir / "extractions" / extraction_id if run_dir is not None and extraction_id else None
    execution = progress.started(directory, "article", options.start_page) if directory is not None else None
```

3. The `document_root(...)` call (92-93) gains `start_page=options.start_page, on_context=partial(_context_stage, directory, execution) if directory is not None else None`.
4. The `ground_records(...)` call (100-102) gains `on_batch=partial(_grounding_stage, directory, execution, count()) if directory is not None else None`.
5. Add after `extract` (before `document_root`):

```python
def _context_stage(directory: Path, execution: str, index: int, total: int, answered: int, failed: int, group: Context,
                   fields: dict, root: dict, contested: list[dict], ok: bool, calls: list[Call]) -> None:
    """One value context's answered fields and the root assembled so far, for the partial view (design §2); read by
    no path of this module. `ok` is false when this context's call failed; `failed` counts every failed context so far,
    so the latest file alone says whether unknown fields remain even when an earlier file's write was dropped."""
    progress.write_stage(directory / progress.context_name(index), {
        "version": progress.ARTICLE_STAGE_VERSION, "execution": execution, "context": index, "of": total,
        "answered": answered, "failed": failed, "passages": group.dumped(), "fields": fields, "root": root,
        "contested": contested, "ok": ok, "calls": [asdict(call) for call in calls]})


def _grounding_stage(directory: Path, execution: str, batches: count, links: Sequence[Link]) -> None:
    """The links one grounding batch made, as the artifact writes a link (`assembly.artifact`)."""
    progress.write_stage(directory / progress.grounding_name(next(batches)), {
        "version": progress.ARTICLE_STAGE_VERSION, "execution": execution,
        "links": [{**asdict(link), "path": list(link.path), "bbox_pt": list(link.bbox_pt)} for link in links]})


def context_order(groups: Sequence[Context], start_page: int | None) -> list[int]:
    """Value contexts in the order they are called (design §4): nearest `start_page` first (a context's distance is
    its nearest page's), a context without a page last, ties in source order; without a start page, source order.
    Answers are assembled in source order whatever this returns."""
    def distance(index: int) -> tuple[float, int]:
        pages = [passage.page for passage in groups[index].passages]
        return (0.0 if start_page is None else min((abs(page - start_page) for page in pages), default=float("inf")),
                index)
    return sorted(range(len(groups)), key=distance)
```

6. `document_root` (155-158) gains `start_page: int | None = None, on_context: Callable[..., None] | None = None` after `contexts: list[Context] | None = None`; its docstring gains `With \`on_context\`, after each value context's call, the root assembled by \`assemble_document\` and conformed over the contexts answered so far is reported with its scalar conflicts and the number of those contexts whose call failed: the partial view's reading of the document before the last context answers.` Its loop (186-193) becomes:

```python
    candidates: list[dict] = [{} for _ in groups]
    answered: list[tuple[list[Call], list[Issue]] | None] = [None] * len(groups)
    for index in context_order(groups, start_page):
        group = groups[index]
        check()
        fields, attempts, problems = extract_record(group.passages, schema, chat, budget=record_chars, record=0,
            counter=counters["fields"], structured=structured, document=True)
        candidates[index], answered[index] = fields, (attempts, problems)
        if on_context is not None:
            done = [number for number, each in enumerate(answered) if each is not None]  # source order
            so_far, conflicts, _, _ = (assemble_document([candidates[number] for number in done], sharing([groups[number] for number in done]))
                                       if len(done) != 1 else (candidates[done[0]], [], [], []))
            failed = sum(not all(call.ok for call in answered[number][0]) for number in done)  # cumulative
            on_context(index, len(groups), len(done), failed, group, fields, conform(so_far, schema.record_nodes), conflicts,
                       all(call.ok for call in attempts), attempts)
    for each in answered:  # calls and issues in source order: the artifact is the same whatever the order of work
        if each is not None:
            calls += each[0]
            issues += each[1]
```

(the names `calls`, `issues` already exist above the loop; delete the earlier `candidates = []` initialisation; the `root, contested, repeats, joined = …` assembly after the loop is unchanged).

- [ ] **Step 6: Run the tests to verify they pass** — `pytest tests/test_extract_progress.py tests/test_article.py tests/test_extract_workflow.py tests/test_extraction_grounding.py tests/test_article_grounding_negative.py` → PASS.

- [ ] **Step 7: Commit** — `feat(kei): Article calls bounded contexts nearest the start page first and publishes its contexts, the root so far and its grounding batches`.

---

### Task 4: The progress reader, the progress route and the shared progress fixture (§3)

**Files:**
- Modify: `prototypes/parsing_service/src/kei_exp/kie/extract/progress.py` (the stage models, the reader and `ProgressDocument`), `prototypes/parsing_service/src/kei_exp/api.py:104-113` (after `run_extraction`), `prototypes/parsing_service/README.md:89-93, 183-188`
- Create: `prototypes/parsing_service/tests/fixtures/contracts/extract.progress.json`
- Test: `prototypes/parsing_service/tests/test_extract_progress.py`, `prototypes/parsing_service/tests/test_api_reads.py`, `prototypes/parsing_service/tests/test_contracts.py`

**Interfaces:**
- Produces: `progress.read_progress(run_dir: Path, extraction_id: str) -> dict | None` and `progress.ProgressDocument` (pydantic); `GET /api/runs/{run_id}/extractions/{extraction_id}/progress` → 404 `no progress yet` / 404 `no such run` / 404 `no such extraction` / 200 the document; the fixture `extract.progress.json` both sides read (Task 6).
- The document: `{"version": 1, "strategy", "started_at_page", "discovered", "finished", "entries": [{"index", "label", "page", "stage": "queued"|"reading"|"candidates"|"finished", "candidates", "record", "evidence", "contested": [{"path", "candidates"}] | null, "failed": int | null}], "document": {"contexts", "answered", "of", "failed_contexts", "links", "grounding_batches"} | null}`. `contested` paths are record-relative; `failed` is the entry's failed values windows (Catalog, candidates stage) or failed contexts (Article, from the latest context file's cumulative count). Article's `evidence`, `links` and `grounding_batches` are attached only once the latest context file shows every context answered (`answered == of`): grounding verifies the final root (`article.extract` grounds `extracted.slices` after `document_root`), so a link's path belongs to that root alone, and an earlier root must never wear it.
- Consumes: `unified.entry_name`, `unified.entry_links` (Task 2), the stage files of Tasks 2 and 3.

- [ ] **Step 1: The fixture.** `tests/fixtures/contracts/extract.progress.json`, one entry per stage, as the reader writes it for the `test_unified_catalog` schema (`label`, `site`, `material`, `gilded`, `finds[].name`, `finds[].count`, document `title`) with the work started from page 1; the second entry's site is a contest arbitration left unresolved:

```json
{
  "version": 1,
  "strategy": "catalog",
  "started_at_page": 1,
  "discovered": 5,
  "finished": 2,
  "entries": [
    {
      "index": 0, "label": "1", "page": 1, "stage": "finished", "candidates": null,
      "record": {"label": "1", "site": "Adorf", "material": "Holz", "gilded": null, "finds": [{"name": "Nadel", "count": 2}]},
      "evidence": [
        {"path": ["records", 0, "label"], "segment": "p1_s0", "page": 1, "bbox_pt": [0.0, 0.0, 1.0, 1.0], "cell": null,
         "precision": "segment", "hits": 1, "spans": [{"segment": "p1_s0", "start": 0, "end": 1}], "alternatives": [],
         "raw": "1", "verbatim": true, "support": "literal", "linked_by": "verification", "item": null},
        {"path": ["records", 0, "site"], "segment": "p1_s0", "page": 1, "bbox_pt": [0.0, 0.0, 1.0, 1.0], "cell": null,
         "precision": "segment", "hits": 1, "spans": [{"segment": "p1_s0", "start": 3, "end": 8}], "alternatives": [],
         "raw": "Adorf", "verbatim": true, "support": "literal", "linked_by": "verification", "item": null},
        {"path": ["records", 0, "material"], "segment": "p1_s0", "page": 1, "bbox_pt": [0.0, 0.0, 1.0, 1.0], "cell": null,
         "precision": "segment", "hits": 1, "spans": [{"segment": "p1_s0", "start": 20, "end": 24}], "alternatives": [],
         "raw": "Holz", "verbatim": true, "support": "literal", "linked_by": "verification", "item": null},
        {"path": ["records", 0, "finds", 0, "name"], "segment": "p1_s0", "page": 1, "bbox_pt": [0.0, 0.0, 1.0, 1.0], "cell": null,
         "precision": "segment", "hits": 1, "spans": [{"segment": "p1_s0", "start": 32, "end": 37}], "alternatives": [],
         "raw": "Nadel", "verbatim": true, "support": "literal", "linked_by": "verification",
         "item": [{"segment": "p1_s0", "start": 26, "end": 42}]},
        {"path": ["records", 0, "finds", 0, "count"], "segment": "p1_s0", "page": 1, "bbox_pt": [0.0, 0.0, 1.0, 1.0], "cell": null,
         "precision": "segment", "hits": 1, "spans": [{"segment": "p1_s0", "start": 39, "end": 40}], "alternatives": [],
         "raw": "2", "verbatim": true, "support": "literal", "linked_by": "verification",
         "item": [{"segment": "p1_s0", "start": 26, "end": 42}]}
      ],
      "contested": [], "failed": null
    },
    {
      "index": 1, "label": "2", "page": 1, "stage": "finished", "candidates": null,
      "record": {"label": "2", "site": null, "material": "Stein", "gilded": true, "finds": []},
      "evidence": [
        {"path": ["records", 1, "label"], "segment": "p1_s1", "page": 1, "bbox_pt": [0.0, 1.0, 1.0, 2.0], "cell": null,
         "precision": "segment", "hits": 1, "spans": [{"segment": "p1_s1", "start": 0, "end": 1}], "alternatives": [],
         "raw": "2", "verbatim": true, "support": "literal", "linked_by": "verification", "item": null},
        {"path": ["records", 1, "material"], "segment": "p1_s1", "page": 1, "bbox_pt": [0.0, 1.0, 1.0, 2.0], "cell": null,
         "precision": "segment", "hits": 1, "spans": [{"segment": "p1_s1", "start": 20, "end": 25}], "alternatives": [],
         "raw": "Stein", "verbatim": true, "support": "literal", "linked_by": "verification", "item": null},
        {"path": ["records", 1, "gilded"], "segment": "p1_s1", "page": 1, "bbox_pt": [0.0, 1.0, 1.0, 2.0], "cell": null,
         "precision": "segment", "hits": 1, "spans": [{"segment": "p1_s1", "start": 27, "end": 33}], "alternatives": [],
         "raw": "Gilded", "verbatim": false, "support": "supporting", "linked_by": "verification", "item": null}
      ],
      "contested": [{"path": ["site"], "candidates": ["Bdorf", "Bdorf-Nord"]}], "failed": null
    },
    {
      "index": 2, "label": "3", "page": 2, "stage": "candidates",
      "candidates": [
        {"path": ["label"], "value": "3", "quote": "3.", "window": 0},
        {"path": ["material"], "value": "Gold", "quote": "Material: Gold", "window": 0}
      ],
      "record": {"label": "3", "site": null, "material": "Gold", "gilded": null, "finds": []},
      "evidence": null, "contested": null, "failed": 0
    },
    {"index": 3, "label": "4", "page": 3, "stage": "reading", "candidates": null, "record": null, "evidence": null, "contested": null, "failed": null},
    {"index": 4, "label": null, "page": 4, "stage": "queued", "candidates": null, "record": null, "evidence": null, "contested": null, "failed": null}
  ],
  "document": null
}
```

- [ ] **Step 2: Write the failing tests.** In `tests/test_contracts.py` add:

```python
def test_the_progress_fixture_is_a_valid_progress_document_with_one_entry_per_stage():
    from kei_exp.kie.extract.progress import ProgressDocument
    data = fixture("extract.progress")
    document = ProgressDocument.model_validate(data)
    assert document.model_dump(mode="json") == data
    assert [entry.stage for entry in document.entries] == ["finished", "finished", "candidates", "reading", "queued"]
    assert document.finished == 2 and document.discovered == len(document.entries)
    assert document.entries[1].contested == [{"path": ["site"], "candidates": ["Bdorf", "Bdorf-Nord"]}]
```

In `tests/test_extract_progress.py` add (imports: `requests`, `from kei_exp import runs`, `from kei_exp.kie.extract import unified`, `from kei_exp.kie.extract.models import as_router`, `from kei_exp.kie.passages import load`, `from tests.helpers import kei as kei_helper`, `from tests.test_unified_catalog import Model, evidence as unified_evidence, extract as unified_extract, request as unified_request, section`):

```python
def test_the_catalog_progress_names_each_entry_stage_and_the_finished_entries_links(tmp_path, monkeypatch):
    monkeypatch.setattr(runs, "RUNS", tmp_path)
    run_id = kei_helper.converted_run(tmp_path, "kei-convert:ingest:p:a")
    run_dir = tmp_path / run_id
    source = load(run_dir)
    model = Model(source)
    read: list[str] = []

    def failing_third_verification(system, user, schema):
        record = section(user, "RECORD")
        if system.startswith("You extract structured data"):
            read.append(record)
        if system.startswith("You check values") and len(read) == 3 and record == read[2]:
            raise requests.ConnectionError("connection reset")  # transient: entries 0 and 1 finished, entry 2 has candidates
        return model(system, user, schema)
    assert progress.read_progress(run_dir, "x-1") is None  # nothing published yet
    with pytest.raises(requests.ConnectionError):
        unified.extract(run_dir, source, unified_request(start_page=1), as_router(CountingChat(failing_third_verification)),
                        counter=WordCounter(), extraction_id="x-1")
    document = progress.read_progress(run_dir, "x-1")
    progress.ProgressDocument.model_validate(document)
    assert (document["strategy"], document["started_at_page"], document["discovered"], document["finished"]) == ("catalog", 1, 5, 2)
    assert [entry["stage"] for entry in document["entries"]] == ["finished", "finished", "candidates", "queued", "queued"]
    first, third, last = document["entries"][0], document["entries"][2], document["entries"][4]
    discovered = json.loads((run_dir / "extractions" / "x-1" / "catalog-discovery.json").read_bytes())
    first_segment = discovered["entries"][0]["ranges"][0]["segment"]  # an entry's page is its first range's passage's
    assert first["index"] == 0 and first["page"] == int(first_segment[1:].split("_s")[0])
    assert set(first["record"]) >= {"label", "site", "material", "gilded", "finds"} and first["contested"] == [] and first["failed"] is None
    assert first["evidence"] and all(link["linked_by"] == "verification" and link["path"][:2] == ["records", 0]
                                     and link["segment"].startswith(f"p{link['page']}_s") for link in first["evidence"])
    assert third["candidates"] and {"path", "value", "quote", "window"} <= set(third["candidates"][0])
    assert third["record"] is not None and third["failed"] == 0 and third["evidence"] is None and third["contested"] is None
    assert last["record"] is None and last["candidates"] is None and last["failed"] is None
    # The links are the ones the settled artifact publishes for that entry: the same code made them.
    settled = unified.extract(run_dir, source, unified_request(), as_router(CountingChat(model)), counter=WordCounter(),
                              extraction_id="x-2")
    assert first["evidence"] == [link for link in settled["evidence"] if link["path"][1] == 0]
    assert progress.read_progress(run_dir, "x-2")["finished"] == 5


def test_an_unresolved_arbitration_is_contested_in_the_progress_of_a_finished_entry(tmp_path):
    source = unified_evidence("1. Adorf. Material: Holz. Material: Stein.")
    unified_extract(source, Model(source, choice="NONE"), run_dir=tmp_path, extraction_id="x1")
    document = progress.read_progress(tmp_path, "x1")
    [entry] = document["entries"]
    assert entry["stage"] == "finished" and entry["record"]["material"] is None
    assert entry["contested"] == [{"path": ["material"], "candidates": ["Holz", "Stein"]}]


def test_a_finished_entry_beside_a_stale_candidates_or_reading_file_is_finished(tmp_path):
    source = unified_evidence("1. Adorf. Material: Holz.")
    unified_extract(source, run_dir=tmp_path, extraction_id="x1")
    directory = tmp_path / "extractions" / "x1"
    execution = json.loads((directory / progress.PROGRESS_NAME).read_bytes())["execution"]
    progress.write_stage(directory / progress.reading_name(0), {"version": 1, "execution": execution, "index": 0})
    progress.write_stage(directory / progress.candidates_name(0), {"version": 1, "execution": execution, "index": 0,
                         "discovery_sha256": "0" * 64, "ranges": [], "candidates": [], "record": {}, "failed": 0})
    document = progress.read_progress(tmp_path, "x1")
    assert document["entries"][0]["stage"] == "finished" and document["finished"] == 1
    assert document["entries"][0]["evidence"] == []  # no result under this run directory: links are left out, not invented


def test_malformed_or_stale_stage_files_are_skipped_never_served(tmp_path):
    source = unified_evidence("1. Adorf. Material: Holz.\n2. Bdorf. Material: Stein.")
    directory = tmp_path / "extractions" / "x1"
    model = Model(source)

    def before_entry_1(system, user, schema):
        if system.startswith("You extract structured data") and "Bdorf" in section(user, "RECORD"):
            raise requests.ConnectionError("connection reset")  # entry 0 finished, entry 1 only marked reading
        return model(system, user, schema)
    with pytest.raises(requests.ConnectionError):
        unified_extract(source, before_entry_1, run_dir=tmp_path, extraction_id="x1")
    assert [entry["stage"] for entry in progress.read_progress(tmp_path, "x1")["entries"]] == ["finished", "reading"]
    header = json.loads((directory / progress.PROGRESS_NAME).read_bytes())
    (directory / progress.candidates_name(1)).write_bytes(b"{}")                     # a stage file outside its layout
    assert progress.read_progress(tmp_path, "x1")["entries"][1]["stage"] == "reading"  # skipped: the marker still counts
    progress.write_stage(directory / progress.candidates_name(1), {"version": 1, "execution": header["execution"], "index": 1,
                         "discovery_sha256": "0" * 64, "ranges": [], "candidates": [{}], "record": {}, "failed": 0})  # a row outside its shape
    assert progress.read_progress(tmp_path, "x1")["entries"][1]["stage"] == "reading"  # the whole file is skipped
    (directory / progress.reading_name(1)).write_bytes(b"{not json")                   # half-written
    assert progress.read_progress(tmp_path, "x1")["entries"][1]["stage"] == "queued"
    progress.write_stage(directory / progress.reading_name(1), {"version": 1, "execution": "other", "index": 1})  # another execution's
    assert progress.read_progress(tmp_path, "x1")["entries"][1]["stage"] == "queued"
    (directory / progress.PROGRESS_NAME).write_bytes(b"[]")                            # a header that is no header
    assert progress.read_progress(tmp_path, "x1") is None
    progress.write_stage(directory / progress.PROGRESS_NAME, header)
    assert progress.read_progress(tmp_path, "x1")["finished"] == 1
    discovery = directory / "catalog-discovery.json"
    kept = discovery.read_bytes()
    discovery.write_bytes(b'{"entries": [null]}')                                       # kei's own record, outside its layout
    assert progress.read_progress(tmp_path, "x1") is None                             # no guess: no progress
    discovery.write_bytes(kept)
    assert progress.read_progress(tmp_path, "x1")["finished"] == 1


def test_the_article_progress_is_one_record_from_the_latest_assembled_root_whose_links_arrive_once_it_is_complete(tmp_path):
    directory = tmp_path / "extractions" / "x3"
    execution = progress.started(directory, "article", 2)
    assert progress.read_progress(tmp_path, "x3") is None  # no context answered yet
    link = {"path": ["records", 0, "year"], "segment": "p2_s0", "page": 2, "bbox_pt": [0.0, 0.0, 1.0, 1.0],
            "verbatim": True, "hits": 1, "linked_by": "model", "cell": None, "precision": "segment"}
    progress.write_stage(directory / progress.context_name(1), {
        "version": 1, "execution": execution, "context": 1, "of": 2, "answered": 1, "failed": 0, "passages": {"primary": ["p2_s0"], "overlap": []},
        "fields": {"entry_no": None, "site": "Brook", "year": 1828, "finds": None},
        "root": {"entry_no": None, "site": "Brook", "year": 1828, "finds": None}, "contested": [], "ok": True, "calls": []})
    # A grounding file beside an incomplete root (the final context's write was dropped, or this read fell between the two
    # writes): the links verify the final root, so none is attached to the root shown.
    progress.write_stage(directory / progress.grounding_name(0), {"version": 1, "execution": execution, "links": [link]})
    document = progress.read_progress(tmp_path, "x3")
    progress.ProgressDocument.model_validate(document)
    [entry] = document["entries"]
    assert (document["strategy"], document["started_at_page"], document["discovered"], document["finished"]) == ("article", 2, 1, 0)
    assert entry["stage"] == "candidates" and entry["record"] == {"entry_no": None, "site": "Brook", "year": 1828, "finds": None}
    assert {tuple(row["path"]) for row in entry["candidates"]} == {("site",), ("year",)} and entry["failed"] == 0
    assert entry["evidence"] == [] and document["document"] == {"contexts": [{"primary": ["p2_s0"], "overlap": []}], "answered": 1, "of": 2,
                                                                 "failed_contexts": 0, "links": [], "grounding_batches": 0}
    progress.write_stage(directory / progress.context_name(0), {
        "version": 1, "execution": execution, "context": 0, "of": 2, "answered": 2, "failed": 1, "passages": {"primary": ["p1_s0"], "overlap": []},
        "fields": {"entry_no": "31", "site": "Hill", "year": None, "finds": ["spear"]},
        "root": {"entry_no": "31", "site": None, "year": 1828, "finds": ["spear"]},
        "contested": [{"path": ["site"], "candidates": ["Hill", "Brook"]}], "ok": False, "calls": []})
    progress.write_stage(directory / progress.grounding_name(1), {"version": 1, "execution": "other", "links": [link, link]})  # a previous execution's
    progress.write_stage(directory / progress.grounding_name(2), {"version": 1, "execution": execution, "links": [{}]})        # a row outside its shape
    document = progress.read_progress(tmp_path, "x3")
    [entry] = document["entries"]
    assert entry["record"] == {"entry_no": "31", "site": None, "year": 1828, "finds": ["spear"]}  # the latest assembled root
    assert entry["contested"] == [{"path": ["site"], "candidates": ["Hill", "Brook"]}] and entry["failed"] == 1  # the latest file's cumulative count
    assert entry["evidence"] == [link] and document["document"]["answered"] == 2 and document["document"]["grounding_batches"] == 1  # complete: links attached; the two other files skipped
    assert document["document"]["failed_contexts"] == 1 and document["document"]["contexts"] == [
        {"primary": ["p1_s0"], "overlap": []}, {"primary": ["p2_s0"], "overlap": []}]
```

In `tests/test_api_reads.py` add:

```python
def test_the_progress_route_serves_the_stage_files_and_is_404_until_the_first_one(client, tmp_path):
    from kei_exp.kie.extract import progress
    run_id = kei_helper.converted_run(tmp_path, "kei-convert:ingest:p:r")
    assert client.get(f"/api/runs/{run_id}/extractions/x-1/progress").status_code == 404
    assert client.get(f"/api/runs/{run_id}/extractions/x-1/progress").json() == {"detail": "no progress yet"}
    assert client.get("/api/runs/run-unknown/extractions/x-1/progress").status_code == 404
    assert client.get(f"/api/runs/{run_id}/extractions/..%2Fx/progress").status_code == 404
    directory = tmp_path / run_id / "extractions" / "x-1"
    execution = progress.started(directory, "article", None)
    assert client.get(f"/api/runs/{run_id}/extractions/x-1/progress").status_code == 404  # the header alone is no progress
    progress.write_stage(directory / progress.context_name(0), {
        "version": 1, "execution": execution, "context": 0, "of": 1, "answered": 1, "failed": 0, "passages": {"primary": ["p1_s0"], "overlap": []},
        "fields": {"site_name": "Hill"}, "root": {"site_name": "Hill"}, "contested": [], "ok": True, "calls": []})
    response = client.get(f"/api/runs/{run_id}/extractions/x-1/progress")
    assert response.status_code == 200
    body = response.json()
    assert body["strategy"] == "article" and body["started_at_page"] is None
    assert body["entries"][0]["record"] == {"site_name": "Hill"} and body["entries"][0]["stage"] == "candidates"
    progress.ProgressDocument.model_validate(body)
```

- [ ] **Step 3: Run them to verify they fail** — `pytest tests/test_extract_progress.py tests/test_api_reads.py tests/test_contracts.py -k "progress"` → FAIL (`read_progress`, `ProgressDocument` missing; route 404 `Not Found`).

- [ ] **Step 4: `progress.py`, the stage models and the reader.** Add to the imports `import json`, `import re`, `from functools import lru_cache`, `from typing import Any, Literal, TypeVar`, `from pydantic import BaseModel, ConfigDict, ValidationError`, `from kei_exp.kie.extract.stages import leaves`, `from kei_exp.kie.passages import EvidenceUnavailable, Passage, load`, and append:

```python
_PAGE = re.compile(r"^p(\d+)_s\d+$")  # a passage id names its page


class _Stage(BaseModel):
    """A stage file's layout; one outside it is skipped by the reader, never served."""
    model_config = ConfigDict(extra="forbid")
    version: Literal[1]
    execution: str


class _Header(_Stage):
    strategy: Literal["catalog", "article"]
    start_page: int | None


class _Marker(_Stage):
    index: int


class _Candidates(_Stage):
    index: int
    discovery_sha256: str
    ranges: list[dict[str, Any]]
    candidates: list[_CandidateRow]
    record: dict[str, Any]
    failed: int


class _ContestRow(BaseModel):
    """`assemble_document`'s and `_settle`'s conflict: the path (record-relative) and the values that disagreed."""
    model_config = ConfigDict(extra="forbid")
    path: list[str | int]
    candidates: list[Any]


class _CandidateRow(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: list[str | int]
    value: Any
    quote: str | None
    window: int


class _LinkRow(BaseModel):
    """An artifact link as `assembly.artifact` or `unified._link` writes it: the fields every link has; a version's own
    fields ride along (`extra="allow"`), so the document carries the row as it was written."""
    model_config = ConfigDict(extra="allow")
    path: list[str | int]
    segment: str
    page: int
    bbox_pt: list[float] | None
    verbatim: bool
    hits: int
    linked_by: str


class _ContextFile(_Stage):
    context: int
    of: int
    answered: int
    failed: int
    passages: dict[str, Any]
    fields: dict[str, Any]
    root: dict[str, Any]
    contested: list[_ContestRow]
    ok: bool
    calls: list[dict[str, Any]]


class _GroundingFile(_Stage):
    links: list[_LinkRow]


_M = TypeVar("_M", bound=BaseModel)


class ProgressEntry(BaseModel):
    """One record of the partial view (design §3): where it is in its reading, and what exists of it so far."""
    model_config = ConfigDict(extra="forbid")
    index: int
    label: str | None
    page: int | None
    stage: Literal["queued", "reading", "candidates", "finished"]
    candidates: list[dict[str, Any]] | None  # {path, value, quote, window} rows, in the candidates stage
    record: dict[str, Any] | None            # the values so far (candidates placed, or the finished entry's record)
    evidence: list[dict[str, Any]] | None    # the artifact's own link dicts: a finished entry's, or Article's so far
    contested: list[dict[str, Any]] | None   # {path (record-relative), candidates}: scalars whose verified values disagree
    failed: int | None                       # values windows (Catalog) or contexts (Article) that failed: their nulls are unknown


class ProgressDocument(BaseModel):
    """What `GET /api/runs/{run}/extractions/{id}/progress` answers; `tests/fixtures/contracts/extract.progress.json`
    pins it for Studio's `partialFromProgress`."""
    model_config = ConfigDict(extra="forbid")
    version: Literal[1]
    strategy: Literal["catalog", "article"]
    started_at_page: int | None
    discovered: int
    finished: int
    entries: list[ProgressEntry]
    document: dict[str, Any] | None  # Article: {contexts, answered, of, failed_contexts, links, grounding_batches}; Catalog: None


def read_progress(run_dir: Path, extraction_id: str) -> dict | None:
    """The progress document for `extraction_id` under `run_dir`, or None before the first stage of record work
    (`catalog-discovery.json`, or the first context file of this execution) exists. Files only: a missing, unreadable,
    malformed or other execution's stage file is skipped, and a finished entry is read before any marker beside it, so a
    stage never regresses."""
    directory = run_dir / "extractions" / extraction_id
    header = _stage(directory / PROGRESS_NAME, _Header)
    if header is None:
        return None
    if header.strategy == "article":
        return _article(directory, header)
    return _catalog(directory, run_dir, header)


def _stage(path: Path, model: type[_M], execution: str | None = None) -> _M | None:
    """A stage file as `model`, or None when absent, unreadable, outside its layout (its rows included: a link, a
    contest or a candidate row outside its shape fails the whole file) or (when `execution` is given) written by
    another execution of the step. A file skipped leaves the progress of the files that read: never a failure."""
    try:
        record = model.model_validate_json(path.read_bytes())
    except (OSError, ValueError, ValidationError):  # absent, half-written, or not this layout
        return None
    return None if execution is not None and getattr(record, "execution") != execution else record


def _catalog(directory: Path, run_dir: Path, header: _Header) -> dict | None:
    from kei_exp.kie.extract import unified  # unified imports this module's names: imported here, not at load
    found = _json(directory / "catalog-discovery.json")
    if not isinstance(found, dict) or not isinstance(found.get("entries"), list) \
            or not all(isinstance(entry, dict) for entry in found["entries"]):
        return None  # kei's own write-once record, or nothing: a discovery outside its layout is no progress
    passages = _passages(run_dir)
    entries, finished = [], 0
    for number, entry in enumerate(found["entries"]):
        row = {"index": number, "label": entry.get("label"), "page": _page_of(entry), "stage": "queued",
               "candidates": None, "record": None, "evidence": None, "contested": None, "failed": None}
        published = _json(directory / unified.entry_name(number))
        if isinstance(published, dict):
            try:
                contests = [_ContestRow(path=contest["path"][2:], candidates=[each["value"] for each in contest["candidates"]])
                            for contest in published["work"]["contest"] if contest.get("outcome") == "unresolved"]
                row.update(stage="finished", record=published["work"]["record"],
                           evidence=unified.entry_links(published, passages) if passages is not None else [],
                           contested=[contest.model_dump() for contest in contests])
                finished += 1
                entries.append(row)
                continue
            except (KeyError, TypeError, ValidationError):  # a record outside its own layout: this view does not guess
                row = {**row, "stage": "queued", "record": None, "evidence": None, "contested": None}
        if (candidates := _stage(directory / candidates_name(number), _Candidates, header.execution)) is not None:
            row.update(stage="candidates", candidates=[each.model_dump() for each in candidates.candidates],
                       record=candidates.record, failed=candidates.failed)
        elif _stage(directory / reading_name(number), _Marker, header.execution) is not None:
            row["stage"] = "reading"
        entries.append(row)
    return {"version": PROGRESS_VERSION, "strategy": "catalog", "started_at_page": header.start_page,
            "discovered": len(entries), "finished": finished, "entries": entries, "document": None}


def _article(directory: Path, header: _Header) -> dict | None:
    contexts = sorted((row for path in directory.glob(f"article-context-*.v{ARTICLE_STAGE_VERSION}.json")
                       if (row := _stage(path, _ContextFile, header.execution)) is not None), key=lambda row: row.context)
    if not contexts:
        return None
    latest = max(contexts, key=lambda row: row.answered)  # the root assembled over every context answered so far
    # Grounding verifies the final root (`article.extract` grounds after `document_root`): its links belong to that root
    # alone, so they are attached only once the latest file shows every context answered. A dropped final context write,
    # or a read between that write and a grounding file's, shows the root it has, without links that are not its own.
    complete = latest.answered >= latest.of
    batches = [row for path in sorted(directory.glob(f"article-grounding-*.v{ARTICLE_STAGE_VERSION}.json"))
               if (row := _stage(path, _GroundingFile, header.execution)) is not None] if complete else []
    links = [link.model_dump() for batch in batches for link in batch.links]
    return {"version": PROGRESS_VERSION, "strategy": "article", "started_at_page": header.start_page,
            "discovered": 1, "finished": 0,
            "entries": [{"index": 0, "label": None, "page": None, "stage": "candidates",
                         "candidates": [{"path": list(path), "value": value, "quote": None, "window": 0}
                                        for path, value in leaves(latest.root)],
                         "record": latest.root, "evidence": links,
                         "contested": [contest.model_dump() for contest in latest.contested], "failed": latest.failed}],
            "document": {"contexts": [row.passages for row in contexts], "answered": latest.answered, "of": latest.of,
                         "failed_contexts": latest.failed, "links": links, "grounding_batches": len(batches)}}


def _page_of(entry: dict) -> int | None:
    ranges = entry.get("ranges") or []
    match = _PAGE.match(ranges[0]["segment"]) if ranges and isinstance(ranges[0], dict) else None
    return int(match[1]) if match else None


def _json(path: Path) -> Any:
    """A write-once record kei's own code wrote (`unified.py`), or None when absent or half-written."""
    try:
        return json.loads(path.read_bytes())
    except (OSError, ValueError):
        return None


def _passages(run_dir: Path) -> dict[str, Passage] | None:
    """The run's passages by id, for the links a finished entry makes; None when the result cannot be read."""
    try:
        return _loaded(str(run_dir), (run_dir / "result" / "result.json").stat().st_mtime_ns)
    except (OSError, EvidenceUnavailable):
        return None


@lru_cache(maxsize=8)
def _loaded(run_dir: str, _mtime_ns: int) -> dict[str, Passage]:
    """Loaded once per result (a re-conversion rewrites the manifest), so a two-second poll does not re-verify pages."""
    return {passage.id: passage for passage in load(Path(run_dir)).passages}
```

- [ ] **Step 5: `api.py`.** Import `from kei_exp.kie.extract.progress import read_progress` and add after `run_extraction` (113):

```python
@app.get("/api/runs/{run_id}/extractions/{extraction_id}/progress")
def run_extraction_progress(run_id: str, extraction_id: str) -> dict:
    """A running extraction's partial view (`kie.extract.progress`): the stage files kei has published so far, never
    a model call and never the workflow's status. 404 until the first stage of record work exists."""
    if not runs.COMPONENT.fullmatch(extraction_id):
        raise HTTPException(404, "no such extraction")
    document = read_progress(run_dir(run_id), extraction_id)
    if document is None:
        raise HTTPException(404, "no progress yet")
    return document
```

- [ ] **Step 6: README.** In `prototypes/parsing_service/README.md`, after the `extract` bullet's sentence ending `(its status is the workflow's).` (93) add: `While it runs, \`GET /api/runs/{id}/extractions/{extraction_id}/progress\` serves what the stage files beside the result say so far (\`kie/extract/progress.py\`): each discovered record's stage (queued, reading, candidates under verification, finished with its record, links and unresolved contests), and for Article the root assembled over the contexts answered so far and the links grounded so far; 404 until record work has started. Stage files are written by rename, marked with their execution's token (a retried step's files never mix with the previous attempt's) and skipped when unreadable; a write that fails never fails the extraction. A request may name \`start_page\`, the page the researcher is reading: the unified Catalog reads the records nearest it first and Article its bounded value contexts, the artifact unchanged.` In the unified paragraph (183-188), after `all write-once and reused when the step runs again,` insert ` beside a reading marker and a candidates file per entry that only the progress route reads,`.

- [ ] **Step 7: Run the tests to verify they pass** — `pytest tests/test_extract_progress.py tests/test_api_reads.py tests/test_contracts.py tests/test_unified_catalog.py tests/test_extract_workflow.py` → PASS; then the whole fast tier `/home/gennaro/projects/FREE/prototypes/parsing_service/.venv/bin/python -m pytest -q -m "not postgres and not live_model"` → PASS (`test_api_and_model_records_load_no_database_or_model_stack` included: the progress module loads no model stack).

- [ ] **Step 8: Commit** — `feat(kei): a progress route serving each running extraction's stage files, pinned by a shared fixture`.

---

### Task 5: `startPage` through admission, the row, the workflow request and the artifact check (§4)

**Files:**
- Modify: `packages/db/src/prisma/contract.prisma:222` (after `requestedSettings`), `packages/db/migrations/app/refs/db.json` (by `ref set`), `packages/db/src/schema-revision-record-scope-migration.test.ts:44-50`
- Create: `packages/db/migrations/app/<timestamp>_start_page/` (by `migration plan`), `packages/db/src/start-page-migration.test.ts`
- Modify: `packages/extraction/src/types.ts:286-296` (`FreshExtractionInput`), `packages/extraction/src/workflows.ts:22-44` (`AdmittedExtraction`), `:76-100` (`keiExtractRequest`), `packages/extraction/src/postgres-admission.ts:136-152` (`AdmissionPins`), `:177-192` (`resolveAdmission`'s return), `:268-278` (`Extraction.create`), `packages/extraction/src/postgres-workflow-store.ts:67-100` (`loadAdmitted`), `packages/extraction/src/kei-artifact.ts:221-229` (`honorsRequestedOptions`), `packages/extraction/src/testing/extraction-fixture.ts:704-709` (`extractionRow`)
- Test: `packages/extraction/src/workflows.test.ts` (after the "sample workbench" case, 535-541), `packages/extraction/src/kei-artifact.test.ts`, `packages/extraction/src/postgres-admission.integration.test.ts`

**Interfaces:**
- Produces: `Extraction.startPage Int?`; `FreshExtractionInput.startPage?: number | null`; `AdmittedExtraction.startPage?: number | null`; kei's request `options.start_page` when the row has a page; `honorsRequestedOptions` ignores `start_page`.

- [ ] **Step 1: Write the failing tests.** `packages/db/src/start-page-migration.test.ts`:

```ts
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { it } from 'node:test'

type Step = { sql: string; params: unknown[] }
type Operation = { id: string; operationClass: string; execute?: Step[] }

const migrations = resolve(import.meta.dirname, '../migrations/app')
const named = (suffix: string) => resolve(migrations, readdirSync(migrations).find((name) => name.endsWith(suffix))!)
const directory = named('_start_page')
const operations = JSON.parse(readFileSync(resolve(directory, 'ops.json'), 'utf8')) as Operation[]

it('adds one nullable integer column and nothing else: no row is given a start page it never named', () => {
  assert.deepEqual(operations.map((operation) => [operation.id, operation.operationClass]),
    [['column.public.extraction.startPage', 'additive']])
  assert.match(operations[0]!.execute?.[0]?.sql ?? '', /^ALTER TABLE "public"\."extraction" ADD COLUMN "startPage" (?:int4|integer)$/)
})

it('follows the record-scope migration directly and is the ref the database is checked against', () => {
  const migration = JSON.parse(readFileSync(resolve(directory, 'migration.json'), 'utf8')) as { from: string; to: string }
  const previous = JSON.parse(readFileSync(resolve(named('_schema_revision_record_scope'), 'migration.json'), 'utf8')) as { to: string }
  const ref = JSON.parse(readFileSync(resolve(migrations, 'refs/db.json'), 'utf8')) as { hash: string }
  assert.equal(migration.from, previous.to)
  assert.equal(ref.hash, migration.to)
})
```

In `packages/db/src/schema-revision-record-scope-migration.test.ts`, the case `follows the optional-review-evidence migration directly` keeps its `migration.from === previous.to` assertion and loses its two `ref` lines (the ref is the tip, asserted by the latest migration's own test from now on).

`packages/extraction/src/workflows.test.ts`, after the sample-workbench case:

```ts
  it('hands the admitted start page to kei as start_page; the artifact, which never records it, is accepted', async () => {
    const run = harness({ admitted: admittedExtraction({ startPage: 6 }) })
    await run.run()
    assert.deepEqual((run.submissions[0]!.request as KeiExtractInput).request.options, { strategy: 'article', start_page: 6 })
    assert.equal(run.row.outcome?.outcome, 'SUCCEEDED')
    assert.deepEqual(run.names(), ['loadAdmitted', 'submitToKei', 'pollKei', 'publishResult'])
  })

  it('a checkpoint written before start pages were stored, or a row that named none, asks kei for its source order', async () => {
    const { startPage: _absent, ...older } = admittedExtraction()
    for (const admitted of [older as AdmittedExtraction, admittedExtraction({ startPage: null })]) {
      const run = harness({ admitted })
      await run.run()
      assert.deepEqual((run.submissions[0]!.request as KeiExtractInput).request.options, { strategy: 'article' })
      assert.equal(run.row.outcome?.outcome, 'SUCCEEDED')
    }
  })
```

`packages/extraction/src/kei-artifact.test.ts`, in the first `describe` beside the option-honoring cases:

```ts
  it('a start page on the request is an order of work, not an option the artifact must record', () => {
    assert.equal(accept(artifact(), { settings: { start_page: 6 } }).extraction.outcome, 'SUCCEEDED')
  })
```

`packages/extraction/src/postgres-admission.integration.test.ts`, after the recipe case:

```ts
it('stores the start page on the row and hands it to kei; it is never part of the admission identity', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const module = scheduler(project.researcherAccountId)
    kei.holding = true
    const extractionId = randomUUID()
    const input = { ...freshInput(project, extractionId), startPage: 6 }
    assert.equal((await module.runSingle(input)).disposition, 'created')
    assert.equal((await extractionRow(extractionId))?.startPage, 6)
    // The same whole-document Extraction whatever page the researcher was reading: a replay, and the row keeps page 6.
    assert.equal((await module.runSingle({ ...input, startPage: 2 })).disposition, 'replayed')
    assert.equal((await module.runSingle({ ...input, startPage: null })).disposition, 'replayed')
    assert.equal((await extractionRow(extractionId))?.startPage, 6)
    await heldByKei(extractionId)
    const request = kei.submissions.find((submission) => submission.workflowId === keiExtractWorkflowId(extractionId))!
      .request as KeiExtractInput
    assert.deepEqual(request.request.options, { strategy: 'article', start_page: 6 })
    const unnamed = freshInput(project)
    await module.runSingle(unnamed)
    assert.equal((await extractionRow(unnamed.extractionId))?.startPage, null)
  })
```

and `extractionRow` in `testing/extraction-fixture.ts:704-709` selects `'startPage'` too.

- [ ] **Step 2: Run them to verify they fail** — `cd packages/db && pnpm test` → FAIL (no `_start_page` directory); `cd packages/extraction && pnpm test` → FAIL (typecheck: `startPage` unknown; `start_page` not sent).

- [ ] **Step 3: The column and its migration.** In `contract.prisma` after the `requestedSettings` field (222):

```prisma
  // The page the researcher was reading when the run started (one-based): the order kei reads records in, never which
  // records. Not part of the admission identity; null for Batch Extractions and for rows admitted before it existed.
  startPage                      Int?
```

Then, from `packages/db` (the ref snapshot `refs/db.contract.json` is gitignored and absent in a fresh worktree; the previous migration's end contract is that snapshot):

```bash
cd packages/db
export CONTRACT_URL=postgresql://contract:emit@127.0.0.1:5432/free   # never dialled
[ -f migrations/app/refs/db.contract.json ] || cp migrations/app/20261001T1432_schema_revision_record_scope/end-contract.json migrations/app/refs/db.contract.json
[ -f migrations/app/refs/db.contract.d.ts ] || cp migrations/app/20261001T1432_schema_revision_record_scope/end-contract.d.ts migrations/app/refs/db.contract.d.ts
DATABASE_URL=$CONTRACT_URL pnpm contract:emit
DATABASE_URL=$CONTRACT_URL pnpm exec prisma-next migration plan --name start_page --no-interactive
ls migrations/app                                                                 # a new *_start_page directory
DATABASE_URL=$CONTRACT_URL node migrations/app/*_start_page/migration.ts --dry-run   # one ADD COLUMN, no data op
DATABASE_URL=$CONTRACT_URL node migrations/app/*_start_page/migration.ts             # writes ops.json + migration.json
cat migrations/app/*_start_page/migration.json                                       # "from" = the record-scope "to" (sha256:d88cb685…)
DATABASE_URL=$CONTRACT_URL pnpm exec prisma-next ref set db <the "to" hash> --no-interactive
DATABASE_URL=$CONTRACT_URL pnpm exec prisma-next migration check --no-interactive    # "All checks passed"
```

Do not edit `ops.json` by hand; the generated `migration.ts` needs no edit (one `addColumn`). Commit the new directory and `refs/db.json`; `refs/*.contract.*` and `src/prisma/contract.*` stay gitignored.

- [ ] **Step 4: `types.ts`.** In `FreshExtractionInput` after `method: ExtractionMethodIntent`:

```ts
  /** The page the researcher was reading when Run was clicked (one-based): the order kei reads records in, never which
   *  records. Absent or null when none was named (a Batch Extraction, an API client). Not part of the admission identity. */
  startPage?: number | null
```

- [ ] **Step 5: `workflows.ts`.** `AdmittedExtraction` after `recordScope?: RecordScope | null`:

```ts
  /** The start page admission stored (`Extraction.startPage`); null when none was named, absent in a `loadAdmitted`
   *  checkpoint written before the column existed. Both ask kei for its source order. */
  startPage?: number | null
```

`keiExtractRequest`'s return becomes:

```ts
  return {
    run_id: run.runId,
    generation: run.generation,
    request: {
      schema,
      // The start page orders kei's work and is outside the artifact and its fingerprint (`Options.dumped()`).
      options: {
        ...keiMethodOptions(method),
        ...(typeof admitted.startPage === 'number' ? { start_page: admitted.startPage } : {}),
      },
    },
  }
```

- [ ] **Step 6: `postgres-admission.ts`.** `AdmissionPins` gains `startPage: number | null` after `preprocessId: string`; `resolveAdmission`'s return gains `startPage: input.startPage ?? null,`; `Extraction.create` in `admitInteractiveExtraction` gains `startPage: pins.startPage,` after `batchExtractionId: null,`. Above `sameAdmission` (206) extend its doc comment: `The start page is not identity: the same whole-document Extraction, whatever page the researcher was reading (design §4).` (`admitBatchMember` creates rows without it: a batch names no start page.)

- [ ] **Step 7: `postgres-workflow-store.ts`.** `loadAdmitted`'s select adds `'startPage'` after `'batchExtractionId'`, and the returned object gains `startPage: row.startPage,` after `batchExtractionId: row.batchExtractionId,`.

- [ ] **Step 8: `kei-artifact.ts`.** `honorsRequestedOptions` (221-229): the destructuring becomes

```ts
  // The start page orders kei's work and is never recorded (`Options.dumped()` drops it, as it dropped `pages`).
  const { strategy: _strategy, models: _models, article: _article, start_page: _startPage, catalog, ...limits } = requested
```

- [ ] **Step 9: Run the tests to verify they pass** — `cd packages/db && pnpm typecheck && pnpm test`; `cd packages/extraction && pnpm typecheck && pnpm test` → PASS. Where `EXTRACTION_TEST_DATABASE_URL` names a migrated disposable database: `pnpm --filter extraction test:postgres` → PASS; otherwise record in the ledger that the admission integration case runs at the Baratheon verification.

- [ ] **Step 10: Commit** — `feat(extraction): the start page on the Extraction row, in kei's request, and outside the artifact check`.

---

### Task 6: The kei progress client, `partialFromProgress` and the stand-in's progress route (§5)

**Files:**
- Create: `packages/extraction/src/partial-result.ts`, `packages/extraction/src/partial-result.test.ts`
- Modify: `packages/extraction/src/kei-exp.ts:41-52` (interface), `:85-104` (after `readExtractionArtifact`), `packages/extraction/src/kei-artifact.ts:25-40` (export `evidenceSchema`), `:158-167` (export `unifiedEvidenceSchema`), `:267-283` (`anchorId`), `:295-337` (the evidence mapping), `packages/extraction/src/index.ts`, `packages/extraction/package.json` (`test`), `packages/extraction/src/testing/kei-stand-in.ts:28-33` (script), `:187-190` (route)
- Test: `packages/extraction/src/module.test.ts` (the `kei-exp read client` describe), `packages/extraction/src/kei-contract.integration.test.ts:57-60`

**Interfaces:**
- Produces: `KeiExpClient.readExtractionProgress(runId, extractionId, signal?): Promise<unknown | null>` and `PROGRESS_TIMEOUT_MS = 2_000`; `partialFromProgress(raw: unknown): PartialResult | null` (the package's type: readonly, `value: unknown`; the API converts it to the wire type by parsing, Task 7); types `PartialResult`, `PartialRecord`, `PartialRecordState = 'queued' | 'reading' | 'checking' | 'finished'`, `PartialValueState = 'grounded' | 'checking' | 'reading' | 'empty' | 'contested'`, `ProgressDocument`; `progressDocumentSchema`; `orderedByDistance`; from `kei-artifact.ts`: `evidenceSchema`, `unifiedEvidenceSchema`, `evidenceAnchorIdOf(link)`, `unifiedEvidenceLink(link, anchorId)`, `plainEvidenceLink(link, anchorId)`; `KeiStandInScript.progress?(runId, extractionId): unknown`.
- `PartialRecord.values` is keyed by the leaf's record-relative path with every step a string, JSON-encoded (`JSON.stringify(['finds', '0', 'name'])`), as `ResultValue` spells its paths; a `contested` value carries its `candidates`; `evidenceLinks[].resultPath` is absolute (`['records', index, …]`), as the artifact's.

- [ ] **Step 1: Write the failing tests.** `packages/extraction/src/partial-result.test.ts`:

```ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import progressFixture from '../../../prototypes/parsing_service/tests/fixtures/contracts/extract.progress.json' with { type: 'json' }
import { partialFromProgress, progressDocumentSchema, type ProgressDocument } from './partial-result.js'
import type { VerifiedGrounding } from './types.js'

/** The shared fixture as a typed, mutable document: its nullable fields may be set to null in a case. */
const fixture = (): ProgressDocument => progressDocumentSchema.parse(structuredClone(progressFixture))
const key = (...path: string[]) => JSON.stringify(path)

describe('partialFromProgress', () => {
  it('maps the shared fixture: one record per entry, in the order they were read, each value in its state', () => {
    const partial = partialFromProgress(fixture())!
    assert.equal(partial.strategy, 'CATALOG')
    assert.deepEqual([partial.startedAtPage, partial.discovered, partial.finished], [1, 5, 2])
    assert.deepEqual(partial.records.map((record) => [record.index, record.state]),
      [[0, 'finished'], [1, 'finished'], [2, 'checking'], [3, 'reading'], [4, 'queued']])
    const [first, second, third, reading, queued] = partial.records
    assert.deepEqual(first!.values[key('material')], { value: 'Holz', state: 'grounded' })
    assert.deepEqual(first!.values[key('gilded')], { value: null, state: 'empty' })
    assert.deepEqual(first!.values[key('finds', '0', 'count')], { value: 2, state: 'grounded' })
    assert.deepEqual(first!.evidenceLinks[0], {
      resultPath: ['records', 0, 'label'], evidenceAnchorId: 'a_p1_s0', precision: 'segment', verbatim: true, lexicalHits: 1,
      grounding: { linkedBy: 'verification', support: 'literal', textSpans: [{ segment: 'p1_s0', start: 0, end: 1 }],
        alternatives: [], precision: 'segment', raw: '1', itemSpans: null },
    })
    assert.equal((first!.evidenceLinks[3]!.grounding as VerifiedGrounding).itemSpans?.length, 1)  // the list item's occurrence
    // An arbitration left unresolved: the field is contested, with the values that disagreed (design §1).
    assert.deepEqual(second!.values[key('site')], { value: null, state: 'contested', candidates: ['Bdorf', 'Bdorf-Nord'] })
    // A candidates-stage entry: candidates are checking, what the values call left null is empty (Ruling 7).
    assert.deepEqual(third!.values[key('material')], { value: 'Gold', state: 'checking' })
    assert.deepEqual(third!.values[key('site')], { value: null, state: 'empty' })
    assert.deepEqual(third!.evidenceLinks, [])
    assert.deepEqual([reading!.record, reading!.values, queued!.record, queued!.label], [null, {}, null, null])
    assert.equal(partial.document, null)
  })

  it('a candidates-stage entry whose values window failed keeps its nulls unknown: reading, not empty', () => {
    const document = fixture()
    document.entries[2]!.failed = 1
    assert.deepEqual(partialFromProgress(document)!.records[2]!.values[key('site')], { value: null, state: 'reading' })
    assert.deepEqual(partialFromProgress(document)!.records[2]!.values[key('material')], { value: 'Gold', state: 'checking' })
  })

  it('orders records by distance from the start page, ties and unknown pages last in source order', () => {
    const document = fixture()
    document.started_at_page = 3
    document.entries[4]!.page = null
    assert.deepEqual(partialFromProgress(document)!.records.map((record) => record.index), [3, 2, 0, 1, 4])
    document.started_at_page = null
    assert.deepEqual(partialFromProgress(document)!.records.map((record) => record.index), [0, 1, 2, 3, 4])
  })

  it('a finished value kei kept without a link is checking, never grounded', () => {
    const document = fixture()
    document.entries[1]!.evidence = []
    const [, second] = partialFromProgress(document)!.records
    assert.deepEqual(second!.values[key('material')], { value: 'Stein', state: 'checking' })
  })

  it('maps an Article document: one record, candidates checking, linked grounded, unanswered reading while contexts remain or failed', () => {
    const link = { path: ['records', 0, 'site'], segment: 'p1_s0', page: 1, bbox_pt: [0, 0, 1, 1], verbatim: true, hits: 1,
      linked_by: 'model', cell: null, precision: 'segment' }
    // Through the schema, so the document is typed (and its nullable fields assignable) rather than inferred from the literal.
    const article: ProgressDocument = progressDocumentSchema.parse({
      version: 1, strategy: 'article', started_at_page: 2, discovered: 1, finished: 0,
      entries: [{ index: 0, label: null, page: null, stage: 'candidates', evidence: [link],
        candidates: [{ path: ['site'], value: 'Hill', quote: null, window: 0 }, { path: ['year'], value: 1828, quote: null, window: 0 }],
        record: { entry_no: null, site: 'Hill', year: 1828, finds: null }, contested: [], failed: 0 }],
      document: { contexts: [{ primary: ['p1_s0'], overlap: [] }], answered: 1, of: 2, failed_contexts: 0, links: [link], grounding_batches: 1 },
    })
    const partial = partialFromProgress(article)!
    assert.equal(partial.strategy, 'ARTICLE')
    assert.deepEqual(partial.document, { contextsAnswered: 1, contexts: 2, groundingBatches: 1 })
    const [record] = partial.records
    assert.equal(record!.state, 'checking')
    assert.deepEqual(record!.values[key('site')], { value: 'Hill', state: 'grounded' })
    assert.deepEqual(record!.values[key('year')], { value: 1828, state: 'checking' })
    assert.deepEqual(record!.values[key('entry_no')], { value: null, state: 'reading' })
    assert.deepEqual(record!.evidenceLinks, [{ resultPath: ['records', 0, 'site'], evidenceAnchorId: 'a_p1_s0', precision: 'segment', verbatim: true, lexicalHits: 1 }])
    article.document!.answered = 2
    assert.deepEqual(partialFromProgress(article)!.records[0]!.values[key('entry_no')], { value: null, state: 'empty' })
    article.entries[0]!.failed = 1
    assert.deepEqual(partialFromProgress(article)!.records[0]!.values[key('entry_no')], { value: null, state: 'reading' })
    article.entries[0]!.failed = 0
    article.entries[0]!.contested = [{ path: ['entry_no'], candidates: ['31', '32'] }]
    assert.deepEqual(partialFromProgress(article)!.records[0]!.values[key('entry_no')], { value: null, state: 'contested', candidates: ['31', '32'] })
  })

  it('a document outside the contract is null, never a throw', () => {
    for (const raw of [null, 'progress', {}, { ...fixture(), version: 2 }, { ...fixture(), entries: [{ index: 0 }] }])
      assert.equal(partialFromProgress(raw), null)
  })
})
```

In `module.test.ts`, inside `describe('kei-exp read client')`, after the artifact cases:

```ts
  function progressClient(response: Response | Error) {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const client = createKeiExpClient({
      url: 'http://kei-exp:8001/',
      fetch: async (url, init) => {
        requests.push({ url: String(url), init })
        if (response instanceof Error) throw response
        return response
      },
    })
    return { requests, read: (signal?: AbortSignal) => client.readExtractionProgress('run-1', 'x-1', signal) }
  }

  it('reads the progress document from its route, and null while kei has none', async () => {
    const { requests, read } = progressClient(json({ version: 1, strategy: 'catalog' }))
    assert.deepEqual(await read(), { version: 1, strategy: 'catalog' })
    assert.equal(requests[0]!.url, 'http://kei-exp:8001/api/runs/run-1/extractions/x-1/progress')
    assert.equal(requests[0]!.init?.method, 'GET')
    assert.equal(await progressClient(json({ detail: 'no progress yet' }, 404)).read(), null)
  })

  it('a slow, unreachable or failing kei throws a transient error: the caller shows no partial view', async () => {
    for (const response of [new DOMException('timed out', 'TimeoutError'), new TypeError('fetch failed'), json({ detail: 'restarting' }, 503)])
      await assert.rejects(progressClient(response).read(), (error: unknown) => (error as { transient?: unknown }).transient === true)
  })

  it('every progress read carries a bounded signal: two seconds, the poll interval', async () => {
    const { requests, read } = progressClient(json({}))
    await read()
    assert.equal(PROGRESS_TIMEOUT_MS, 2_000)
    assert.ok(requests[0]!.init?.signal instanceof AbortSignal)
  })

  it('a run or extraction outside kei\'s path component is null before any request', async () => {
    const requests: string[] = []
    const client = createKeiExpClient({ url: 'http://kei-exp:8001', fetch: async (url) => { requests.push(String(url)); return json({}) } })
    assert.equal(await client.readExtractionProgress('../x', 'x-1'), null)
    assert.equal(await client.readExtractionProgress('run-1', 'x-1\n'), null)
    assert.deepEqual(requests, [])
  })
```

(import `PROGRESS_TIMEOUT_MS` beside `createKeiExpClient`). In `kei-contract.integration.test.ts`, after the artifact read (60), add:

```ts
    // The stand-in serves kei's progress route too; a spawned stand-in has no progress script, so it is 404 (`no progress yet`).
    const progress = await fetch(`${standIn.url}/api/runs/${document.runId}/extractions/${input.extractionId}/progress`)
    assert.equal(progress.status, 404)
    assert.deepEqual(await progress.json(), { detail: 'no progress yet' })
```

- [ ] **Step 2: Run them to verify they fail** — add `src/partial-result.test.ts` to `package.json`'s `test` list (after `src/kei-artifact.test.ts`), then `cd packages/extraction && pnpm test` → FAIL (module missing; `readExtractionProgress` not a function).

- [ ] **Step 3: `kei-artifact.ts`.** Export `evidenceSchema` (25) and `unifiedEvidenceSchema` (158) (`export const …`). Add `import type { EvidenceLink, ExtractionStrategy } from './types.js'` (extending the existing type import) and, after `unifiedEvidenceSchema`:

```ts
/** The Evidence anchor a kei link names: the segment's text anchor, or the cell's when the link is a table cell. */
export const evidenceAnchorIdOf = (link: { segment: string; cell?: string | null }): string =>
  `a_${link.segment}${link.cell ? `_${link.cell}` : ''}`

/** A version 3 link as the Extraction keeps it: a verified value with its spans (`VerifiedGrounding`). */
export function unifiedEvidenceLink(link: z.infer<typeof unifiedEvidenceSchema>, evidenceAnchorId: string): EvidenceLink {
  return {
    resultPath: link.path, evidenceAnchorId, precision: link.precision, verbatim: link.verbatim, lexicalHits: link.hits,
    grounding: {
      linkedBy: link.linked_by, support: link.support, textSpans: link.spans, alternatives: link.alternatives,
      precision: link.precision, raw: link.raw, itemSpans: link.item,
    },
  }
}

/** A version 1 link as the Extraction keeps it. */
export function plainEvidenceLink(link: z.infer<typeof evidenceSchema>, evidenceAnchorId: string): EvidenceLink {
  return {
    resultPath: link.path, evidenceAnchorId,
    ...(link.precision ? { precision: link.precision } : {}),
    verbatim: link.verbatim, lexicalHits: link.hits,
    ...(link.linked_by === 'lexical' ? { linkedBy: 'lexical' as const } : {}),
  }
}
```

In `acceptKeiArtifact`, `anchorId` (267-283) computes `const id = evidenceAnchorIdOf(link)` instead of the template, and the evidence mapping (295-337) becomes:

```ts
    evidence: unified
      ? unified.evidence.map((link) => unifiedEvidenceLink(link, anchorId(link)))
      : grounded
      ? grounded.evidence.map((link) => ({ …unchanged version 2 mapping… }))
      : artifact.evidence.map((link) => plainEvidenceLink(link, anchorId(link))),
```

(the version 2 branch is untouched). `kei-artifact.test.ts` stays green: the shapes are the same.

- [ ] **Step 4: `kei-exp.ts`.** After `readExtractionArtifact` in the interface (46):

```ts
  /** `GET /api/runs/{run}/extractions/{id}/progress` (kei-exp `api.py` `run_extraction_progress`): the progress document
   *  of a running Extraction, or null while kei has published no stage of it (404) or the ids are outside kei's path
   *  component. The read waits at most PROGRESS_TIMEOUT_MS; a slow or unreachable kei and a server failure throw a
   *  transient error, and the caller shows no partial view (design §5). The document is validated by the caller. */
  readExtractionProgress(runId: string, extractionId: string, signal?: AbortSignal): Promise<unknown | null>
```

Above `createKeiExpClient`: `/** The two seconds a status read may wait for kei's progress: the client polls every two seconds. */ export const PROGRESS_TIMEOUT_MS = 2_000`. In the returned object, after `readExtractionArtifact`:

```ts
    async readExtractionProgress(runId, extractionId, signal) {
      if (!KEI_RUN_ID.test(runId) || !KEI_RUN_ID.test(extractionId)) return null
      let response: Response
      try {
        response = await fetchRequest(`${root}/api/runs/${runId}/extractions/${extractionId}/progress`, {
          method: 'GET', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(PROGRESS_TIMEOUT_MS)]),
        })
      } catch (error) {
        signal?.throwIfAborted()
        throw Object.assign(new Error('kei-exp could not be reached to read the extraction progress.', { cause: error }), { transient: true })
      }
      if (response.status === 404) {
        await response.body?.cancel()
        return null
      }
      if (!response.ok) throw Object.assign(new Error(await httpFailure(response)), { transient: true })
      return (await response.json()) as unknown
    },
```

- [ ] **Step 5: `partial-result.ts`.**

```ts
import { z } from 'zod'
import { evidenceAnchorIdOf, evidenceSchema, plainEvidenceLink, unifiedEvidenceLink, unifiedEvidenceSchema } from './kei-artifact.js'
import type { EvidenceLink, ExtractionStrategy } from './types.js'

/** kei's progress document (`kie/extract/progress.py` `ProgressDocument`), pinned by
 *  `prototypes/parsing_service/tests/fixtures/contracts/extract.progress.json`. */
const count = z.number().int().nonnegative()
const relativePath = z.array(z.union([z.string(), z.number().int().nonnegative()]))
const progressLinkSchema = z.union([unifiedEvidenceSchema, evidenceSchema])
const contestSchema = z.object({ path: relativePath, candidates: z.array(z.unknown()) })
const progressEntrySchema = z.object({
  index: count,
  label: z.string().nullable(),
  page: z.number().int().positive().nullable(),
  stage: z.enum(['queued', 'reading', 'candidates', 'finished']),
  candidates: z.array(z.object({ path: relativePath, value: z.unknown(), quote: z.string().nullable(), window: count.optional() })).nullable(),
  record: z.record(z.string(), z.unknown()).nullable(),
  evidence: z.array(progressLinkSchema).nullable(),
  contested: z.array(contestSchema).nullable(),
  failed: count.nullable(),
})
export const progressDocumentSchema = z.object({
  version: z.literal(1),
  strategy: z.enum(['catalog', 'article']),
  started_at_page: z.number().int().positive().nullable(),
  discovered: count,
  finished: count,
  entries: z.array(progressEntrySchema),
  document: z.object({
    contexts: z.array(z.unknown()), answered: count, of: count, failed_contexts: count,
    links: z.array(progressLinkSchema), grounding_batches: count,
  }).nullable(),
})
export type ProgressDocument = z.infer<typeof progressDocumentSchema>

/** A value of a record still being read (design §1): grounded once its link exists, checking while it is a candidate,
 *  reading while the call that would answer it is in flight or failed, empty when the call that could have answered it
 *  succeeded without it, contested when verified values disagreed and arbitration chose none. */
export type PartialValueState = 'grounded' | 'checking' | 'reading' | 'empty' | 'contested'
/** queued: discovered, not yet read; reading: its values call is in flight; checking: its candidates are being verified
 *  (kei's `candidates` stage); finished: kei published the entry. */
export type PartialRecordState = 'queued' | 'reading' | 'checking' | 'finished'
export type PartialValue = Readonly<{ value: unknown; state: PartialValueState; candidates?: readonly unknown[] }>
export type PartialRecord = Readonly<{
  index: number
  label: string | null
  page: number | null
  state: PartialRecordState
  /** The values so far in the artifact's shape; null before the values call returned. */
  record: Readonly<Record<string, unknown>> | null
  /** Each leaf of `record` by its record-relative path (every step a string, JSON-encoded, as `ResultValue` paths are). */
  values: Readonly<Record<string, PartialValue>>
  evidenceLinks: readonly EvidenceLink[]
}>
/** A running Extraction's partial view (design §5): a view of files kei already wrote, never the record of truth. */
export type PartialResult = Readonly<{
  strategy: ExtractionStrategy
  startedAtPage: number | null
  discovered: number
  finished: number
  /** In the order they were read: nearest the start page first, then source order (kei's `work_order`). */
  records: readonly PartialRecord[]
  document: Readonly<{ contextsAnswered: number; contexts: number; groundingBatches: number }> | null
}>

/** Every leaf of a record with its record-relative path, nulls included: a null leaf is a field with nothing in it. */
function leavesOf(value: unknown, path: string[] = []): Array<{ path: string[]; value: unknown }> {
  if (Array.isArray(value)) return value.flatMap((item, index) => leavesOf(item, [...path, String(index)]))
  if (value !== null && typeof value === 'object')
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => leavesOf(item, [...path, key]))
  return [{ path, value }]
}
const populated = (value: unknown): boolean => value !== null && value !== undefined && value !== ''

function progressEvidenceLink(link: z.infer<typeof progressLinkSchema>): EvidenceLink {
  const anchorId = evidenceAnchorIdOf(link)
  return 'support' in link ? unifiedEvidenceLink(link, anchorId) : plainEvidenceLink(link, anchorId)
}

/** kei's `work_order` and Article's `context_order`: distance from the start page, an unknown page last, ties in source order. */
export function orderedByDistance<T extends { index: number; page: number | null }>(records: readonly T[], startPage: number | null): T[] {
  const distance = (record: T) => startPage === null ? 0 : record.page === null ? Number.POSITIVE_INFINITY : Math.abs(record.page - startPage)
  return [...records].sort((left, right) => distance(left) - distance(right) || left.index - right.index)
}

/**
 * kei's progress document as the partial view Studio shows, converted with the artifact reader's own link code; null
 * for a document outside the contract (a kei newer or older than this Studio), never a throw: the view is best effort.
 *
 * Per value: a leaf with a link is `grounded`; a populated leaf without one is `checking` (a candidate under
 * verification, or a finished value kei kept without a link); a null leaf is `contested` when the entry reports its
 * path as an unresolved contest, `reading` while a call that could still answer it is in flight or failed (an Article
 * context unanswered or failed, a Catalog values window failed), and `empty` otherwise (Ruling 7).
 */
export function partialFromProgress(raw: unknown): PartialResult | null {
  const parsed = progressDocumentSchema.safeParse(raw)
  if (!parsed.success) return null
  const progress = parsed.data
  const unanswered = progress.strategy === 'article' && progress.document !== null && progress.document.answered < progress.document.of
  const records = progress.entries.map((entry): PartialRecord => {
    const evidenceLinks = (entry.evidence ?? []).map(progressEvidenceLink)
    const linked = new Set(evidenceLinks.map((link) => JSON.stringify(link.resultPath.slice(2).map(String))))
    const contested = new Map((entry.contested ?? []).map((contest) => [JSON.stringify(contest.path.map(String)), contest.candidates]))
    const unknown = unanswered || (entry.failed ?? 0) > 0
    const values: Record<string, PartialValue> = {}
    if (entry.record !== null)
      for (const leaf of leavesOf(entry.record)) {
        const key = JSON.stringify(leaf.path)
        const candidates = contested.get(key)
        values[key] = linked.has(key) ? { value: leaf.value, state: 'grounded' }
          : populated(leaf.value) ? { value: leaf.value, state: 'checking' }
          : candidates ? { value: leaf.value, state: 'contested', candidates }
          : { value: leaf.value, state: unknown ? 'reading' : 'empty' }
      }
    return {
      index: entry.index, label: entry.label, page: entry.page,
      state: entry.stage === 'candidates' ? 'checking' : entry.stage,
      record: entry.record, values, evidenceLinks,
    }
  })
  return {
    strategy: progress.strategy === 'article' ? 'ARTICLE' : 'CATALOG',
    startedAtPage: progress.started_at_page,
    discovered: progress.discovered,
    finished: progress.finished,
    records: orderedByDistance(records, progress.started_at_page),
    document: progress.document === null
      ? null
      : { contextsAnswered: progress.document.answered, contexts: progress.document.of, groundingBatches: progress.document.grounding_batches },
  }
}
```

`index.ts`: add `export { createKeiExpClient, PROGRESS_TIMEOUT_MS } from './kei-exp.js'` (extending the existing line), `export { orderedByDistance, partialFromProgress, progressDocumentSchema } from './partial-result.js'` and `export type { PartialRecord, PartialRecordState, PartialResult, PartialValue, PartialValueState, ProgressDocument } from './partial-result.js'`.

- [ ] **Step 6: The stand-in.** `KeiStandInScript` gains:

```ts
  /** kei's progress route for a running extraction: the document to serve, or null/undefined for 404 (`no progress yet`). */
  progress?(runId: string, extractionId: string): unknown
```

and in `route`, before the artifact branch (`if (kind === 'extractions' && item !== undefined && rest.length === 0 …`):

```ts
    if (kind === 'extractions' && item !== undefined && rest.length === 1 && rest[0] === 'progress' && KEI_RUN_ID.test(item)) {
      const progress = options.script.progress?.(run, item)
      return progress == null ? send(response, 404, { detail: 'no progress yet' }) : send(response, 200, progress)
    }
```

The module comment's route list gains `, a running extraction's progress`.

- [ ] **Step 7: Run the tests to verify they pass** — `cd packages/extraction && pnpm typecheck && pnpm test` → PASS (`architecture.test.ts` included: `partial-result.ts` imports only `./kei-artifact.js`, `./types.js` and `zod`); `pnpm --filter extraction test:postgres` where a database is available.

- [ ] **Step 8: Commit** — `feat(extraction): read kei's progress and convert it to a partial result with the artifact's own link code`.

---

### Task 7: Studio's API accepts `startPage` and returns `partial` while an attempt runs (§4, §5)

**Files:**
- Modify: `packages/extraction/src/postgres-attempts.ts:125-150` (`pinsOf`), `packages/extraction/src/types.ts:225-253, 255-284` (the snapshots), `prototypes/studio/shared/extraction.contract.ts:62-80` (`extractionRequestSchema`), `:496-511` (`extractionReadResponseSchema`, and the new partial schemas above it), `prototypes/studio/api/extractions.ts:1-26` (imports), `:82-105` (`create`), `:107-121` (`read`)
- Test: `prototypes/studio/api/extractions.test.ts` (the imports at 1, the mock at 12-22, `snapshot` at 30, the exact `runSingle` expectation at 207-216, `catalogSnapshot` at 359, the running read at 459, `fresh` at 150), `prototypes/studio/api/_extractions.test.ts:134`, `prototypes/studio/api/document_reopen.test.ts:20`, `packages/extraction/src/kei-artifact.test.ts:434`, `packages/extraction/src/module.test.ts:143`

**Interfaces:**
- Produces: `ExtractionSnapshot.preprocessId: string` and `ExtractionAttemptSnapshot.preprocessId: string` (never on the wire); `extractionRequestSchema.startPage?: number` (positive integer); `partialValueStateSchema`, `partialValueSchema`, `partialRecordSchema`, `partialResultSchema`, type `PartialResult` in `shared/extraction.contract.ts` (the wire type: what Part B imports); `extractionReadResponseSchema.partial?: PartialResult | null`; `POST /api/extractions` passes `startPage` (null when absent) to `runSingle`; `GET /api/extractions/:id` answers `partial` for a RUNNING attempt, validated against the wire schema inside the best-effort boundary.
- Consumes: `keiExpClient.readExtractionProgress`, `partialFromProgress` (Task 6); `FreshExtractionInput.startPage` (Task 5).

- [ ] **Step 1: Write the failing tests.** In `prototypes/studio/api/extractions.test.ts`: the first import becomes `import { beforeEach, describe, expect, it, vi } from 'vitest'`; the hoisted `runtime` gains `readExtractionProgress: vi.fn<(runId: string, extractionId: string) => Promise<unknown | null>>()`, and the `vi.mock('./_extractions.js', …)` factory returns `keiExpClient: { ...actual.keiExpClient, readExtractionProgress: runtime.readExtractionProgress }` beside `createResearcherExtractions`. `snapshot` (30) and `catalogSnapshot` (359) gain `preprocessId: 'kei-exp:run-1:g1',` after `sourceRepresentationRevisionNumber`. The exact `expect(module.runSingle).toHaveBeenCalledWith({ kind: 'fresh', … })` of the fresh-request case (207-216) gains `startPage: null,` after `method`. Import the fixture: `import progressFixture from '../../parsing_service/tests/fixtures/contracts/extract.progress.json'`. Add `beforeEach(() => runtime.readExtractionProgress.mockReset())` at the top of the transport describe. New cases:

```ts
  it('passes the page the researcher was reading to admission, null when the request names none, and refuses a bad one', async () => {
    const module = extractionModule()
    const handler = handlerFor(module)
    expect((await handler(request({ ...fresh, startPage: 6 }))).status).toBeLessThan(300)
    expect(module.runSingle).toHaveBeenLastCalledWith(expect.objectContaining({ startPage: 6 }))
    expect((await handler(request(fresh))).status).toBeLessThan(300)
    expect(module.runSingle).toHaveBeenLastCalledWith(expect.objectContaining({ startPage: null }))
    for (const startPage of [0, 1.5, '6', -1])
      expect((await handler(request({ ...fresh, startPage }))).status).toBe(422)
    expect(module.runSingle).toHaveBeenCalledTimes(2)
  })

  it('reads a running job with kei\'s progress as a partial view, and without one when kei has none, is slow, or answers outside the contract', async () => {
    const running = { ...attemptSnapshot, executionStatus: 'RUNNING' as const, outcome: null, complete: null, modelAttribution: null,
      diagnostics: null, result: null, evidence: null, failure: null, reviewable: false, reviewedAt: null, reviewDecisions: [] }
    const handler = handlerFor(extractionModule({ readExtractionAttempt: vi.fn(async () => running) }))
    const read = async () => {
      const response = await handler(new Request(`http://test/api/extractions/${EXTRACTION}`))
      expect(response.status).toBe(200)
      return extractionReadResponseSchema.parse(await response.json())
    }
    runtime.readExtractionProgress.mockResolvedValueOnce(progressFixture)
    const shown = await read()
    expect(runtime.readExtractionProgress).toHaveBeenCalledWith('run-1', EXTRACTION)
    expect(shown.partial).toMatchObject({ strategy: 'CATALOG', startedAtPage: 1, discovered: 5, finished: 2 })
    expect(shown.partial!.records.map((record) => record.state)).toEqual(['finished', 'finished', 'checking', 'reading', 'queued'])
    expect(shown.partial!.records[0]!.values[JSON.stringify(['material'])]).toEqual({ value: 'Holz', state: 'grounded' })
    expect(shown.partial!.records[1]!.values[JSON.stringify(['site'])]).toEqual({ value: null, state: 'contested', candidates: ['Bdorf', 'Bdorf-Nord'] })
    runtime.readExtractionProgress.mockResolvedValueOnce(null)
    expect((await read()).partial).toBeNull()
    runtime.readExtractionProgress.mockRejectedValueOnce(Object.assign(new Error('timed out'), { transient: true }))
    expect((await read()).partial).toBeNull()
    runtime.readExtractionProgress.mockResolvedValueOnce({ version: 2 })
    expect((await read()).partial).toBeNull()
    // Inside kei's contract but outside Studio's wire contract (an empty link path): still null, still 200.
    const emptyPath = structuredClone(progressFixture) as typeof progressFixture
    ;(emptyPath.entries[0]!.evidence![0] as { path: unknown[] }).path = []
    runtime.readExtractionProgress.mockResolvedValueOnce(emptyPath)
    expect((await read()).partial).toBeNull()
  })

  it('never asks kei for progress unless the attempt is running', async () => {
    const queued = { ...attemptSnapshot, executionStatus: 'QUEUED' as const, outcome: null, complete: null, modelAttribution: null,
      diagnostics: null, result: null, evidence: null, failure: null, reviewable: false, reviewedAt: null, reviewDecisions: [] }
    for (const attempt of [queued, attemptSnapshot]) {
      const response = await handlerFor(extractionModule({ readExtractionAttempt: vi.fn(async () => attempt) }))(
        new Request(`http://test/api/extractions/${EXTRACTION}`))
      expect(response.status).toBe(200)
      expect(extractionReadResponseSchema.parse(await response.json()).partial).toBeNull()
    }
    expect(runtime.readExtractionProgress).not.toHaveBeenCalled()
  })
```

(`attemptSnapshot` is the completed attempt literal the file builds from `snapshot`; if it has another name, use that.) Add `preprocessId: 'kei-exp:run-1:g1'` to the snapshot literals in `_extractions.test.ts:134`, `document_reopen.test.ts:20`, `kei-artifact.test.ts:434` and `module.test.ts:143`.

- [ ] **Step 2: Run them to verify they fail** — `pnpm -C prototypes/studio exec vitest run api/extractions.test.ts` → FAIL (422 for a valid `startPage`: strict schema; no `partial`).

- [ ] **Step 3: `postgres-attempts.ts` and `types.ts`.** `pinsOf` selects `'revisionNumber', 'preprocessId'` from `SourceRepresentationRevision` and returns `preprocessId: representation.preprocessId,` after `sourceRepresentationRevisionNumber`. Both snapshot types gain, after `sourceRepresentationRevisionNumber: number`:

```ts
  /** The pinned revision's `preprocessId` (`kei-exp:<run>:<generation>`): the kei run a status read asks for progress.
   *  Server-side only; the DTO never carries it. */
  preprocessId: string
```

- [ ] **Step 4: `shared/extraction.contract.ts`.** In `extractionRequestSchema` after `method: extractionMethodIntentSchema,`:

```ts
    /** The page the researcher was reading when Run was clicked (one-based): the order kei reads records in, never
     *  which records. Absent when the view names none. */
    startPage: z.number().int().positive().optional(),
```

Before `extractionReadResponseSchema`:

```ts
/** One value of a record still being read (design §1): grounded once its link exists, checking while it is a
 *  candidate, reading while the call that would answer it is in flight or failed, empty when that call succeeded
 *  without it, contested when verified values disagreed and arbitration chose none (its candidates beside it). */
export const partialValueStateSchema = z.enum(['grounded', 'checking', 'reading', 'empty', 'contested'])
export type PartialValueState = z.infer<typeof partialValueStateSchema>
export const partialValueSchema = z
  .object({ value: z.json(), state: partialValueStateSchema, candidates: z.array(z.json()).optional() })
  .strict()
export type PartialValue = z.infer<typeof partialValueSchema>

export const partialRecordSchema = z
  .object({
    index: z.number().int().nonnegative(),
    label: z.string().nullable(),
    page: z.number().int().positive().nullable(),
    /** queued: discovered, not read yet; reading: its values call is in flight; checking: candidates under
     *  verification; finished: kei published the entry. */
    state: z.enum(['queued', 'reading', 'checking', 'finished']),
    /** The values so far, in the artifact's shape; null before the values call returned. */
    record: z.record(z.string(), z.json()).nullable(),
    /** Each leaf of `record` by its record-relative path (every step a string, JSON-encoded), with its state. */
    values: z.record(z.string(), partialValueSchema),
    evidenceLinks: z.array(evidenceLinkSchema),
  })
  .strict()
export type PartialRecord = z.infer<typeof partialRecordSchema>

/** A running Extraction's partial view (design §5): a view of files kei already wrote, never the record of truth.
 *  Records are in the order they were read: nearest the start page first, then source order. */
export const partialResultSchema = z
  .object({
    strategy: extractionStrategySchema,
    startedAtPage: z.number().int().positive().nullable(),
    discovered: z.number().int().nonnegative(),
    finished: z.number().int().nonnegative(),
    records: z.array(partialRecordSchema),
    document: z
      .object({
        contextsAnswered: z.number().int().nonnegative(),
        contexts: z.number().int().nonnegative(),
        groundingBatches: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict()
export type PartialResult = z.infer<typeof partialResultSchema>
```

and in `extractionReadResponseSchema`, after `pendingReviewDecisions`:

```ts
    /** The partial view while the attempt is RUNNING; null otherwise (absent in older stubs: read it as null). */
    partial: partialResultSchema.nullable().optional(),
```

- [ ] **Step 5: `api/extractions.ts`.** Imports: `import { ExtractionError, partialFromProgress, type ExtractionAttemptSnapshot } from 'extraction'`, `import { keiRunOf } from 'extraction/kei-handoff'`, add `partialResultSchema, type PartialResult` to the contract import and `keiExpClient` to the `./_extractions.js` import. In `create`, the `input` literal gains `startPage: parsed.data.startPage ?? null,` after `method: parsed.data.method,`. `read` becomes:

```ts
  async function read(extractionId: string): Promise<Response> {
    const extraction = await module.readExtractionAttempt(extractionId).catch(unavailableUnlessDomain)
    if (!extraction)
      throw new ApiError(404, 'not_found', 'That Extraction was not found.')
    const pendingReviewDecisions = extraction.executionStatus === 'COMPLETED'
      ? (await module.prepareReview(extractionId)).reviewDecisions
      : null
    const partial = extraction.executionStatus === 'RUNNING' ? await readPartial(extraction) : null
    return json(
      extractionReadResponseSchema.parse({
        extraction: extractionAttemptDto(extraction),
        pendingReviewDecisions,
        partial,
        reviewDraft: extraction.executionStatus === 'COMPLETED' ? await module.readReviewDraft(extractionId) : undefined,
      }),
      { headers: noStore },
    )
  }
```

and, above `createResearcherApiHandlers`:

```ts
/** The partial view of a running Extraction (design §5): kei's progress document, read under PROGRESS_TIMEOUT_MS,
 *  converted with the artifact reader's own code and validated against the wire contract, all inside one best-effort
 *  boundary: no stage file yet, a slow or unreachable kei, or a document outside either contract is null, and the read
 *  answers as it did before. */
async function readPartial(extraction: ExtractionAttemptSnapshot): Promise<PartialResult | null> {
  const run = keiRunOf(extraction.preprocessId)
  if (run === null) return null
  try {
    const progress = await keiExpClient.readExtractionProgress(run.runId, extraction.extractionId)
    if (progress === null) return null
    const partial = partialResultSchema.safeParse(partialFromProgress(progress))
    return partial.success ? partial.data : null
  } catch {
    return null
  }
}
```

(`partialFromProgress` returns the package's readonly type or null; the wire schema's `safeParse` takes `unknown`, so the two types meet only there, and a null converter result fails the parse and is null.)

- [ ] **Step 6: Run the tests to verify they pass** — `pnpm -r typecheck && pnpm --filter studio lint && pnpm -C prototypes/studio exec vitest run api/extractions.test.ts api/_extractions.test.ts api/document_reopen.test.ts src/useExtraction.test.tsx src/App.test.tsx && pnpm --filter extraction test` → PASS (the client's mocked reads parse without `partial`: Ruling 12). `preprocessId` is required on both snapshot types: typecheck names any further snapshot literal (an untyped object a typed mock returns, for instance), and each gets `preprocessId: 'kei-exp:run-1:g1'`; the field is never made optional to get green.

- [ ] **Step 7: Commit** — `feat(studio): the run request names the page being read; a running attempt reads back with its partial view`.

---

### Task 8: Gates, documentation and the spec's status

**Files:**
- Modify: `docs/superpowers/specs/2026-10-02-view-ordered-streaming-extraction-design.md:3` (Status), `prototypes/parsing_service/README.md` (verify Task 4's text reads well in place)

- [ ] **Step 1: Full gates.** From the worktree root: `pnpm -r typecheck && pnpm --filter studio lint && pnpm --filter db test && pnpm --filter extraction test && pnpm --filter studio test` → PASS. From `prototypes/parsing_service`: the fast tier `/home/gennaro/projects/FREE/prototypes/parsing_service/.venv/bin/python -m pytest -q -m "not postgres and not live_model"` → PASS. Where a disposable database is available (`EXTRACTION_TEST_DATABASE_URL`, `PARSING_TEST_DATABASE_URL`): `pnpm --filter db test:postgres`, `pnpm --filter extraction test:postgres`, `pnpm --filter studio test:postgres`, and the Parsing Service `test:postgres` tier; otherwise record in the ledger which tiers wait for the Baratheon verification (`~/pr-validation/run-tiers.sh` runs them there).

- [ ] **Step 2: The spec's status.** Line 3 of the spec becomes `Date: 2026-10-02 · Status: Part A (service, package, API) implemented by `docs/superpowers/plans/2026-10-03-view-ordered-streaming-service.md`; Part B (client, `…-client.md`) pending · Scope:` (keep the rest of the line). Part B's last task sets it to implemented.

- [ ] **Step 3: A last read of the README paragraphs** Task 4 edited: the route sentence and the stage-file clause are in the `extract` bullet and the unified paragraph, each one sentence, no duplicated clause.

- [ ] **Step 4: Commit** — `docs(kei): the progress route and the stage files in the Parsing Service README; spec status`.

---

## Self-review

**Spec coverage.** §1 (states, order, header, badge) → Part B, on this plan's `PartialResult` (Task 6) and `partial` (Task 7); `contested` travels from a finished entry's unresolved contest (Task 4) through the converter (Task 6) and the wire (Task 7). §2 candidates file → Task 2; finished entry unchanged → Task 2 (`read` publishes as before); Article context and grounding files → Task 3 (per execution, Ruling 4; the context file carries the root assembled so far, Ruling 6). §3 route, 404 rule, shape, `page` from the first range, `record`/`evidence` by the artifact's code, same process and `run_dir` lookup → Task 4. §4 `Options.start_page` and `dumped()` → Task 1; unified distance order with source-order assembly → Task 2; Article bounded contexts → Task 3; Studio `startPage` on the request, the row, one migration, `keiExtractRequest` inside the `submitToKei` body, the legacy checkpoint → Tasks 5 and 7; batches send none → Task 5 (`admitBatchMember` unchanged). §5 `read()` under two seconds, `partial` nullable, `partialFromProgress` with the artifact's link code → Tasks 6 and 7; `useExtraction`, `ResultsTab`, overlays, badge → Part B. Error handling: stage files skipped when unreadable → Task 4 (`_stage`); a stage write that fails never fails the extraction → Task 2 (`write_stage`); GC removes them with the directory (no change: `deleteRuns` removes the run); the read degrades to today's behaviour → Task 7; the settled result wins → Part B. Testing: every bullet of the spec's Parsing Service, `packages/extraction` and Studio API lists has a test above; the client and browser bullets are Part B's. Files: `progress.py`, the route, the migration, `partial-result.ts` and the tests beside each; every edited file named in the spec is edited here except `kei-handoff.ts` (its options record already admits `start_page`), `src/*` (Part B) and `workflows/extract.py` (the id reaches Article through `run.dispatch`, which `extract_run` already calls with `extraction_id`).

**Placeholder scan.** No TBD/TODO; every code step has its code; every test has its assertions. The migration directory's timestamp is generated by the tool and matched by suffix in its test.

**Type consistency.** `start_page` (kei, request options) ↔ `startPage` (Studio, rows, request body) at the `keiExtractRequest` boundary only. `progress.ProgressDocument` ↔ `progressDocumentSchema` ↔ `extract.progress.json`: `version`, `strategy`, `started_at_page`, `discovered`, `finished`, `entries[].{index,label,page,stage,candidates,record,evidence,contested,failed}`, `document.{contexts,answered,of,failed_contexts,links,grounding_batches}`. The package's `PartialResult` (readonly, `value: unknown`) meets the wire's `partialResultSchema` only through `safeParse` in `readPartial` (Task 7) and in Part B's test fixtures; `records[].{index,label,page,state,record,values,evidenceLinks}`, `values[].{value,state,candidates?}`, `document.{contextsAnswered,contexts,groundingBatches}` match field for field. `KeiStandInScript.progress` returns the raw document the route serves. `entry_links(record, passages)` takes the published entry file and a `{id: Passage}` map, as `_link` does. `on_context`'s nine arguments are the same in `document_root`, `_context_stage` and the Task 3 test.

**Review Focus.** Each line names its task; Task 7's tests cover 1 (throw → null), 3 (422) and 4 (null → 200, including a document inside kei's contract but outside the wire's); Task 5's test covers 2; Task 4's tests cover 4 (malformed and half-written stage files) and 5 (another execution's files); Task 2 covers the failed stage write.

## Review log — Codex gpt-6-astra (reasoning max), round 1, 2026-10-03

Accepted and applied: P0-1 (`strict=True` on `start_page`; strings, booleans and fractions refused in the test) · P0-2 (package and wire `PartialResult` meet only through `partialResultSchema.safeParse`, in `readPartial` and in Part B's fixtures) · P0-3 (the record-scope migration test loses its ref assertion; the latest migration's test owns it) · P0-4 (`accept(...).extraction.outcome`) · P0-5 (fixtures typed through `progressDocumentSchema.parse`; Part B's badge fixture typed as the wire `PartialResult`) · P0-6 (the exact `runSingle` expectation gains `startPage: null`; `beforeEach` imported) · P0-7 and P0-8 (Part B: scoped candidate assertions; helpers moved out of the component file) · P1-1 (kei assembles the running root with `assemble_document` and `conform` after each context; the reader takes the latest, Ruling 6) · P1-2 (an execution token on the header and every stage file; the reader skips other executions', Ruling 4) · P1-3 (`write_stage` contains `OSError`) · P1-4 (pydantic stage models validate every file; `readPartial` validates the wire DTO inside its catch) · P1-5 and P2-1 (Part B: the partial lives on the monitor across reconnects; a finished record is replaced only by one with at least as many links; the focus overlay survives a poll) · P1-6 (`contested` from `work.contest` and from Article's conflicts, through the contract, the converter and the renderer) · P1-7 (Ruling 7: nulls of a failed window or context stay `reading`) · P1-9 (Part B's browser test puts the current-page record later in source order and asserts the stand-in received `start_page`) · P2-2 (the comment on a page beyond the document) · P2-3 (Part A marks Part B pending; Ruling 13 reads §1's order as §4's).

Rejected or narrowed: P1-8 — a shared keyed presentation preserving DOM rows across settlement would put the settled view's navigation and review controls over partial records; out of this plan's scope. Part B's Ruling 7 now states the swap honestly (two components, one render, the order changing once from reading order to source order) and its test asserts that, not continuity; the human may overrule.

## Review log — Codex gpt-6-astra (reasoning max), round 2, 2026-10-03

Accepted and applied: P0-1 (the stage token is `stage_execution`: `execution` is the execution record assigned a few lines below in `unified.extract`) · P0-2 (`conform` turns an empty list into `None`; the running-root test expects `"finds": None`) · P0-3 (the Article fixture in `partial-result.test.ts` goes through `progressDocumentSchema.parse`, so its nullable members are assignable) · P1-1 (Article links are attached only once the latest context file shows every context answered: grounding verifies the final root; tested with a grounding file beside an incomplete root) · P1-2 (the context file carries the cumulative `failed`, read from the latest file alone; `on_context` gains it; tested with a failed first context) · P1-3 (`_ContestRow`, `_CandidateRow`, `_LinkRow` validate the rows the reader consumes, a file with a row outside its shape is skipped whole, a discovery record with a non-object entry is no progress; tested) · P2 (Part B records the settlement ruling in the spec's §1 sentence; Part B's Ruling 8 narrowed to leaf paths). Part B's P0-4 and P0-5 (a multi-match `Missing` query; test refs recreated per render) are applied in Part B.

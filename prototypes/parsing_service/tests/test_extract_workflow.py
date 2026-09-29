"""kei `extract`: one step over a complete parse, with the same retry policy as convert (spec, *kei worker*)."""
import ast
import hashlib
import json
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest
import requests
from sqlalchemy.exc import OperationalError

from kei_exp import runs
from kei_exp.failures import KeiFailure
from kei_exp.kie.extract import grounded, tokens
from kei_exp.kie.extract import run as extraction
from kei_exp.kie.passages import load
from kei_exp.kie.recipe import load_recipe
from kei_exp.kie.segmentation import load_segmentation
from kei_exp.workflows import config, contracts
from kei_exp.workflows import extract as workflow
from tests.helpers import catalogue
from tests.helpers import kei as kei_helper
from tests.test_extract_grounded import CountingChat, WordCounter, entry_text, honest

FIXTURES = Path(__file__).parent / "fixtures" / "contracts"
WID = "kei-extract:x-1"


@pytest.fixture
def scripted(monkeypatch):
    """Every extraction talks to one scripted chat and counts words; a test swaps `state["script"]`."""
    state = {"script": honest}
    monkeypatch.setattr(workflow, "chats_for", lambda options: CountingChat(lambda *a: state["script"](*a)))
    monkeypatch.setattr(tokens, "counter_for", lambda client: WordCounter())
    return state


@pytest.fixture
def parsed(tmp_path, monkeypatch, scripted):
    monkeypatch.setattr(runs, "RUNS", tmp_path / "runs")
    run_id = kei_helper.converted_run(runs.RUNS, "kei-convert:ingest:p:a")
    return run_id, catalogue.GENERATION


@pytest.fixture
def ended(monkeypatch):
    """How the step's extraction ended (the error, or None), recorded once it has returned: after every Catalog chunk
    thread, and after the step's last cancellation check."""
    outcomes: list[BaseException | None] = []
    original = workflow.extract

    def extract(*args, **kwargs):
        try:
            result = original(*args, **kwargs)
        except BaseException as error:
            outcomes.append(error)
            raise
        outcomes.append(None)
        return result
    monkeypatch.setattr(workflow, "extract", extract)
    return outcomes


V1 = {"catalog": {"strategy": "catalog"}, "article": {"strategy": "article"}}  # no recipe: the version 1 paths


def stage_of(schema: dict) -> str:
    properties = schema.get("properties", {})
    return ("discovery" if "starts" in properties else "records" if "records" in properties
            else "record" if "site_name" in properties else "grounding")


def version_1(events: list[str], hold=lambda stage: None):
    """A chat for the version 1 paths: every passage starts a record, and every record's site is a word the source
    does not contain, so verifying it asks the model. `hold(stage)` runs inside each call."""
    def script(system, user, schema):
        stage = stage_of(schema)
        events.append(stage)
        hold(stage)
        if stage == "discovery":
            return {"starts": schema["properties"]["starts"]["items"]["enum"], "end": None}
        if stage == "records":
            labels = schema["properties"]["records"]["items"]["properties"]["passages"]["items"]["enum"]
            return {"records": [{"label": name, "identity": {}, "passages": [labels[0]]}
                                for name in ("Nowhere", "Elsewhere")]}
        return {"site_name": "Nowhere"} if stage == "record" else {}
    return script


def test_the_step_publishes_the_artifact_and_names_its_digest(parsed, monkeypatch):
    monkeypatch.setattr(workflow, "CATALOG_CHUNKS", 3)
    run_id, generation = parsed
    body = kei_helper.extract_request(run_id, generation)["request"]
    output = workflow.extract_run(WID, run_id, generation, body)
    contracts.ExtractOk.model_validate(output)
    artifact = runs.RUNS / run_id / "extractions" / "x-1" / "result.json"
    assert output["artifact_sha256"] == hashlib.sha256(artifact.read_bytes()).hexdigest()
    assert json.loads(artifact.read_text())["chunks"] == 3 and output["extraction_id"] == "x-1"


def test_an_unreadable_status_at_a_chunked_catalog_entry_fails_open_and_the_artifact_publishes(parsed, monkeypatch,
                                                                                               caplog):
    """A database restart while chunk threads ask before their entries is not a cancel: every entry is read, the
    artifact published, and one warning logged without the driver's message."""
    from kei_exp.workflows import cancel
    secret = "sk-test-chunk-status-read"
    step_thread = threading.get_ident()

    def read(wid):
        if threading.get_ident() != step_thread:  # the forced check passes; every chunk thread's read fails
            raise OperationalError("SELECT status", {}, Exception(f"connection refused; password={secret}"))
        return SimpleNamespace(status="PENDING")
    monkeypatch.setattr(cancel, "DBOS", SimpleNamespace(workflow_id=WID, get_workflow_status=read))
    monkeypatch.setattr(cancel, "MIN_INTERVAL", 0.0)
    monkeypatch.setattr(workflow, "CATALOG_CHUNKS", 3)
    run_id, generation = parsed
    with caplog.at_level("WARNING", logger=cancel.__name__):
        output = workflow.extract_run(WID, run_id, generation, kei_helper.extract_request(run_id, generation)["request"])
    contracts.ExtractOk.model_validate(output)
    artifact = json.loads((runs.RUNS / run_id / "extractions" / "x-1" / "result.json").read_text())
    assert artifact["chunks"] == 3 and len(artifact["records"]) == 5  # the headings fixture's five entries
    warnings = [record for record in caplog.records if record.name == cancel.__name__]
    assert len(warnings) == 1 and secret not in caplog.text


def long_catalogue(pages: int) -> dict:
    """A catalogue whose pages each fill a 1,000-character discovery window: one discovery call per page."""
    return {"pages": [{"page": page, "units": [{"index": 1, "crops": [{"segments": [
        f"{page}. Ort{page}. FA: G. " + "Beschreibung " * 90]}]}]} for page in range(1, pages + 1)]}


def test_a_cancel_stops_a_version_1_catalogs_discovery_at_its_next_window(tmp_path, scripted, monkeypatch):
    """A Catalog without a recipe discovers its records window by window before it reads any; a cancel during the
    first window's call keeps the step from asking the others, so its kei-extract slot frees promptly."""
    from kei_exp.workflows import cancel
    cancelled = {"now": False}
    monkeypatch.setattr(cancel, "DBOS", SimpleNamespace(
        workflow_id=WID, get_workflow_status=lambda wid: SimpleNamespace(
            status="CANCELLED" if cancelled["now"] else "PENDING")))
    monkeypatch.setattr(cancel, "MIN_INTERVAL", 0.0)
    monkeypatch.setattr(runs, "RUNS", tmp_path / "runs")
    run_id = kei_helper.converted_run(runs.RUNS, "kei-convert:ingest:p:long", long_catalogue(4))
    events: list[str] = []
    scripted["script"] = version_1(events, hold=lambda stage: cancelled.update(now=True))
    body = kei_helper.extract_request(run_id, catalogue.GENERATION,
                                      {"strategy": "catalog", "discovery_chars": 1_000})["request"]
    with pytest.raises(KeiFailure) as stopped:
        workflow.extract_run(WID, run_id, catalogue.GENERATION, body)
    assert stopped.value.code == "cancelled" and events == ["discovery"]


def test_a_rewritten_parse_is_a_stale_generation_before_any_model_call(parsed, scripted):
    calls = []
    scripted["script"] = lambda *a: calls.append(a) or honest(*a)
    run_id, _ = parsed
    with pytest.raises(KeiFailure) as refused:
        workflow.extract_run(WID, run_id, "another-generation", kei_helper.extract_request(run_id, "g")["request"])
    assert refused.value.code == "stale_generation" and calls == []


@pytest.mark.parametrize("change, code", [
    ({"run_id": "run-missing"}, "no_result"),
    ({"body": {"schema": {}, "options": {"models": {"fields": "nope"}}}}, "invalid_request"),
    ({"workflow_id": "kei-extract:../x"}, "invalid_request"),
])
def test_what_the_step_refuses(parsed, change, code):
    run_id, generation = parsed
    args = {"workflow_id": WID, "run_id": run_id, "generation": generation,
            "body": kei_helper.extract_request(run_id, generation)["request"], **change}
    with pytest.raises(KeiFailure) as refused:
        workflow.extract_run(**args)
    assert refused.value.code == code


def test_an_incomplete_parse_has_no_result(parsed):
    run_id, generation = parsed
    manifest = runs.RUNS / run_id / "result" / "result.json"
    data = json.loads(manifest.read_text())
    manifest.write_text(json.dumps({**data, "status": "incomplete", "incomplete": "page 2"}))
    with pytest.raises(KeiFailure) as refused:
        workflow.extract_run(WID, run_id, generation, kei_helper.extract_request(run_id, generation)["request"])
    assert refused.value.code == "no_result"


def test_a_failed_chunk_stops_the_other_chunks_and_publishes_nothing(parsed, scripted, monkeypatch):
    monkeypatch.setattr(workflow, "CATALOG_CHUNKS", 3)  # headings: entries [1], [2, 3], [4, 5]
    halted = threading.Event()

    class Watched(threading.Event):  # the chunks' shared halt flag, observable by the script
        def set(self) -> None:
            super().set()
            halted.set()
    monkeypatch.setattr(grounded, "threading", SimpleNamespace(Event=Watched))
    arrived, asked = threading.Barrier(3, timeout=10), []

    def script(system, user, schema):
        entry = entry_text(user)[:2]
        asked.append(entry)
        if entry in ("1.", "2.", "4."):  # the first entry of each chunk: all three are in flight at once
            arrived.wait()
        if entry == "1.":
            raise RuntimeError("the fields server failed on this entry")
        assert halted.wait(timeout=10), "the failed chunk never halted the others"
        return honest(system, user, schema)
    scripted["script"] = script
    run_id, generation = parsed
    with pytest.raises(RuntimeError, match="failed on this entry"):
        workflow.extract_run(WID, run_id, generation, kei_helper.extract_request(run_id, generation)["request"])
    assert sorted(asked) == ["1.", "2.", "4."]  # entries 3 and 5 were never asked
    assert not (runs.RUNS / run_id / "extractions").exists()


def test_the_version_1_catalog_checks_before_discovery_and_each_record_and_verification(parsed):
    run_id, _ = parsed
    events: list[str] = []
    request = extraction.ExtractRequest.model_validate(kei_helper.extract_request(run_id, "g", V1["catalog"])["request"])
    extraction.extract(runs.RUNS / run_id, request, CountingChat(version_1(events)),
                       before_entry=lambda: events.append("check"))
    records = events.count("record")
    assert records > 1
    # Each record checks before verification and before its (here single) grounding batch.
    assert events == ["check", "discovery", *["check", "record"] * records, *["check", "check", "grounding"] * records]


def test_the_article_checks_before_its_records_call_and_each_verification(parsed):
    run_id, _ = parsed
    events: list[str] = []
    request = extraction.ExtractRequest.model_validate(kei_helper.extract_request(run_id, "g", V1["article"])["request"])
    extraction.extract(runs.RUNS / run_id, request, CountingChat(version_1(events)),
                       before_entry=lambda: events.append("check"))
    assert events == ["check", "records", "check", "record", "check", "record",
                      "check", "check", "grounding", "check", "check", "grounding"]


@pytest.mark.parametrize("strategy, asked", [("catalog", ["discovery", "record"]),
    ("article", ["records"]), ("article", ["records", "record"])])
def test_a_version_1_check_that_raises_ends_the_extraction_before_its_next_call(parsed, strategy, asked):
    run_id, _ = parsed
    events: list[str] = []

    def before_entry():
        events.append("check")
        if events.count("check") == len(asked) + 1:
            raise KeiFailure("cancelled", "stop")
    request = extraction.ExtractRequest.model_validate(kei_helper.extract_request(run_id, "g", V1[strategy])["request"])
    with pytest.raises(KeiFailure, match="cancelled"):
        extraction.extract(runs.RUNS / run_id, request, CountingChat(version_1(events)), before_entry=before_entry)
    assert [event for event in events if event != "check"] == asked


def test_both_workflows_give_up_after_five_recovery_attempts():
    """dbos 3.1.0 has no public read of a workflow's recovery limit, so the decorators are read from the source."""
    from kei_exp.workflows import convert
    assert config.MAX_RECOVERY_ATTEMPTS == 5
    for module, name in ((convert, "convert"), (workflow, "extract")):
        tree = ast.parse(Path(module.__file__).read_text())
        decorators = [decorator for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)
                      for decorator in node.decorator_list
                      if isinstance(decorator, ast.Call) and ast.unparse(decorator.func) == "DBOS.workflow"]
        [decorator] = decorators
        keywords = {keyword.arg: ast.unparse(keyword.value) for keyword in decorator.keywords}
        assert keywords["name"] == repr(name)
        assert keywords["max_recovery_attempts"] == "config.MAX_RECOVERY_ATTEMPTS"


@pytest.mark.parametrize("value, chunks", [(None, 1), ("4", 4), ("1", 1), ("64", 64)])
def test_the_chunk_setting(value, chunks):
    assert workflow.catalog_chunks({} if value is None else {"KEI_CATALOG_CHUNKS": value}) == chunks


@pytest.mark.parametrize("value", ["0", "-2", "four", "", "65", "400"])
def test_a_bad_chunk_setting_stops_the_worker(value):
    with pytest.raises(ValueError, match="KEI_CATALOG_CHUNKS"):
        workflow.catalog_chunks({"KEI_CATALOG_CHUNKS": value})


def unified_body() -> dict:
    from tests.test_unified_catalog import SCHEMA
    return {"schema": SCHEMA, "options": {"strategy": "catalog", "unified": {"defaults": 1}}}


def unified_model(run_id: str, asked: list[str], fail_first_entry: list[bool] | None = None):
    """The unified Catalog's careful scripted model over the run's source; `asked` records each stage called."""
    from tests.test_unified_catalog import Model
    model = Model(load(runs.RUNS / run_id))

    def script(system, user, schema):
        asked.append(system.split(" ")[1])
        if fail_first_entry and system.startswith("You extract structured data"):
            fail_first_entry.pop()
            raise requests.ConnectionError("the model server restarted")
        return model(system, user, schema)
    return script


def test_a_unified_extraction_publishes_its_records_and_a_re_execution_reuses_them(parsed, scripted):
    run_id, generation = parsed
    asked: list[str] = []
    scripted["script"] = unified_model(run_id, asked)
    output = workflow.extract_run(WID, run_id, generation, unified_body())
    directory = runs.RUNS / run_id / "extractions" / "x-1"
    artifact = json.loads((directory / "result.json").read_text())
    assert artifact["extraction_version"] == 3 and output["artifact_sha256"]
    for name, key in (("catalog-execution.json", "execution"), ("catalog-discovery.json", "discovery")):
        assert hashlib.sha256((directory / name).read_bytes()).hexdigest() == artifact[f"{key}_sha256"]
    assert asked.count("find") == 1
    workflow.extract_run(WID, run_id, generation, unified_body())  # the step runs again, as after a lost response
    assert asked.count("find") == 1  # discovery was reused, not redone
    assert json.loads((directory / "result.json").read_text())["discovery_sha256"] == artifact["discovery_sha256"]


def test_a_unified_extraction_the_served_context_can_no_longer_fit_is_a_budget_refusal(parsed, scripted, monkeypatch):
    run_id, generation = parsed
    scripted["script"] = unified_model(run_id, [])
    workflow.extract_run(WID, run_id, generation, unified_body())
    smaller = WordCounter()
    smaller.context_tokens = 4_096
    monkeypatch.setattr(tokens, "counter_for", lambda client: smaller)
    with pytest.raises(KeiFailure) as refused:
        workflow.extract_run(WID, run_id, generation, unified_body())
    assert refused.value.code == "budget_refused" and "budget_unhonorable" in refused.value.reason


# --- through DBOS ------------------------------------------------------------------------------------------------


def test_a_unified_step_retried_after_discovery_reuses_the_published_discovery(kei, scripted):
    run_id = kei_helper.converted_run(kei.runs, "kei-convert:ingest:p:a")
    asked: list[str] = []
    scripted["script"] = unified_model(run_id, asked, fail_first_entry=[True])
    request = {"run_id": run_id, "generation": catalogue.GENERATION, "request": unified_body()}
    output = kei.output(kei.enqueue("extract", config.EXTRACT, WID, request, priority=config.PRIORITY_INTERACTIVE))
    contracts.ExtractOk.model_validate(output)
    assert asked.count("find") == 1  # the transient failure after discovery retried the step, not discovery
    artifact = json.loads((kei.runs / run_id / "extractions" / "x-1" / "result.json").read_text())
    assert artifact["complete"] is True and len(artifact["records"]) == 5


def test_the_contract_fixture_extracts_through_a_portable_enqueue(kei, scripted):
    fixture = json.loads((FIXTURES / "extract.input.json").read_text())
    run_id = kei_helper.converted_run(kei.runs, "kei-convert:ingest:p:a")
    request = {**fixture["request"], "run_id": run_id, "generation": catalogue.GENERATION}
    options = fixture["enqueue"]
    output = kei.output(kei.enqueue("extract", options["queue_name"], options["workflow_id"], request,
                                    priority=options["priority"], timeout_ms=options["workflow_timeout_ms"]))
    contracts.ExtractOk.model_validate(output)
    assert set(output) == set(json.loads((FIXTURES / "extract.output.ok.json").read_text()))


def test_a_stale_generation_is_a_typed_failure(kei, scripted):
    run_id = kei_helper.converted_run(kei.runs, "kei-convert:ingest:p:a")
    output = kei.output(kei.enqueue("extract", config.EXTRACT, WID, kei_helper.extract_request(run_id, "old"),
                                    priority=config.PRIORITY_INTERACTIVE))
    assert (output["ok"], output["code"], output["retryable"]) == (False, "stale_generation", False)


def test_two_extractions_of_one_run_each_publish_and_share_one_valid_segmentation(kei, scripted):
    both_inside = threading.Barrier(2, timeout=30)
    first_call: set[str] = set()

    def script(system, user, schema):
        from dbos import DBOS
        if DBOS.workflow_id not in first_call:  # both extractions are inside their step at once
            first_call.add(DBOS.workflow_id)
            both_inside.wait()
        return honest(system, user, schema)
    scripted["script"] = script
    run_id = kei_helper.converted_run(kei.runs, "kei-convert:ingest:p:a")
    ids = [kei.enqueue("extract", config.EXTRACT, f"kei-extract:x-{n}",
                       kei_helper.extract_request(run_id, catalogue.GENERATION), priority=config.PRIORITY_BATCH)
           for n in (1, 2)]
    outputs = [kei.output(workflow_id) for workflow_id in ids]
    directory = kei.runs / run_id
    artifacts = [json.loads((directory / "extractions" / f"x-{n}" / "result.json").read_text()) for n in (1, 2)]
    evidence = load(directory)
    segmentation = load_segmentation(directory, evidence, load_recipe("numbered-catalogue-de@1"))
    assert segmentation is not None
    assert {artifact["segmentation"]["fingerprint"] for artifact in artifacts} == {segmentation.fingerprint}
    assert [output["extraction_id"] for output in outputs] == ["x-1", "x-2"]


def test_a_cancelled_catalog_stops_before_its_next_entry(kei, scripted, monkeypatch):
    from kei_exp.workflows import cancel
    monkeypatch.setattr(cancel, "MIN_INTERVAL", 0.0)
    gate, calls = kei_helper.Gate(), []
    gate.hold(WID)
    scripted["script"] = lambda *a: calls.append(1) or (gate() if len(calls) == 1 else None) or honest(*a)
    run_id = kei_helper.converted_run(kei.runs, "kei-convert:ingest:p:a")
    kei.enqueue("extract", config.EXTRACT, WID, kei_helper.extract_request(run_id, catalogue.GENERATION),
                priority=config.PRIORITY_INTERACTIVE)
    kei_helper.until(lambda: WID in gate.entered, 30, "the first entry's call")
    from dbos import DBOS
    DBOS.cancel_workflow(WID)
    gate.release(WID)
    assert kei.wait(WID).status == "CANCELLED"
    kei_helper.until(lambda: WID in gate.left, 10, "the blocked call returning")
    assert len(calls) == 1  # the headings fixture has five entries; the second was never asked


def test_a_cancelled_chunked_catalog_stops_every_chunk_before_its_next_entry(kei, scripted, ended, monkeypatch):
    """Chunk threads carry no DBOS context: the step's check must still read the workflow's status from each."""
    from dbos import DBOS

    from kei_exp.workflows import cancel
    monkeypatch.setattr(cancel, "MIN_INTERVAL", 0.0)
    monkeypatch.setattr(workflow, "CATALOG_CHUNKS", 2)  # headings: entries [1, 2], [3, 4, 5]
    arrived, released, asked = threading.Barrier(3, timeout=30), threading.Event(), []

    def script(system, user, schema):
        entry = entry_text(user)[:2]
        asked.append(entry)
        if entry in ("1.", "3."):  # the first entry of each chunk, both in flight, held until the cancel
            arrived.wait()
            released.wait(timeout=30)
        return honest(system, user, schema)
    scripted["script"] = script
    run_id = kei_helper.converted_run(kei.runs, "kei-convert:ingest:p:a")
    kei.enqueue("extract", config.EXTRACT, WID, kei_helper.extract_request(run_id, catalogue.GENERATION),
                priority=config.PRIORITY_INTERACTIVE)
    arrived.wait()
    DBOS.cancel_workflow(WID)
    released.set()
    assert kei.wait(WID).status == "CANCELLED"
    kei_helper.until(lambda: ended, 10, "the step's extraction returning")
    assert isinstance(ended[0], KeiFailure) and ended[0].code == "cancelled"
    assert sorted(asked) == ["1.", "3."]  # neither chunk asked its second entry
    assert not (kei.runs / run_id / "extractions").exists()


@pytest.mark.parametrize("strategy, held, asked", [
    ("catalog", "record", ["discovery", "record"]),  # held in the first record's call; the second never asked
    ("article", "records", ["records"]),             # held in inventory; no value extraction asked
    ("article", "record", ["records", "record"]),
    ("article", "grounding", ["records", "record", "record", "grounding"]),
])
def test_a_cancelled_version_1_extraction_stops_before_its_next_call(kei, scripted, ended, monkeypatch, strategy,
                                                                     held, asked):
    from dbos import DBOS

    from kei_exp.workflows import cancel
    monkeypatch.setattr(cancel, "MIN_INTERVAL", 0.0)
    gate, events = kei_helper.Gate(), []
    gate.hold(WID)
    scripted["script"] = version_1(events, hold=lambda stage: gate() if events == [*asked[:-1], held] else None)
    run_id = kei_helper.converted_run(kei.runs, "kei-convert:ingest:p:a")
    kei.enqueue("extract", config.EXTRACT, WID, kei_helper.extract_request(run_id, catalogue.GENERATION, V1[strategy]),
                priority=config.PRIORITY_INTERACTIVE)
    kei_helper.until(lambda: WID in gate.entered, 30, f"the {held} call")
    DBOS.cancel_workflow(WID)
    gate.release(WID)
    assert kei.wait(WID).status == "CANCELLED"
    kei_helper.until(lambda: ended, 10, "the step's extraction returning")
    assert isinstance(ended[0], KeiFailure) and ended[0].code == "cancelled"
    assert events == asked
    assert not (kei.runs / run_id / "extractions").exists()


@pytest.mark.parametrize("strategy, first", [("article", "records"), ("catalog", "discovery")])
def test_cancellation_during_the_final_model_call_prevents_publication(tmp_path, scripted, monkeypatch,
                                                                      strategy, first):
    from kei_exp.workflows import cancel

    status = SimpleNamespace(status="PENDING")
    monkeypatch.setattr(cancel, "DBOS", SimpleNamespace(workflow_id=WID, get_workflow_status=lambda wid: status))
    # The final publication check must bypass the throttle, even after a very recent successful read.
    monkeypatch.setattr(cancel, "MIN_INTERVAL", 60.0)
    monkeypatch.setattr(runs, "RUNS", tmp_path / "runs")
    source = {"pages": [{"page": 1, "units": [{"index": 0, "segments": ["Hill", "Valley"]}]}]}
    run_id = kei_helper.converted_run(runs.RUNS, "kei-convert:ingest:p:final-call", source)
    events = []
    expected = [first, "record", "record", "grounding", "grounding"]

    def cancel_final_call(stage):
        if events == expected:
            status.status = "CANCELLED"

    scripted["script"] = version_1(events, hold=cancel_final_call)
    body = kei_helper.extract_request(run_id, catalogue.GENERATION, V1[strategy])["request"]
    with pytest.raises(KeiFailure) as stopped:
        workflow.extract_run(WID, run_id, catalogue.GENERATION, body)
    assert stopped.value.code == "cancelled"
    assert events == expected
    assert not (runs.RUNS / run_id / "extractions").exists()

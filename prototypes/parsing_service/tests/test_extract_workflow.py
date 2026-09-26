"""kei `extract`: one step over a complete parse, with the same retry policy as convert (spec, *kei worker*)."""
import hashlib
import json
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from kei_exp import runs
from kei_exp.failures import KeiFailure
from kei_exp.kie.extract import grounded
from kei_exp.kie.extract import run as extraction
from kei_exp.kie.extract.evidence import load
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
    monkeypatch.setattr(extraction, "counter_for", lambda client: WordCounter())
    return state


@pytest.fixture
def parsed(tmp_path, monkeypatch, scripted):
    monkeypatch.setattr(runs, "RUNS", tmp_path / "runs")
    run_id = kei_helper.converted_run(runs.RUNS, "kei-convert:ingest:p:a")
    return run_id, catalogue.GENERATION


def test_the_step_publishes_the_artifact_and_names_its_digest(parsed, monkeypatch):
    monkeypatch.setattr(workflow, "CATALOG_CHUNKS", 3)
    run_id, generation = parsed
    body = kei_helper.extract_request(run_id, generation)["request"]
    output = workflow.extract_run(WID, run_id, generation, body)
    contracts.ExtractOk.model_validate(output)
    artifact = runs.RUNS / run_id / "extractions" / "x-1" / "result.json"
    assert output["artifact_sha256"] == hashlib.sha256(artifact.read_bytes()).hexdigest()
    assert json.loads(artifact.read_text())["chunks"] == 3 and output["extraction_id"] == "x-1"


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


@pytest.mark.parametrize("value, chunks", [(None, 1), ("4", 4), ("1", 1)])
def test_the_chunk_setting(value, chunks):
    assert workflow.catalog_chunks({} if value is None else {"KEI_CATALOG_CHUNKS": value}) == chunks


@pytest.mark.parametrize("value", ["0", "-2", "four", ""])
def test_a_bad_chunk_setting_stops_the_worker(value):
    with pytest.raises(ValueError, match="KEI_CATALOG_CHUNKS"):
        workflow.catalog_chunks({"KEI_CATALOG_CHUNKS": value})


# --- through DBOS ------------------------------------------------------------------------------------------------


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


def test_a_cancelled_chunked_catalog_stops_every_chunk_before_its_next_entry(kei, scripted, monkeypatch):
    """Chunk threads carry no DBOS context: the step's check must still read the workflow's status from each."""
    from dbos import DBOS

    from kei_exp.workflows import cancel
    monkeypatch.setattr(cancel, "MIN_INTERVAL", 0.0)
    monkeypatch.setattr(workflow, "CATALOG_CHUNKS", 2)  # headings: entries [1, 2], [3, 4, 5]
    arrived, released, asked = threading.Barrier(3, timeout=30), threading.Event(), []
    ended: list[BaseException | None] = []
    original = workflow.extract

    def extract(*args, **kwargs):  # records how the step's extraction ended, once every chunk thread has returned
        try:
            result = original(*args, **kwargs)
        except BaseException as error:
            ended.append(error)
            raise
        ended.append(None)
        return result
    monkeypatch.setattr(workflow, "extract", extract)

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

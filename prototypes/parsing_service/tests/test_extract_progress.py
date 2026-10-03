"""The stage files a running extraction publishes for Studio's partial view, and the reader that serves them."""
import json
import re

import pytest
import requests

from kei_exp import runs
from kei_exp.kie.extract import article, progress, run, unified
from kei_exp.kie.extract.contexts import Context
from kei_exp.kie.extract.llm import Reply
from kei_exp.kie.extract.models import Router, as_router
from kei_exp.kie.passages import Passage, load
from tests.helpers import kei as kei_helper
from tests.test_extract_grounded import CountingChat, WordCounter
from tests.test_extract_stages import SCHEMA, evidence, passages
from tests.test_unified_catalog import Model, candidate, section
from tests.test_unified_catalog import evidence as unified_evidence
from tests.test_unified_catalog import extract as unified_extract
from tests.test_unified_catalog import fields as unified_fields
from tests.test_unified_catalog import request as unified_request


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


def test_a_grounding_batch_whose_reply_failed_publishes_its_stage_with_no_links(tmp_path):
    source = passages(["31. Hill; 32. Brook.", "Results: Hill 1827."])
    directory = tmp_path / "extractions" / "x3"

    def fields(system, user, schema):
        if "title" in schema["properties"]:
            return {"title": "Sites"}
        return {"entry_no": "31", "site": "Hill", "year": 1827, "finds": ["spear", "axe"]}

    def reason(system, user, schema):  # quoted grounding asks four claims a batch: C1-C4, then C5
        if "C1" in schema["properties"]:  # the first batch's reply is no JSON: a failed call (`calls.complete`)
            return Reply(text="{not json", input_tokens=10, output_tokens=1, finish="stop", seconds=0.0)
        return {claim: {"label": "E1", "quote": "31.", "attribution": True} for claim in schema["properties"]}
    request = run.ExtractRequest(schema=SCHEMA, options={"strategy": "article", "article": {"grounding": "quoted"}})
    result = article.extract(tmp_path, evidence(source), request, Router(CountingChat(fields), CountingChat(reason)),
                             counter={role: WordCounter() for role in ("fields", "reasoning")}, extraction_id="x3")
    first, second = (json.loads((directory / progress.grounding_name(batch)).read_bytes()) for batch in (0, 1))
    assert first["links"] == [] and second["links"] == result["evidence"] and len(result["evidence"]) == 1
    assert not (directory / progress.grounding_name(2)).exists()
    assert any(issue["code"] == "call_failed" for issue in result["issues"])


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
    # Two values windows, each verifying its own material (as `test_disagreeing_values_are_arbitrated_or_left_unresolved`
    # sets it up): one window reads one candidate per field, so a contest needs two.
    source = unified_evidence("1. Adorf. Material: Holz. " + " ".join(["Text"] * 700) + " Material: Stein.")

    def last_material(record, user, schema):
        answer = unified_fields(record, user, schema)
        if material := re.findall(r"Material: (\w+)", record):
            answer["material"] = candidate(material[-1], f"Material: {material[-1]}")
        return answer
    unified_extract(source, Model(source, entry=last_material, choice="NONE"), run_dir=tmp_path, extraction_id="x1",
                    input_tokens=520, output_tokens=64)
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


def test_a_published_entry_outside_its_layout_is_not_finished_and_is_shown_from_its_other_stage_files(tmp_path):
    source = unified_evidence("1. Adorf. Material: Holz.")
    unified_extract(source, run_dir=tmp_path, extraction_id="x1")
    directory = tmp_path / "extractions" / "x1"
    execution = json.loads((directory / progress.PROGRESS_NAME).read_bytes())["execution"]
    progress.write_stage(directory / progress.candidates_name(0), {"version": 1, "execution": execution, "index": 0,
                         "discovery_sha256": "0" * 64, "ranges": [], "candidates": [], "record": {"label": "1"}, "failed": 0})
    published = directory / unified.entry_name(0)
    record = json.loads(published.read_bytes())
    for work in ({**record["work"], "record": []},                                    # a record that is no object
                 {**record["work"], "contest": {}},                                   # contests that are no list
                 {**record["work"], "contest": [{"path": ["records", 0, "material"], "outcome": "unresolved"}]}):  # a row without its values
        published.write_bytes(json.dumps({**record, "work": work}).encode())
        document = progress.read_progress(tmp_path, "x1")
        progress.ProgressDocument.model_validate(document)
        assert document["finished"] == 0 and document["entries"][0]["stage"] == "candidates"
        assert document["entries"][0]["record"] == {"label": "1"} and document["entries"][0]["evidence"] is None
    published.write_bytes(json.dumps(record).encode())
    assert progress.read_progress(tmp_path, "x1")["entries"][0]["stage"] == "finished"


def test_links_that_cannot_be_made_leave_a_finished_entry_finished_with_its_record_and_contests(tmp_path, monkeypatch):
    source = unified_evidence("1. Adorf. Material: Holz. " + " ".join(["Text"] * 700) + " Material: Stein.")

    def last_material(record, user, schema):
        answer = unified_fields(record, user, schema)
        if material := re.findall(r"Material: (\w+)", record):
            answer["material"] = candidate(material[-1], f"Material: {material[-1]}")
        return answer
    unified_extract(source, Model(source, entry=last_material, choice="NONE"), run_dir=tmp_path, extraction_id="x1",
                    input_tokens=520, output_tokens=64)
    monkeypatch.setattr(progress, "_passages", lambda run_dir: {})  # a result that loads, without the passage named

    def missing_passage(record, passages):
        raise KeyError("p1_s0")
    monkeypatch.setattr(unified, "entry_links", missing_passage)
    document = progress.read_progress(tmp_path, "x1")
    progress.ProgressDocument.model_validate(document)
    [entry] = document["entries"]
    assert document["finished"] == 1 and entry["stage"] == "finished" and entry["evidence"] == []
    assert entry["record"]["site"] == "Adorf" and entry["record"]["material"] is None
    assert entry["contested"] == [{"path": ["material"], "candidates": ["Holz", "Stein"]}]


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
    discovery.write_bytes(b'{"entries": [{"ranges": [{}]}, {"ranges": []}, {"ranges": {"segment": "p1_s0"}}, {"ranges": 1}]}')  # ranges that name no segment, or are no list
    assert [(entry["stage"], entry["page"]) for entry in progress.read_progress(tmp_path, "x1")["entries"]] == \
        [("finished", None), ("queued", None), ("queued", None), ("queued", None)]        # read, with no page to show
    discovery.write_bytes(kept)
    published = directory / unified.entry_name(0)
    record = json.loads(published.read_bytes())
    published.write_bytes(json.dumps({**record, "work": {**record["work"], "contest": [None]}}).encode())  # a contest row that is no row
    assert progress.read_progress(tmp_path, "x1")["entries"][0]["stage"] == "finished"   # the row is skipped, the entry stays finished
    assert progress.read_progress(tmp_path, "x1")["entries"][0]["contested"] == []
    published.write_bytes(json.dumps(record).encode())
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

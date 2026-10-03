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

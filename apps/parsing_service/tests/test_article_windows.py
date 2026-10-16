"""Publication order through real dispatch, partitioning and durable call checkpoints.

No wall-clock thresholds or model servers: every planning yield leaves a real finalized capture pending, and
scripted providers answer it through calls.complete before the next planning round. MemoryLease supplies the
existing coordination-contract harness; PostgreSQL fencing and process restart recovery are separate tiers.
"""
from copy import deepcopy
from dataclasses import asdict
from uuid import uuid4

import pytest

from kei_exp.kie.extract import calls, run
from kei_exp.kie.extract.durable import Boundary, CapturePlanner, NeedsCall, digest
from kei_exp.kie.extract.llm import Reply
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.retained import publish_final
from kei_exp.kie.passages import Evidence
from tests.test_durable_extraction import Counter, MemoryLease
from tests.test_extract_grounded import CountingChat, keeps_every_reading, resolving
from tests.test_extract_stages import passages


NODES = [{"id": "title-id", "name": "title", "type": "string"},
         {"id": "authors-id", "name": "authors", "type": "array", "itemType": "string"}]
DOCUMENT_NODES = [{"id": "keywords-id", "name": "keywords", "type": "array", "itemType": "string",
                   "valueSource": "document"}]


def source(*texts, bounded=False):
    # Real word-count admission makes each long passage a separate 8192-token value context; no partition mock.
    return Evidence(run_id="article-windows", generation="g1", digest="d1", source_name="article.pdf",
        page_count=len(texts), passages=tuple(p for page, text in enumerate(texts, 1)
            for p in passages([text + (" filler" * 3000 if bounded else "")], page=page)))


def article_request(*, context="bounded", start_page=None, document_fields=False):
    return run.ExtractRequest.model_validate({"schema": {"recordDescription": "The observed article.",
        "recordScope": "document", "schemaNodes": [*NODES, *(DOCUMENT_NODES if document_fields else [])]},
        "options": {"strategy": "article",
        "start_page": start_page, "article": {"context": context, "context_tokens": 8192, "grounding": "off"}}})


def fields(publication):
    return {value["fieldId"]: value for value in publication["values"]}


class TimelineLease(MemoryLease):
    def __init__(self, tree):
        super().__init__(tree)
        self.timeline = []

    def call(self, name, *args):
        fresh = name == "publish_snapshot" and args[0] not in self.publications
        saved = super().call(name, *args)
        if fresh:
            self.timeline.append({"event": "publication", "snapshot": deepcopy(saved),
                "record_checkpoints": [unit["id"] for unit in self.units.values()
                    if unit["descriptor"]["stage"] == "record" and unit["checkpoint"] is not None]})
        return saved


class CheckpointRun:
    """One real algorithm round at a time, executing only the capture the planner actually finalized."""
    def __init__(self, document, request, script):
        self.source, self.request = document, request
        self.chat = CountingChat(script)
        self.lease = TimelineLease(request.schema_.model_dump(by_alias=True, exclude_none=True))
        self.result = None

    def plan(self):
        counters = {role: Counter() for role in ("fields", "reasoning")}
        planner = CapturePlanner(self.lease, counters)
        before = len(self.chat.calls)
        try:
            result = run.dispatch(None, self.source, self.request, Router(self.chat, self.chat, planner),
                                  counter=counters)
        except NeedsCall:
            pending = [unit for unit in self.lease.units.values() if unit["id"] in planner.pending]
            assert len(pending) == 1
            unit = pending[0]
            assert unit["input"] is not None and unit["checkpoint"] is None
            self.lease.timeline.append({"event": "pending", "capture": unit["id"],
                                       "stage": unit["descriptor"]["stage"]})
            return unit
        except Boundary:
            self.lease.timeline.append({"event": "boundary"})
            raise
        else:
            self.lease.state["recordScopes"] = planner.scopes
            publish_final(self.lease, result)
            self.result = result
            return None
        finally:
            assert len(self.chat.calls) == before, "planning must only replay checkpoints, never call a model"

    def execute(self, unit):
        request = deepcopy(unit["input"]["request"]["body"])
        request.pop("max_whitespace")
        parsed, attempts = calls.complete(self.chat, **request, counter=Counter())
        output = {"parsed": parsed, "calls": [asdict(call) for call in attempts]}
        checkpoint = {"output": output, "outputDigest": digest(output)}
        ok = all(call.ok or call.recovered for call in attempts)
        if ok:
            unit["checkpoint"] = checkpoint
        else:
            # Match the existing harness's attempt-local failure semantics: Retry may run it again,
            # while a successful capture remains reusable across attempts of the same generation.
            unit["failures"][self.lease.attempt] = checkpoint
        self.lease.timeline.append({"event": "completed", "capture": unit["id"],
                                    "stage": unit["descriptor"]["stage"], "ok": ok})
        return attempts

    def finish(self):
        for _ in range(30):
            pending = self.plan()
            if pending is None:
                return self.result
            self.execute(pending)
        raise AssertionError("method did not finish in 30 call checkpoints")

    def latest_values(self, *, complete=None):
        return next(publication for publication in reversed(self.lease.publications.values())
            if publication["values"] and (complete is None or
                publication["coverage"].get("processingComplete") is complete))


def article_reply(system, user, schema):
    if resolving(user):
        return keeps_every_reading(schema)
    if "First part" in user:
        return {"title": "The article", "authors": ["Ada"]}
    return {"title": None, "authors": ["Ben"]}


def test_catalog_publishes_a_record_while_the_last_record_capture_is_pending():
    request = run.ExtractRequest.model_validate({"schema": {"recordDescription": "One numbered entry.",
        "recordScope": "records", "schemaNodes": [{"id": "site-id", "name": "site", "type": "string"}]},
        "options": {"strategy": "catalog"}})

    def reply(system, user, schema):
        if "record boundaries" in system:
            return {"starts": ["B1", "B2"], "end": None}
        if "site" in schema["properties"]:
            return {"site": "Hill" if "Hill" in user else "Valley"}
        return {key: "NONE" for key in schema["properties"]}

    execution = CheckpointRun(source("1. Hill.", "2. Valley."), request, reply)
    discovery = execution.plan()
    assert discovery["descriptor"]["stage"] == "discovery" and not execution.lease.publications
    execution.execute(discovery)
    first = execution.plan()
    assert first["descriptor"]["stage"] == "record" and first["input"]["request"]["body"]["record"] == 0
    assert not execution.lease.publications
    execution.execute(first)
    last = execution.plan()
    assert last["descriptor"]["stage"] == "record" and last["input"]["request"]["body"]["record"] == 1
    assert last["checkpoint"] is None
    partial = execution.latest_values(complete=False)
    assert fields(partial)["site-id"]["modelValue"] == "Hill"
    assert partial["coverage"]["primaryScope"] == [{"segment": "p1_s0", "start": 0, "end": 8}]
    assert [event["event"] for event in execution.lease.timeline][-2:] == ["publication", "pending"]
    execution.execute(last)
    assert execution.finish()["records"] == [{"site": "Hill"}, {"site": "Valley"}]
    initial = fields(partial)["site-id"]
    final = next(value for publication in execution.lease.publications.values()
        if publication["coverage"].get("processingComplete") for value in publication["values"]
        if value["recordId"] == initial["recordId"])
    assert final["id"] == initial["id"] and final["modelValue"] == "Hill"


def test_full_article_cannot_publish_its_root_until_its_one_record_call_answers():
    execution = CheckpointRun(source("First part. Title The article; author Ada.", "Second part."),
                              article_request(context="full"), article_reply)
    root = execution.plan()
    assert root["descriptor"]["stage"] == "record" and not execution.lease.publications
    user = root["input"]["request"]["body"]["user"]
    assert "First part" in user and "Second part" in user
    execution.execute(root)
    assert not execution.lease.publications  # a call checkpoint alone is not a result publication
    assert execution.plan() is None
    assert execution.result["records"] == [{"title": "The article", "authors": ["Ada"]}]
    assert len(execution.chat.calls) == len(execution.lease.units) == 1
    assert all(event["record_checkpoints"] == [root["id"]] for event in execution.lease.timeline
               if event["event"] == "publication")


def test_bounded_article_publishes_one_partial_document_before_the_final_value_call_answers():
    execution = CheckpointRun(source("First part. Title The article; author Ada.", "Second part. Author Ben.",
                                    bounded=True), article_request(), article_reply)
    first = execution.plan()
    assert first["descriptor"]["stage"] == "record" and not execution.lease.publications
    assert "First part" in first["input"]["request"]["body"]["user"]
    assert "Second part" not in first["input"]["request"]["body"]["user"]
    execution.execute(first)
    last = execution.plan()
    assert last["descriptor"]["stage"] == "record" and last["checkpoint"] is None
    assert "Second part" in last["input"]["request"]["body"]["user"]
    partial = execution.latest_values(complete=False)
    saved = fields(partial)
    assert partial["coverage"]["primaryScope"] == "document"
    assert {value["recordId"] for value in saved.values()} == {saved["title-id"]["recordId"]}
    assert {key: value["modelValue"] for key, value in saved.items()} == {
        "title-id": "The article", "authors-id": ["Ada"]}
    assert all(value["processing"] == "saved" and value["grounding"] == "provisional" for value in saved.values())
    assert not any(event["event"] == "completed" and event["capture"] == last["id"]
                   for event in execution.lease.timeline)
    assert [event["event"] for event in execution.lease.timeline][-2:] == ["publication", "pending"]
    execution.execute(last)
    result = execution.finish()
    assert result["value_contexts"] == [[{"primary": ["p1_s0"], "overlap": []},
                                          {"primary": ["p2_s0"], "overlap": []}]]
    assert result["records"] == [{"title": "The article", "authors": ["Ada", "Ben"]}]
    final = fields(execution.latest_values(complete=True))
    assert {key: value["id"] for key, value in final.items()} == {key: value["id"] for key, value in saved.items()}
    assert final["authors-id"]["modelValue"] == ["Ada", "Ben"]
    assert [call["stage"] for call in result["calls"]][:2] == ["record", "record"]


def test_pause_and_resume_reuses_the_first_context_without_erasing_values_or_duplicating_arrays():
    execution = CheckpointRun(source("First part. Title The article; author Ada.", "Second part. Author Ben.",
                                    bounded=True), article_request(), article_reply)
    first = execution.plan()
    execution.execute(first)
    last = execution.plan()
    saved = deepcopy(execution.lease.publications)
    completed = deepcopy(first)
    plans = deepcopy(execution.lease.plans)
    execution.lease.intent = "PAUSE"
    with pytest.raises(Boundary):
        execution.plan()
    assert execution.lease.publications == saved and first == completed
    assert len(execution.chat.calls) == 1
    execution.lease.attempt = str(uuid4())
    execution.lease.intent = "RUN"
    resumed = execution.plan()
    assert resumed["id"] == last["id"] and first == completed
    assert execution.lease.publications == saved and execution.lease.plans == plans
    execution.execute(resumed)
    assert execution.finish()["records"] == [{"title": "The article", "authors": ["Ada", "Ben"]}]
    count = len(execution.chat.calls)
    final = deepcopy(execution.latest_values(complete=True)["values"])
    execution.lease.attempt = str(uuid4())
    assert execution.finish()["records"] == execution.result["records"]
    assert len(execution.chat.calls) == count and first == completed
    assert execution.latest_values(complete=True)["values"] == final
    assert fields(execution.latest_values(complete=True))["authors-id"]["modelValue"] == ["Ada", "Ben"]


def test_failed_context_and_retry_preserve_the_saved_root_and_successful_checkpoints():
    fail = True

    def reply(system, user, schema):
        if not resolving(user) and "Second part" in user and fail:
            return Reply("not JSON", 10, 2, "stop", 0.0)
        return article_reply(system, user, schema)

    execution = CheckpointRun(source("First part. Title The article; author Ada.", "Second part. Author Ben.",
                                    bounded=True), article_request(), reply)
    first = execution.plan()
    execution.execute(first)
    last = execution.plan()
    partial = deepcopy(fields(execution.latest_values(complete=False)))
    first_saved = deepcopy(first)
    input_saved = deepcopy(last["input"])
    attempts = execution.execute(last)
    assert not attempts[-1].ok and last["checkpoint"] is None
    failed_attempt = execution.lease.attempt
    result = execution.finish()
    assert result["records"] == [{"title": "The article", "authors": ["Ada"]}]
    assert any(issue["code"] == "call_failed" for issue in result["issues"])
    assert result["completion"]["source_coverage"] == "partial"
    after_failure = fields(execution.latest_values(complete=True))
    assert {key: (value["id"], value["modelValue"]) for key, value in after_failure.items()} == {
        key: (value["id"], value["modelValue"]) for key, value in partial.items()}
    assert list(execution.lease.publications.values())[-1]["coverage"]["finalizedAttempt"]["complete"] is False

    fail = False
    execution.lease.attempt = str(uuid4())
    resumed = execution.plan()
    assert resumed["id"] == last["id"] and resumed["input"] == input_saved
    assert first == first_saved and failed_attempt in last["failures"]
    execution.execute(resumed)
    assert execution.finish()["records"] == [{"title": "The article", "authors": ["Ada", "Ben"]}]
    assert first == first_saved
    final = fields(execution.latest_values(complete=True))
    assert {key: value["id"] for key, value in final.items()} == {key: value["id"] for key, value in partial.items()}
    assert final["authors-id"]["modelValue"] == ["Ada", "Ben"]
    assert sum("First part" in call["user"] and not resolving(call["user"]) for call in execution.chat.calls) == 1
    assert list(execution.lease.publications.values())[-1]["coverage"]["finalizedAttempt"]["complete"] is True


def test_starting_at_the_last_page_keeps_intermediate_disagreement_segments_in_source_order():
    def reply(system, user, schema):
        if resolving(user):
            return {key: ({label: {"of": "", "label": "OWN"} for label in spec["properties"]}
                          if "properties" in spec else "UNSURE")
                    for key, spec in schema["properties"].items()}
        title = "First title" if "Part one" in user else "Second title" if "Part two" in user else "Third title"
        return {"title": title, "authors": [title.split()[0]]}

    execution = CheckpointRun(source("Part one. First title.", "Part two. Second title.", "Part three. Third title.",
                                    bounded=True), article_request(start_page=3), reply)
    third = execution.plan()
    assert "Part three" in third["input"]["request"]["body"]["user"]
    execution.execute(third)
    second = execution.plan()
    assert "Part two" in second["input"]["request"]["body"]["user"]
    execution.execute(second)
    first = execution.plan()
    assert "Part one" in first["input"]["request"]["body"]["user"] and first["checkpoint"] is None
    intermediate = fields(execution.latest_values(complete=False))
    assert intermediate["title-id"]["modelValue"] is None
    assert intermediate["title-id"]["processing"] == "saved"
    assert intermediate["title-id"]["disagreement"] == [{"path": [], "alternatives": [
        {"value": "Second title", "segments": ["p2_s0"]}, {"value": "Third title", "segments": ["p3_s0"]}]}]
    assert intermediate["authors-id"]["modelValue"] == ["Second", "Third"]
    execution.execute(first)
    result = execution.finish()
    assert result["records"] == [{"title": None, "authors": ["First", "Second", "Third"]}]
    final = fields(execution.latest_values(complete=True))
    assert final["title-id"]["id"] == intermediate["title-id"]["id"]
    assert final["title-id"]["disagreement"] == [{"path": [], "alternatives": [
        {"value": "First title", "segments": ["p1_s0"]}, {"value": "Second title", "segments": ["p2_s0"]},
        {"value": "Third title", "segments": ["p3_s0"]}]}]


def document_source():
    return source("First part. Author Ada; keyword Ada.", "Second part. Author Ben; keyword Ben.",
                  "Third part. Author Cy; keyword Cy.", bounded=True)


def document_reply(system, user, schema):
    if resolving(user):
        return keeps_every_reading(schema)
    name = "Ada" if "First part" in user else "Ben" if "Second part" in user else "Cy"
    return {"keywords": [name]} if "keywords" in schema["properties"] else {
        "title": "The article", "authors": [name]}


def next_document_capture(execution):
    # Tolerate root-first or interleaved planning: only actual stage descriptors choose the document windows.
    for _ in range(30):
        pending = execution.plan()
        assert pending is not None, "expected another document-field window"
        if pending["descriptor"]["stage"] == "document":
            return pending
        execution.execute(pending)
    raise AssertionError("no document-field capture within 30 checkpoints")


def document_publications(execution):
    return [publication for publication in execution.lease.publications.values()
            if publication["coverage"].get("primaryScope") == "document-fields"]


def test_document_field_prefix_remains_provisional_until_all_three_windows_answer():
    execution = CheckpointRun(document_source(), article_request(document_fields=True), document_reply)
    first = next_document_capture(execution)
    assert "First part" in first["input"]["request"]["body"]["user"]
    execution.execute(first)
    second = next_document_capture(execution)
    assert "Second part" in second["input"]["request"]["body"]["user"] and second["checkpoint"] is None
    prefix = document_publications(execution)[-1]
    assert fields(prefix)["keywords-id"]["modelValue"] == ["Ada"]
    assert prefix["coverage"]["processingComplete"] is False
    assert prefix["coverage"]["completedDocumentFields"] == {}
    assert fields(prefix)["keywords-id"]["grounding"] == "provisional"
    execution.execute(second)
    third = next_document_capture(execution)
    assert "Third part" in third["input"]["request"]["body"]["user"] and third["checkpoint"] is None
    prefix = document_publications(execution)[-1]
    assert fields(prefix)["keywords-id"]["modelValue"] == ["Ada", "Ben"]
    assert prefix["coverage"]["processingComplete"] is False
    assert prefix["coverage"]["completedDocumentFields"] == {}


def test_adopting_a_document_prefix_does_not_omit_the_unread_windows():
    from kei_exp.kie.extract.retained import document_inputs

    execution = CheckpointRun(document_source(), article_request(document_fields=True), document_reply)
    first = next_document_capture(execution)
    execution.execute(first)
    next_document_capture(execution)
    prefix = deepcopy(document_publications(execution)[-1])
    # A later generation sees this immutable partial snapshot, not this attempt's mutable call checkpoint map.
    execution.lease.historical = {"manifest": {"coverage": {}}, "snapshot": {"id": "partial-document", **prefix}}
    counters = {role: Counter() for role in ("fields", "reasoning")}
    planner = CapturePlanner(execution.lease, counters)
    remaining, carried = document_inputs(Router(execution.chat, execution.chat, planner), execution.request.schema_)
    assert [node.id for node in remaining.document_nodes] == ["keywords-id"]
    assert carried == {}


def test_all_three_successful_document_windows_publish_a_completed_document_field():
    execution = CheckpointRun(document_source(), article_request(document_fields=True), document_reply)
    result = execution.finish()
    document_calls = [unit for unit in execution.lease.units.values() if unit["descriptor"]["stage"] == "document"]
    assert len(document_calls) == 3 and all(unit["checkpoint"] is not None for unit in document_calls)
    assert [[part for part in ("First part", "Second part", "Third part")
             if part in unit["input"]["request"]["body"]["user"]] for unit in document_calls] == [
                 ["First part"], ["Second part"], ["Third part"]]
    assert result["records"] == [{"title": "The article", "authors": ["Ada", "Ben", "Cy"],
                                  "keywords": ["Ada", "Ben", "Cy"]}]
    final = document_publications(execution)[-1]
    value = fields(final)["keywords-id"]
    assert value["modelValue"] == ["Ada", "Ben", "Cy"]
    assert final["coverage"]["processingComplete"] is True
    assert final["coverage"]["completedDocumentFields"] == {value["id"]: True}
    assert len({fields(saved)["keywords-id"]["id"] for saved in document_publications(execution)}) == 1


def test_failed_last_document_window_never_certifies_the_saved_prefix_as_complete():
    def reply(system, user, schema):
        if "keywords" in schema["properties"] and "Third part" in user:
            return Reply("not JSON", 10, 2, "stop", 0.0)
        return document_reply(system, user, schema)

    execution = CheckpointRun(document_source(), article_request(document_fields=True), reply)
    result = execution.finish()
    document_calls = [unit for unit in execution.lease.units.values() if unit["descriptor"]["stage"] == "document"]
    assert len(document_calls) == 3
    assert document_calls[-1]["checkpoint"] is None and execution.lease.attempt in document_calls[-1]["failures"]
    assert result["records"][0]["keywords"] == ["Ada", "Ben"]
    final = document_publications(execution)[-1]
    assert fields(final)["keywords-id"]["modelValue"] == ["Ada", "Ben"]
    assert final["coverage"]["processingComplete"] is False
    assert final["coverage"]["completedDocumentFields"] == {}
    assert list(execution.lease.publications.values())[-1]["coverage"]["finalizedAttempt"]["complete"] is False


def test_article_root_is_published_before_all_auxiliary_document_windows_finish():
    execution = CheckpointRun(document_source(), article_request(document_fields=True), document_reply)
    execution.finish()
    timeline = execution.lease.timeline
    document_completions = [index for index, event in enumerate(timeline)
                            if event["event"] == "completed" and event["stage"] == "document"]
    assert len(document_completions) == 3
    root_publication = next(index for index, event in enumerate(timeline)
        if event["event"] == "publication" and event["snapshot"]["coverage"].get("primaryScope") == "document"
        and event["snapshot"]["coverage"]["processingComplete"] is False
        and fields(event["snapshot"])["title-id"]["modelValue"] == "The article")
    assert root_publication < document_completions[-1]

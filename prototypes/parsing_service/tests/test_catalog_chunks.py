"""A Catalog's entries in contiguous chunks at once: the same artifact as unsplit apart from timing and the chunk
count (spec, *kei worker → Parallel Catalog chunks*). The model is scripted, so the equality is exact."""
import threading

import pytest
import requests

from kei_exp.kie.extract import grounded
from kei_exp.kie.extract.llm import Reply
from kei_exp.kie.extract.run import ExtractRequest, extract
from tests.helpers import catalogue
from tests.test_extract_grounded import SCHEMA, CountingChat, WordCounter, entry_text, honest

DOCUMENT_SCHEMA = {**SCHEMA, "schemaNodes": [*SCHEMA["schemaNodes"], {
    "id": "c", "name": "catalogue_title", "type": "string", "valueSource": "document"}]}


def request(schema=SCHEMA):
    return ExtractRequest.model_validate({"schema": schema, "options": {
        "strategy": "catalog", "catalog": {"recipe": "numbered-catalogue-de@1"}}})


def run(case, tmp_path, *, chunks, script=honest, counter=None, schema=SCHEMA, before_entry=None):
    run_dir = catalogue.write(case, tmp_path / f"chunks-{chunks}" / case)  # the run ID is the directory's name
    chat = CountingChat(script)
    return extract(run_dir, request(schema), chat, counter=counter or WordCounter(), chunks=chunks,
                   before_entry=before_entry), chat


def comparable(result: dict) -> dict:
    body = {key: value for key, value in result.items() if key not in ("started", "seconds", "chunks")}
    body["calls"] = [{**call, "seconds": None} for call in result["calls"]]
    return body


@pytest.mark.parametrize("case", ["headings", "numbering", "glossary", "continuations", "two-in-one-segment"])
@pytest.mark.parametrize("chunks", [2, 3, 4])
def test_chunked_and_unsplit_runs_give_the_same_artifact(case, chunks, tmp_path):
    unsplit, _ = run(case, tmp_path, chunks=1)
    split, _ = run(case, tmp_path, chunks=chunks)
    assert comparable(split) == comparable(unsplit)
    entries = len(unsplit["record_blocks"])
    assert unsplit["chunks"] == min(1, entries) and split["chunks"] == min(chunks, entries)
    assert split["fingerprint"] == unsplit["fingerprint"]  # the chunk count is not part of it


def test_the_chunks_run_at_once(tmp_path):
    arrived = threading.Barrier(3, timeout=10)  # passed only when three calls are in flight together

    def script(system, user, schema):
        if entry_text(user)[:2] in ("1.", "2.", "4."):  # the first entry of each chunk: [1], [2, 3], [4, 5]
            arrived.wait()
        return honest(system, user, schema)
    result, _ = run("headings", tmp_path, chunks=3, script=script)
    assert result["chunks"] == 3 and result["complete"] is True and len(result["records"]) == 5


def test_document_fields_are_extracted_once_and_every_record_merges_them(tmp_path):
    def script(system, user, schema):
        if "catalogue_title" in (schema or {}).get("properties", {}):
            return {"catalogue_title": "Fundchronik"}
        return honest(system, user, schema)
    result, chat = run("headings", tmp_path, chunks=3, script=script, schema=DOCUMENT_SCHEMA)
    assert [call["stage"] for call in result["calls"]].count("document") == 1
    assert sum("catalogue_title" in (call["schema"] or {}).get("properties", {}) for call in chat.calls) == 1
    assert {record["catalogue_title"] for record in result["records"]} == {"Fundchronik"}


def test_a_record_keeps_its_document_wide_number_in_issues_and_calls(tmp_path):
    def script(system, user, schema):
        if entry_text(user).startswith("5."):
            return Reply(text="not json", input_tokens=10, output_tokens=5, finish="stop", seconds=0.0)
        return honest(system, user, schema)
    result, _ = run("headings", tmp_path, chunks=4, script=script)
    assert [issue["record"] for issue in result["issues"] if issue["code"] == "call_failed"] == [4]
    assert [call["record"] for call in result["calls"] if call["stage"] == "entry"] == [0, 1, 2, 3, 4]


def test_a_refusal_in_one_chunk_refuses_the_run(tmp_path):
    class Refusing(WordCounter):  # only entry 4 (Ddorf) has a D, so none of its windows, down to one code point, fits
        def request_tokens(self, system, user, schema=None):
            if "### ENTRY" in user and "D" in entry_text(user):
                return 10**6
            return super().request_tokens(system, user, schema)
    result, _ = run("headings", tmp_path, chunks=3, counter=Refusing())
    assert result["completeness"]["processing"] is False and result["complete"] is False
    assert [issue["record"] for issue in result["issues"] if issue["code"] == "window_refused"] == [3]


def test_a_failed_chunk_fails_the_extraction(tmp_path):
    def script(system, user, schema):
        if entry_text(user).startswith("5."):
            raise requests.ConnectionError("the fields server went away")
        return honest(system, user, schema)
    with pytest.raises(requests.ConnectionError):
        run("headings", tmp_path, chunks=3, script=script)


def test_before_entry_runs_before_every_entry_and_its_error_ends_the_extraction(tmp_path):
    seen = []

    def before_entry():
        seen.append(1)
        if len(seen) == 3:
            raise RuntimeError("cancelled")
    with pytest.raises(RuntimeError, match="cancelled"):
        run("headings", tmp_path, chunks=1, before_entry=before_entry)
    assert len(seen) == 3


@pytest.mark.parametrize("count, chunks", [(5, 4), (5, 2), (2, 4), (1, 3), (0, 4), (8, 4)])
def test_pieces_are_contiguous_balanced_and_never_empty(count, chunks):
    entries = list(range(count))
    pieces = grounded._pieces(entries, chunks)
    assert [entry for piece in pieces for entry in piece] == entries
    assert len(pieces) == min(chunks, count) and all(pieces)
    assert not pieces or max(map(len, pieces)) - min(map(len, pieces)) <= 1


def test_chunks_must_be_positive(tmp_path):
    with pytest.raises(ValueError):
        run("headings", tmp_path, chunks=0)

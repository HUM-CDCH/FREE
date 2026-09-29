"""Extraction model-call spans for Phoenix: what one call records, what only capture adds, and that a Catalog's chunk
threads stay on the extraction's trace."""
import json
from types import SimpleNamespace

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode

from kei_exp.kie.extract import calls, grounded
from kei_exp.kie.extract.llm import Reply
from tests.helpers.chat import FakeChat

FALLBACK = Reply(text='{"title": "Ur"}', input_tokens=12, output_tokens=4, finish="stop", seconds=0.1,
                 attempts=("HTTP 400: response_format is not supported",))


@pytest.fixture
def spans(monkeypatch):
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(calls, "_TRACER", provider.get_tracer("test"))
    return exporter


def call(chat):
    return calls.complete(chat, stage="record", record=3, system="SYSTEM PROMPT", user="SOURCE TEXT",
                          schema={"type": "object"})


def test_a_call_records_its_model_tokens_and_refused_attempt_and_no_content_by_default(spans):
    call(FakeChat(lambda *_: FALLBACK))
    [span] = spans.get_finished_spans()
    assert span.name == "record"
    assert dict(span.attributes) == {"openinference.span.kind": "LLM", "llm.model_name": "fake/extractor",
                                     "llm.token_count.prompt": 12, "llm.token_count.completion": 4,
                                     "free.record": 3}
    assert [(event.name, event.attributes["error"]) for event in span.events] == [
        ("refused attempt", "HTTP 400: response_format is not supported")]
    assert span.status.status_code is StatusCode.UNSET


def test_capture_adds_the_prompt_the_raw_reply_and_the_parsed_answer(spans, monkeypatch):
    monkeypatch.setattr(calls, "CAPTURE", {"prompts", "responses", "parsed"})
    call(FakeChat(lambda *_: FALLBACK))
    [span] = spans.get_finished_spans()
    assert json.loads(span.attributes["input.value"]) == {"system": "SYSTEM PROMPT", "user": "SOURCE TEXT"}
    assert span.attributes["llm.output_messages.0.message.content"] == '{"title": "Ur"}'
    assert json.loads(span.attributes["output.value"]) == {"title": "Ur"}


def test_a_failed_call_is_an_error_span(spans):
    call(FakeChat(lambda *_: Reply(text="not json", input_tokens=1, output_tokens=1, finish="stop", seconds=0.0)))
    [span] = spans.get_finished_spans()
    assert span.status.status_code is StatusCode.ERROR
    assert "did not return JSON" in span.status.description


def test_catalog_chunk_threads_stay_on_the_step_s_trace(spans):
    prelude = SimpleNamespace(evidence=None, schema=None, recipe=None, options=None, chat=None, counters={})
    with calls._TRACER.start_as_current_span("extract_run") as step:
        pieces = grounded._in_chunks(prelude, [[(1, None)], [(2, None)]], None,
                                     lambda *_: trace.get_current_span().get_span_context().trace_id)
    assert [found for _, found in pieces] == [[step.get_span_context().trace_id]] * 2

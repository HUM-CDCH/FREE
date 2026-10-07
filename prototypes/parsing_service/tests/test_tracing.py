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
    monkeypatch.setattr(calls, "CAPTURE", set())
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
    assert [(event.name, dict(event.attributes)) for event in span.events] == [
        ("refused attempt", {"attempt": 1})]
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
    assert span.status.description is None


def recorded(span):
    return json.dumps({"attributes": dict(span.attributes), "status": span.status.description,
                       "events": [dict(event.attributes) for event in span.events]})


@pytest.mark.parametrize("capture", [set(), {"prompts", "responses", "parsed"}])
def test_malformed_reply_content_requires_response_capture(spans, monkeypatch, capture):
    monkeypatch.setattr(calls, "CAPTURE", capture)
    private = "PRIVATE MODEL RESPONSE"
    call(FakeChat(lambda *_: Reply(private, 1, 1, "stop", 0.0)))
    [span] = spans.get_finished_spans()
    assert span.status.status_code is StatusCode.ERROR
    assert span.status.description is None
    assert (private in recorded(span)) == ("responses" in capture)


@pytest.mark.parametrize("capture", [set(), {"prompts", "responses", "parsed"}])
def test_refusal_events_never_record_provider_response_bodies(spans, monkeypatch, capture):
    monkeypatch.setattr(calls, "CAPTURE", capture)
    private = "HTTP 400: response_format unsupported PRIVATE PROVIDER RESPONSE"
    _, attempts = call(FakeChat(lambda *_: Reply("{}", 1, 1, "stop", 0.0, (private,))))
    [span] = spans.get_finished_spans()
    assert private not in recorded(span)
    assert [(event.name, dict(event.attributes)) for event in span.events] == [("refused attempt", {"attempt": 1})]
    assert attempts[0].error == private  # Tracing does not rewrite the extraction's existing artifact diagnostics.


def test_raised_errors_keep_the_failure_without_exporting_their_content(spans):
    def fail(*_):
        raise RuntimeError("PRIVATE PROVIDER RESPONSE")

    with pytest.raises(RuntimeError, match="PRIVATE PROVIDER RESPONSE"):
        call(FakeChat(fail))
    [span] = spans.get_finished_spans()
    assert span.status.status_code is StatusCode.ERROR
    assert "PRIVATE PROVIDER RESPONSE" not in recorded(span)
    assert [(event.name, dict(event.attributes)) for event in span.events] == [
        ("exception", {"exception.type": "RuntimeError"})]


def test_catalog_chunk_threads_stay_on_the_step_s_trace(spans):
    prelude = SimpleNamespace(evidence=None, schema=None, recipe=None, options=None, chat=None, counters={})
    with calls._TRACER.start_as_current_span("planExtractionCallsV1") as step:
        pieces = grounded._in_chunks(prelude, [[(1, None)], [(2, None)]], None,
                                     lambda *_: trace.get_current_span().get_span_context().trace_id)
    assert [found for _, found in pieces] == [[step.get_span_context().trace_id]] * 2


def test_a_recovered_record_is_two_spans_the_looped_one_an_error(spans, monkeypatch):
    from tests.test_extract_stages import READ, recovering
    recovering(monkeypatch, READ)
    records = [span for span in spans.get_finished_spans() if span.name == "record"]
    assert [span.status.status_code for span in records] == [StatusCode.ERROR, StatusCode.UNSET]

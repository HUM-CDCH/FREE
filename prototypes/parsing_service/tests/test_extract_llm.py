"""The chat call: what is sent, what comes back, and the fallback for a server without structured output."""
import json
from types import SimpleNamespace

import pytest
import requests

from kei_exp.kie.extract import llm
from kei_exp.kie.extract.acceptance import candidate_schema
from kei_exp.kie.extract.llm import (
    ModelOutputError,
    NuExtractChat,
    OpenAIChat,
    TemplateError,
    nuextract_template,
    parse_json,
)
from kei_exp.kie.extract.schema import Node, json_schema


def response(status: int, body: dict | None = None, text: str = ""):
    def raise_for_status():
        if status >= 400:
            raise requests.HTTPError(f"{status}")
    return SimpleNamespace(status_code=status, json=lambda: body, text=text, raise_for_status=raise_for_status)


def test_a_call_sends_the_messages_and_the_json_schema_and_reads_the_reply(monkeypatch):
    sent = []
    body = {"choices": [{"message": {"content": '{"a": 1}'}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 12, "completion_tokens": 3}}
    monkeypatch.setattr(llm.requests, "post", lambda url, **kwargs: sent.append((url, kwargs)) or response(200, body))
    chat = OpenAIChat(url="http://server/v1/chat/completions", model="m", timeout=5.0)
    reply = chat.complete(system="S", user="U", schema={"type": "object"})
    assert reply.text == '{"a": 1}' and reply.input_tokens == 12 and reply.output_tokens == 3
    assert reply.finish == "stop" and reply.seconds >= 0
    url, kwargs = sent[0]
    assert url == "http://server/v1/chat/completions" and kwargs["timeout"] == 5.0
    payload = kwargs["json"]
    assert payload["model"] == "m" and payload["temperature"] == 0
    # Greedy decoding can loop a thinking model's reasoning until max_tokens and leave no answer; extraction turns
    # thinking off through the chat template, the switch vLLM applies (Ollama's `reasoning_effort` is not one).
    assert payload["chat_template_kwargs"] == {"enable_thinking": False} and "reasoning_effort" not in payload
    assert payload["messages"] == [{"role": "system", "content": "S"}, {"role": "user", "content": "U"}]
    assert payload["response_format"] == {"type": "json_schema", "json_schema": {
        "name": "reply", "schema": {"type": "object"}, "strict": True}}


def test_a_server_that_says_it_lacks_structured_output_is_asked_again_and_both_attempts_are_kept(monkeypatch):
    sent = []
    body = {"choices": [{"message": {"content": "{}"}, "finish_reason": "stop"}]}

    def post(url, **kwargs):
        sent.append(kwargs["json"])
        if "response_format" in kwargs["json"]:
            return response(400, text='{"error": "response_format json_schema is not supported by this server"}')
        return response(200, body)
    monkeypatch.setattr(llm.requests, "post", post)
    reply = OpenAIChat(url="http://server", model="m").complete(system="S", user="U", schema={"type": "object"})
    assert reply.text == "{}" and reply.input_tokens is None
    assert "response_format" in sent[0] and "response_format" not in sent[1]
    assert sent[1]["chat_template_kwargs"] == {"enable_thinking": False}
    assert len(reply.attempts) == 1 and "not supported" in reply.attempts[0]


@pytest.mark.parametrize("text", ['{"error": "invalid JSON schema in response_format: unknown type"}',
                                  '{"error": "the input length exceeds the context length"}', ""])
def test_any_other_refusal_surfaces_unchanged_without_a_second_attempt(monkeypatch, text):
    sent = []
    monkeypatch.setattr(llm.requests, "post", lambda url, **kwargs: sent.append(kwargs) or response(400, text=text))
    with pytest.raises(requests.HTTPError):
        OpenAIChat(url="http://server", model="m").complete(system="S", user="U", schema={"type": "object"})
    assert len(sent) == 1


def test_a_call_may_set_its_own_output_allowance(monkeypatch):
    sent = []
    body = {"choices": [{"message": {"content": "{}"}, "finish_reason": "stop"}]}
    monkeypatch.setattr(llm.requests, "post", lambda url, **kwargs: sent.append(kwargs["json"]) or response(200, body))
    OpenAIChat(url="http://server", model="m").complete(system="S", user="U", schema=None, max_tokens=1024)
    OpenAIChat(url="http://server", model="m").complete(system="S", user="U", schema=None)
    assert [payload["max_tokens"] for payload in sent] == [1024, 8192]


def test_the_request_to_count_renders_the_same_template_as_the_request_sent(monkeypatch):
    """The token budget counts on vLLM's /tokenize; any template switch the call sends changes the rendered prompt,
    so the body to count carries the same messages and switches."""
    sent = []
    body = {"choices": [{"message": {"content": "{}"}, "finish_reason": "stop"}]}
    monkeypatch.setattr(llm.requests, "post", lambda url, **kwargs: sent.append(kwargs["json"]) or response(200, body))
    chat = OpenAIChat(url="http://server/v1/chat/completions", model="m")
    chat.complete(system="S", user="U", schema={"type": "object"})
    counted = chat.tokenize_body(system="S", user="U", schema={"type": "object"})
    assert counted == {"model": "m", "add_generation_prompt": True, "messages": sent[0]["messages"],
                       "chat_template_kwargs": sent[0]["chat_template_kwargs"]}


def test_a_failing_server_raises_the_http_error(monkeypatch):
    monkeypatch.setattr(llm.requests, "post", lambda url, **kwargs: response(500))
    with pytest.raises(requests.HTTPError):
        OpenAIChat(url="http://server", model="m").complete(system="S", user="U", schema=None)


@pytest.mark.parametrize("text", ['{"a": 1}', '<think>hmm</think>\n{"a": 1}', '```json\n{"a": 1}\n```'])
def test_parse_json_strips_thinking_and_fences(text):
    assert parse_json(text) == {"a": 1}


def test_parse_json_names_the_reply_it_could_not_read():
    with pytest.raises(ModelOutputError, match="did not return JSON"):
        parse_json("Sure! Here is the data")


def test_the_settings_come_from_the_environment():
    assert llm.EXTRACT_URL.endswith("/v1/chat/completions") and isinstance(llm.EXTRACT_TIMEOUT, float)
    assert json.dumps(llm.EXTRACT_MODEL)  # a string


def fields(*nodes: dict) -> dict:
    return json_schema([Node.model_validate(node) for node in nodes])


def annotated(value) -> bool:
    if isinstance(value, dict):
        return any(key.startswith("x-") or annotated(item) for key, item in value.items())
    return isinstance(value, list) and any(annotated(item) for item in value)


def test_the_instruction_model_is_sent_the_schema_without_the_field_type_annotations(monkeypatch):
    sent = []
    body = {"choices": [{"message": {"content": "{}"}, "finish_reason": "stop"}]}
    monkeypatch.setattr(llm.requests, "post", lambda url, **kwargs: sent.append(kwargs["json"]) or response(200, body))
    schema = fields({"id": "n", "name": "entry_no", "type": "integer"},
                    {"id": "f", "name": "finds", "type": "array", "children": [
                        {"id": "c", "name": "count", "type": "integer"}]})
    assert annotated(schema)
    OpenAIChat(url="http://server", model="m").complete(system="S", user="U", schema=schema)
    assert not annotated(sent[0]["response_format"]["json_schema"]["schema"])
    assert sent[0]["response_format"]["json_schema"]["schema"]["properties"]["entry_no"] == {"type": ["integer", "null"]}


def keywords(value) -> list[str]:
    """Every schema keyword in `value`, not counting the field names a `properties` map declares."""
    if isinstance(value, list):
        return [key for item in value for key in keywords(item)]
    if not isinstance(value, dict):
        return []
    found = [*value]
    for key, item in value.items():
        found += ([key for field in item.values() for key in keywords(field)] if key == "properties"
                  else keywords(item))
    return found


def test_a_field_named_like_an_annotation_reaches_constrained_decoding(monkeypatch):
    sent = []
    body = {"choices": [{"message": {"content": "{}"}, "finish_reason": "stop"}]}
    monkeypatch.setattr(llm.requests, "post", lambda url, **kwargs: sent.append(kwargs["json"]) or response(200, body))
    schema = fields({"id": "x", "name": "x-coordinate", "type": "number"},
                    {"id": "n", "name": "name", "type": "string"},
                    {"id": "o", "name": "x-site", "type": "object", "children": [
                        {"id": "oy", "name": "x-depth", "type": "integer"}]},
                    {"id": "a", "name": "x-finds", "type": "array", "children": [
                        {"id": "ac", "name": "x-count", "type": "integer"}]},
                    {"id": "t", "name": "x-tags", "type": "array", "itemType": "string"},
                    {"id": "d", "name": "x-date", "type": "date"})
    assert "x-free-type" in keywords(schema)
    schema["properties"]["name"]["x-vendor-hint"] = "kept"
    OpenAIChat(url="http://server", model="m").complete(system="S", user="U", schema=schema)
    wire = sent[0]["response_format"]["json_schema"]["schema"]
    assert "x-free-type" not in keywords(wire)
    assert wire["properties"]["name"]["x-vendor-hint"] == "kept"
    assert wire["properties"]["x-coordinate"] == {"type": ["number", "null"]}
    assert wire["properties"]["x-date"] == {"type": ["string", "null"]}
    assert wire["properties"]["x-tags"]["items"] == {"type": "string"}
    for level in (wire, wire["properties"]["x-site"], wire["properties"]["x-finds"]["items"]):
        assert list(level["properties"]) == level["required"]
    assert wire["required"] == ["x-coordinate", "name", "x-site", "x-finds", "x-tags", "x-date"]
    assert wire["properties"]["x-site"]["required"] == ["x-depth"]
    assert wire["properties"]["x-finds"]["items"]["required"] == ["x-count"]
    assert nuextract_template(schema) == {"x-coordinate": "number", "name": "string", "x-site": {"x-depth": "integer"},
                                          "x-finds": [{"x-count": "integer"}], "x-tags": ["string"],
                                          "x-date": "verbatim-string"}


def test_nuextract_is_sent_the_template_and_the_instructions_only_through_the_chat_template(monkeypatch):
    """The June provider probe: when message text and template kwargs disagree, vLLM follows the text, so the
    controls travel in one channel. The user message is the source text alone; there is no system message."""
    sent = []
    body = {"choices": [{"message": {"content": '{"entry_no": 7}'}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 40, "completion_tokens": 6}}
    monkeypatch.setattr(llm.requests, "post", lambda url, **kwargs: sent.append((url, kwargs)) or response(200, body))
    chat = NuExtractChat(url="http://nuextract/v1/chat/completions", model="numind/NuExtract3-FP8", timeout=5.0)
    schema = fields({"id": "n", "name": "entry_no", "type": "integer"})
    reply = chat.complete(system="Read the entry.", user="7. Großenhain", schema=schema, max_tokens=256)
    assert reply.text == '{"entry_no": 7}' and reply.input_tokens == 40 and reply.finish == "stop"
    url, kwargs = sent[0]
    payload = kwargs["json"]
    assert url == "http://nuextract/v1/chat/completions" and kwargs["timeout"] == 5.0
    assert payload["model"] == "numind/NuExtract3-FP8" and payload["temperature"] == 0 and payload["max_tokens"] == 256
    assert payload["messages"] == [{"role": "user", "content": "7. Großenhain"}]
    assert payload["chat_template_kwargs"] == {"template": json.dumps({"entry_no": "integer"}, ensure_ascii=False),
                                               "instructions": "Read the entry.", "enable_thinking": False}
    assert "response_format" not in payload
    counted = chat.tokenize_body(system="Read the entry.", user="7. Großenhain", schema=schema)
    assert counted == {"model": "numind/NuExtract3-FP8", "add_generation_prompt": True,
                       "messages": payload["messages"], "chat_template_kwargs": payload["chat_template_kwargs"]}


def test_nuextract_has_nothing_to_extract_to_without_a_schema():
    with pytest.raises(TemplateError, match="template"):
        NuExtractChat(url="http://nuextract", model="m").complete(system="S", user="U", schema=None)


def test_the_template_follows_the_shape_of_the_schema():
    schema = fields({"id": "n", "name": "entry_no", "type": "integer"},
                    {"id": "h", "name": "height", "type": "number"},
                    {"id": "o", "name": "open", "type": "boolean"},
                    {"id": "q", "name": "inscription", "type": "verbatim-string"},
                    {"id": "s", "name": "sex", "type": "string", "allowedValues": ["mand", "kvinde", "ukendt"]},
                    {"id": "m", "name": "sheets", "type": "array", "itemType": "integer"},
                    {"id": "f", "name": "finds", "type": "array", "children": [
                        {"id": "c", "name": "count", "type": "integer"}]},
                    {"id": "p", "name": "place", "type": "object", "children": [
                        {"id": "z", "name": "zone", "type": "integer"}]})
    assert nuextract_template(schema) == {
        "entry_no": "integer", "height": "number", "open": "boolean", "inscription": "verbatim-string",
        "sex": ["mand", "kvinde", "ukendt"], "sheets": ["integer"], "finds": [{"count": "integer"}],
        "place": {"zone": "integer"}}


def test_a_grounded_candidate_asks_for_its_quote_and_key_verbatim():
    candidate = candidate_schema(Node(id="m", name="mbl_old", type="integer"))
    assert nuextract_template({"type": "object", "properties": {"mbl_old": candidate}}) == {"mbl_old": {
        "value": "integer", "quote": "verbatim-string", "key": "verbatim-string",
        "provenance": ["token", "positional"]}}


@pytest.mark.parametrize("schema", [{"type": ["string", "number"]}, {"type": "string", "enum": ["only"]},
                                    {"description": "no type at all"}])
def test_a_schema_a_template_cannot_express_is_refused(schema):
    with pytest.raises(TemplateError):
        nuextract_template({"type": "object", "properties": {"field": schema}})


def test_nuextract_uses_a_general_string_for_free_string_fields():
    schema = fields({"id": "s", "name": "place", "type": "string"})
    assert annotated(schema)
    assert nuextract_template(schema) == {"place": "string"}


def test_nuextract_preserves_printed_dates_for_grounding():
    schema = fields({"id": "d", "name": "date", "type": "date"})
    assert annotated(schema)
    assert nuextract_template(schema) == {"date": "verbatim-string"}


def test_a_field_type_nuextract_has_no_name_for_is_refused_like_any_inexpressible_schema():
    with pytest.raises(TemplateError, match="colour"):
        nuextract_template({"type": "object", "properties": {"x": {"type": "string", "x-free-type": "colour"}}})

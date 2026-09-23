"""The chat call: what is sent, what comes back, and the fallback for a server without structured output."""
import json
from types import SimpleNamespace

import pytest
import requests

from kei_exp.kie.extract import llm
from kei_exp.kie.extract.llm import ModelOutputError, OpenAIChat, parse_json


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

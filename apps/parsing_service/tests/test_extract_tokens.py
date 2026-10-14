"""The request budget is counted by the serving endpoint itself, on vLLM's `/tokenize` (design §8).

These checks use scripted HTTP answers; whether a count equals the served prompt count on the real chat-completions
route is the live check in `test_extract_tokens_live.py`, which runs against the deployed endpoint.
"""
import json

import pytest

from kei_exp.kie.extract.llm import NuExtractChat, OpenAIChat
from kei_exp.kie.extract.tokens import BudgetUnavailable, counter_for, counting, forget


class Http:
    """Scripted endpoint answers keyed by path; records every body it was sent."""
    def __init__(self, answers: dict[str, object]):
        self.answers, self.sent = answers, []

    def post(self, url: str, json: dict, timeout: float, **kwargs):
        self.sent.append((url, json))
        return self.get(url, timeout)

    def get(self, url: str, timeout: float, **kwargs):
        answer = self.answers.get("/" + url.split("//", 1)[1].split("/", 1)[1])
        return Response(404, {}) if answer is None else Response(200, answer)


class Response:
    def __init__(self, status: int, body: object):
        self.status_code, self.body = status, body

    def json(self):
        return self.body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(self.status_code)


class Chat:
    """What a counter needs of a chat adapter: where it sends, and the body that renders its prompt."""
    headers: dict | None = None

    def __init__(self, url: str, model: str = "qwen"):
        self.url, self.model = url, model

    def tokenize_body(self, *, system: str, user: str, schema: dict | None = None) -> dict:
        return {"model": self.model, "add_generation_prompt": True, "chat_template_kwargs": {"switch": schema},
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}


def test_a_counter_asks_the_server_to_count_exactly_the_request_the_chat_renders():
    http = Http({"/tokenize": {"count": 57, "max_model_len": 16384}})
    chat = Chat("http://v.test:8000/v1/chat/completions")
    counter = counter_for(chat, http=http)
    assert counter.request_tokens("system text", "user text", {"type": "object"}) == 57
    url, body = http.sent[-1]
    assert url == "http://v.test:8000/tokenize"
    assert body == chat.tokenize_body(system="system text", user="user text", schema={"type": "object"})
    assert counter.identity() == {"source": "vllm:/tokenize", "model": "qwen", "model_digest": None,
                                  "template_tokens": None}
    assert counter.context_tokens == 16384 and counter.probes == []  # counting is no model call


def test_the_served_context_is_read_at_every_use():
    http = Http({"/tokenize": {"count": 57, "max_model_len": 16384}})
    chat = Chat("http://w.test:8000/v1/chat/completions")
    assert counter_for(chat, http=http).context_tokens == 16384
    http.answers["/tokenize"] = {"count": 57, "max_model_len": 4096}  # the server restarted with a smaller context
    assert counter_for(chat, http=http).context_tokens == 4096


def test_an_endpoint_that_cannot_count_is_refused():
    with pytest.raises(BudgetUnavailable, match="no /tokenize"):
        counter_for(Chat("http://x.test/v1/chat/completions"), http=Http({}))


@pytest.mark.parametrize("chat", [
    NuExtractChat(url="http://n.test:8000/v1/chat/completions", model="numind/NuExtract3-FP8"),
    OpenAIChat(url="http://q.test:8000/v1/chat/completions", model="Qwen/Qwen3.8-27B-FP8")], ids=["nuextract", "instruct"])
def test_each_adapter_s_counter_is_obtained_from_a_request_it_can_render(chat):
    """Obtaining the counter reads the served context from one counted request; a template extractor renders none
    without a reply schema, so the probe carries one."""
    http = Http({"/tokenize": {"count": 40, "max_model_len": 32768}})
    counter = counter_for(chat, http=http)
    assert counter.context_tokens == 32768
    probe = http.sent[0][1]
    if isinstance(chat, NuExtractChat):
        assert json.loads(probe["chat_template_kwargs"]["template"])


def _cached(http, chat, attempt, user="user", schema=None):
    with counting(attempt):
        return counter_for(chat, http=http).request_tokens("system", user, schema or {"type": "object"})


def test_within_an_attempt_a_repeated_count_at_the_same_served_template_is_not_sent_again():
    """A durable planning round replays every earlier round's planning with a fresh counter: inside one attempt a body
    already counted at the same served tokenizer and template is answered from that count; its probe is still sent."""
    http = Http({"/tokenize": {"count": 57, "max_model_len": 16384, "tokens": [1, 2, 3]}})
    chat = Chat("http://cache.test:8000/v1/chat/completions")
    assert _cached(http, chat, "x/1") == 57
    sent = len(http.sent)
    assert _cached(http, chat, "x/1") == 57
    assert len(http.sent) == sent + 1  # the probe only
    _cached(http, chat, "x/1", user="other user")
    assert len(http.sent) == sent + 3


@pytest.mark.parametrize("change", ["template", "context", "headers", "endpoint"])
def test_a_count_is_sent_again_once_what_the_server_renders_with_may_have_changed(change):
    """A redeploy that keeps the served context but renders the probe differently (another template or tokenizer), a
    resized context, other request headers or another endpoint: none of the attempt's earlier counts is reused."""
    http = Http({"/tokenize": {"count": 57, "max_model_len": 16384, "tokens": [1, 2, 3]}})
    chat = Chat("http://cache.test:8000/v1/chat/completions")
    _cached(http, chat, f"change/{change}")
    if change == "template":
        http.answers["/tokenize"] = {"count": 60, "max_model_len": 16384, "tokens": [1, 2, 4]}
    elif change == "context":
        http.answers["/tokenize"] = {"count": 60, "max_model_len": 8192, "tokens": [1, 2, 3]}
    elif change == "headers":
        chat.headers = {"X-Route": "b"}
    else:
        chat = Chat("http://other.test:8000/v1/chat/completions")
    sent = len(http.sent)
    _cached(http, chat, f"change/{change}")
    assert len(http.sent) == sent + 2  # the probe and the count


def test_no_count_is_kept_outside_an_attempt_across_attempts_after_forget_or_without_probe_tokens():
    http = Http({"/tokenize": {"count": 57, "max_model_len": 16384, "tokens": [1]}})
    chat = Chat("http://cache.test:8000/v1/chat/completions")
    counter = counter_for(chat, http=http)
    counter.request_tokens("system", "user")
    sent = len(http.sent)
    counter.request_tokens("system", "user")  # not durable planning: sent
    assert len(http.sent) == sent + 1
    _cached(http, chat, "a/1")
    sent = len(http.sent)
    _cached(http, chat, "b/1")  # another attempt (or tenant) shares nothing
    assert len(http.sent) == sent + 2
    forget("a/1")
    sent = len(http.sent)
    _cached(http, chat, "a/1")
    assert len(http.sent) == sent + 2
    http.answers["/tokenize"] = {"count": 57, "max_model_len": 16384}  # no token ids: nothing identifies the template
    _cached(http, chat, "c/1")
    sent = len(http.sent)
    _cached(http, chat, "c/1")
    assert len(http.sent) == sent + 2


def test_bodies_that_differ_only_in_key_order_are_counted_separately():
    """A template may render a schema's properties in their order: the body is kept as sent, not canonicalized."""
    http = Http({"/tokenize": {"count": 57, "max_model_len": 16384, "tokens": [1]}})
    chat = Chat("http://cache.test:8000/v1/chat/completions")
    _cached(http, chat, "order/1", schema={"properties": {"a": {}, "b": {}}})
    sent = len(http.sent)
    _cached(http, chat, "order/1", schema={"properties": {"b": {}, "a": {}}})
    assert len(http.sent) == sent + 2

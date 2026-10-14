"""The request budget is counted by the serving endpoint itself, on vLLM's `/tokenize` (design §8).

These checks use scripted HTTP answers; whether a count equals the served prompt count on the real chat-completions
route is the live check in `test_extract_tokens_live.py`, which runs against the deployed endpoint.
"""
import json
import tracemalloc
from collections import OrderedDict

import pytest

from kei_exp.kie.extract import tokens
from kei_exp.kie.extract.llm import NuExtractChat, OpenAIChat
from kei_exp.kie.extract.tokens import BudgetUnavailable, counter_for, counting, forget, kept


@pytest.fixture(autouse=True)
def no_kept_counts(monkeypatch):
    """Each check starts with no count kept in the process."""
    monkeypatch.setattr(tokens, "_attempts", OrderedDict())
    monkeypatch.setattr(tokens, "_kept", 0)


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


class Tokenizing(Http):
    """An endpoint whose /tokenize renders the body's text with `tokenizer` (characters to token ids)."""
    def __init__(self, tokenizer, context=16384):
        super().__init__({})
        self.tokenizer, self.context = tokenizer, context

    def post(self, url: str, json: dict, timeout: float, **kwargs):
        self.sent.append((url, json))
        text = "".join(message["content"] for message in json["messages"])
        ids = [self.tokenizer(character) for character in text]
        answer = {"count": len(ids), "tokens": ids}
        return Response(200, answer if self.context is None else {**answer, "max_model_len": self.context})


def test_the_probe_is_a_fingerprint_a_tokenizer_change_outside_s_and_u_still_changes():
    """vLLM reports no tokenizer revision: a redeploy whose tokenizer renders "S" and "U" as before but other text
    (here, any non-ASCII character) differently changes the probe's token ids, so no earlier count is reused."""
    chat = Chat("http://fingerprint.test:8000/v1/chat/completions")
    http = Tokenizing(ord)
    _cached(http, chat, "fp/1")
    probe = http.sent[0][1]["messages"]
    assert probe[0]["content"] == tokens.PROBE_SYSTEM and probe[1]["content"] == tokens.PROBE_USER
    sent = len(http.sent)
    _cached(http, chat, "fp/1")
    assert len(http.sent) == sent + 1  # the same tokenizer: the probe only
    http.tokenizer = lambda character: ord(character) if character.isascii() else 0
    sent = len(http.sent)
    _cached(http, chat, "fp/1")
    assert len(http.sent) == sent + 2  # the probe and the count


def test_no_count_is_kept_when_the_server_reports_no_served_context():
    http = Tokenizing(ord, context=None)
    chat = Chat("http://nocontext.test:8000/v1/chat/completions")
    _cached(http, chat, "ctx/1")
    sent = len(http.sent)
    _cached(http, chat, "ctx/1")
    assert len(http.sent) == sent + 2 and kept() == 0


def test_a_body_that_is_not_json_is_sent_and_not_kept():
    class Odd(Chat):
        def tokenize_body(self, *, system, user, schema=None):
            return {**super().tokenize_body(system=system, user=user, schema=schema), "extra": {1, 2}}
    http = Http({"/tokenize": {"count": 57, "max_model_len": 16384, "tokens": [1]}})
    chat = Odd("http://odd.test:8000/v1/chat/completions")
    assert _cached(http, chat, "odd/1") == 57
    sent = len(http.sent)
    assert _cached(http, chat, "odd/1") == 57
    assert len(http.sent) == sent + 2 and kept() == 0


def test_the_process_keeps_at_most_cached_counts_over_all_attempts_older_attempts_first(monkeypatch):
    monkeypatch.setattr(tokens, "CACHED_COUNTS", 5)
    http = Http({"/tokenize": {"count": 57, "max_model_len": 16384, "tokens": [1]}})
    chat = Chat("http://cap.test:8000/v1/chat/completions")
    for n in range(4):
        _cached(http, chat, "old/1", user=f"old {n}")
    for n in range(3):
        _cached(http, chat, "new/1", user=f"new {n}")
    assert kept() == 5
    assert len(tokens._attempts["new/1"]) == 3 and len(tokens._attempts["old/1"]) == 2  # the old attempt's oldest out
    sent = len(http.sent)
    _cached(http, chat, "old/1", user="old 3")  # still kept
    assert len(http.sent) == sent + 1
    _cached(http, chat, "old/1", user="old 0")  # evicted: sent again
    assert len(http.sent) == sent + 3
    forget("old/1")
    forget("new/1")
    assert kept() == 0


def test_the_process_keeps_at_most_cached_attempts(monkeypatch):
    monkeypatch.setattr(tokens, "CACHED_ATTEMPTS", 2)
    http = Http({"/tokenize": {"count": 57, "max_model_len": 16384, "tokens": [1]}})
    chat = Chat("http://attempts.test:8000/v1/chat/completions")
    for attempt in ("a/1", "b/1", "c/1"):
        _cached(http, chat, attempt)
    assert list(tokens._attempts) == ["b/1", "c/1"] and kept() == 2


def test_a_kept_count_takes_under_entry_bytes_so_the_cap_bounds_bytes_not_prompt_sizes():
    """Keys are digests: a kept count's size does not grow with its prompt. CACHED_COUNTS of them stay under
    CACHED_BYTES (16 MiB), where 65,536 full prompt bodies of 100 KB would take some 6.6 GB."""
    n = 4096
    http = Http({"/tokenize": {"count": 57, "max_model_len": 16384, "tokens": [1]}})
    chat = Chat("http://bytes.test:8000/v1/chat/completions")
    prompts = [f"{n:06d} " + "x" * 100_000 for n in range(n)]
    with counting("bytes/1"):
        counter = counter_for(chat, http=http)
        tracemalloc.start()
        before = tracemalloc.get_traced_memory()[0]
        for prompt in prompts:
            counter.request_tokens("system", prompt)
        http.sent.clear()  # the fake endpoint's own record of the bodies is not the cache's
        retained = tracemalloc.get_traced_memory()[0] - before
        tracemalloc.stop()
    assert kept() == n
    assert retained / n < tokens.ENTRY_BYTES
    assert tokens.CACHED_COUNTS * tokens.ENTRY_BYTES <= tokens.CACHED_BYTES == 16 * 1024 * 1024


def test_a_count_being_sent_when_its_attempt_is_forgotten_is_not_kept():
    class Forgetting(Http):
        def post(self, url, json, timeout, **kwargs):
            if json["messages"][-1]["content"] == "late":
                forget("late/1")
            return super().post(url, json, timeout, **kwargs)
    http = Forgetting({"/tokenize": {"count": 57, "max_model_len": 16384, "tokens": [1]}})
    chat = Chat("http://late.test:8000/v1/chat/completions")
    _cached(http, chat, "late/1", user="late")
    assert kept() == 0 and "late/1" not in tokens._attempts


def test_a_served_count_that_differs_drops_the_attempt_s_kept_counts():
    """A redeploy or replica the probe did not show: the call fails on its served count, and the attempt counts again."""
    from kei_exp.kie.extract.calls import Call
    from kei_exp.workflows.durable_extract import drop_stale_counts
    http = Http({"/tokenize": {"count": 57, "max_model_len": 16384, "tokens": [1]}})
    chat = Chat("http://stale.test:8000/v1/chat/completions")
    _cached(http, chat, "ex/1")
    agreeing = Call("entry", 0, 57, 10, 0.1, "stop", True, counted_input_tokens=57)
    unreported = Call("entry", 0, None, None, 0.1, None, False, "timeout", counted_input_tokens=57)
    assert not drop_stale_counts("ex", "1", [agreeing, unreported]) and kept() == 1
    differing = Call("entry", 0, 60, 10, 0.1, "stop", False, "counted 57 input tokens but the server reported 60",
                     counted_input_tokens=57)
    assert drop_stale_counts("ex", "1", [differing]) and kept() == 0
    sent = len(http.sent)
    _cached(http, chat, "ex/1")
    assert len(http.sent) == sent + 2

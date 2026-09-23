"""The request budget is counted by the serving endpoint itself, on vLLM's `/tokenize` (design §8).

These checks use scripted HTTP answers; whether a count equals the served prompt count on the real chat-completions
route is the live check in `test_extract_tokens_live.py`, which runs against the deployed endpoint.
"""
import pytest

from kei_exp.kie.extract.tokens import BudgetUnavailable, counter_for


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

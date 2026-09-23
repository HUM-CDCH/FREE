"""The request budget is counted with the served model's own tokenizer, pinned to the served model (design §8).

These checks use a tiny byte-level BPE and scripted HTTP answers; whether a rebuilt tokenizer matches a real served
model is the live check in `test_extract_tokens_live.py`, which runs against the deployed endpoint.
"""
import pytest
from tokenizers import pre_tokenizers

from kei_exp.kie.extract.tokens import BudgetUnavailable, counter_for, ollama_tokenizer

ALPHABET = pre_tokenizers.ByteLevel.alphabet()


def show_payload(merges=("h e", "l l"), model="gpt2", pre="qwen2", extra_tokens=()) -> dict:
    tokens = sorted(ALPHABET) + ["he", "ll", *extra_tokens]
    return {"template": "{{ .System }}{{ .Prompt }}", "model_info": {
        "tokenizer.ggml.model": model, "tokenizer.ggml.pre": pre, "tokenizer.ggml.tokens": tokens,
        "tokenizer.ggml.merges": list(merges), "tokenizer.ggml.token_type": [1] * len(tokens)}}


def test_a_tokenizer_rebuilt_from_the_served_vocabulary_applies_its_merges():
    tokenizer = ollama_tokenizer(show_payload())
    assert len(tokenizer.encode("hello", add_special_tokens=False).ids) == 3  # he, ll, o


@pytest.mark.parametrize("payload, message", [
    (show_payload(model="llama"), "gpt2"), (show_payload(pre="unknown-pre"), "pre-tokenizer")])
def test_a_tokenizer_this_service_cannot_reproduce_is_refused(payload, message):
    with pytest.raises(BudgetUnavailable, match=message):
        ollama_tokenizer(payload)


class Http:
    """Scripted endpoint answers keyed by path; records every body it was sent."""
    def __init__(self, answers: dict[str, object]):
        self.answers, self.sent = answers, []

    def post(self, url: str, json: dict, timeout: float):
        self.sent.append((url, json))
        return self.get(url, timeout)

    def get(self, url: str, timeout: float):
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


def ollama(prompt_tokens: int) -> Http:
    return Http({"/api/show": show_payload(),
                 "/api/tags": {"models": [{"name": "m:1", "model": "m:1", "digest": "d" * 64}]},
                 "/v1/chat/completions": {"choices": [{"message": {"content": "{}"}, "finish_reason": "length"}],
                                          "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": 1}}})


def test_an_ollama_counter_is_pinned_to_the_digest_and_measures_the_template_on_the_real_route():
    http = ollama(prompt_tokens=2 + 21)  # "S" and "U" are one token each
    counter = counter_for("http://m.test:11434/v1/chat/completions", "m:1", http=http)
    assert counter.identity() == {"source": "ollama:/api/show", "model": "m:1", "model_digest": "d" * 64,
                                  "template_tokens": 21}
    assert counter.request_tokens("S", "hello") == 1 + 3 + 21
    probe = next(body for url, body in http.sent if url.endswith("/v1/chat/completions"))
    assert probe["reasoning_effort"] == "none" and probe["response_format"]["type"] == "json_schema"


def test_a_vllm_counter_asks_the_server_to_count_the_rendered_request():
    http = Http({"/tokenize": {"count": 57, "max_model_len": 16384}})
    counter = counter_for("http://v.test:8000/v1/chat/completions", "qwen", http=http)
    assert counter.request_tokens("system text", "user text") == 57
    url, body = http.sent[-1]
    assert url.endswith("/tokenize") and body["messages"][0] == {"role": "system", "content": "system text"}
    assert counter.identity()["source"] == "vllm:/tokenize" and counter.context_tokens == 16384


def test_a_counter_is_built_once_per_endpoint_and_served_model_digest():
    http = ollama(prompt_tokens=23)
    first = counter_for("http://c.test:11434/v1/chat/completions", "m:1", http=http)
    again = counter_for("http://c.test:11434/v1/chat/completions", "m:1", http=http)
    assert again is first
    assert sum(url.endswith("/api/show") for url, _ in http.sent) == 1
    http.answers["/api/tags"] = {"models": [{"name": "m:1", "model": "m:1", "digest": "e" * 64}]}
    replaced = counter_for("http://c.test:11434/v1/chat/completions", "m:1", http=http)
    assert replaced is not first and replaced.model_digest == "e" * 64


def test_an_endpoint_without_a_verifiable_tokenizer_is_refused():
    with pytest.raises(BudgetUnavailable, match="no verified tokenizer"):
        counter_for("http://x.test/v1/chat/completions", "m", http=Http({}))


class Loading(Http):
    """An Ollama that lists the model under /api/ps only once a completion has loaded it, with the given context."""
    def __init__(self, context: int):
        super().__init__(ollama(prompt_tokens=23).answers)
        self.context = context
        self.unload()

    def unload(self):
        self.answers["/api/ps"] = {"models": []}

    def post(self, url: str, json: dict, timeout: float):
        if url.endswith("/v1/chat/completions"):
            self.answers["/api/ps"] = {"models": [{"name": "m:1", "model": "m:1", "context_length": self.context}]}
        return super().post(url, json, timeout)


def test_the_served_context_is_read_again_whenever_a_cached_counter_is_used(tmp_path):
    http = Loading(context=8192)
    first = counter_for("http://r.test:11434/v1/chat/completions", "m:1", http=http)
    assert first.context_tokens == 8192
    http.answers["/api/ps"]["models"][0]["context_length"] = 2048  # the server restarted with a smaller context
    again = counter_for("http://r.test:11434/v1/chat/completions", "m:1", http=http)
    assert again is first and again.context_tokens == 2048
    assert sum(url.endswith("/api/show") for url, _ in http.sent) == 1


def test_every_calibration_request_is_reported_and_an_unloaded_model_is_loaded_by_one(tmp_path):
    http = Loading(context=8192)
    cold = counter_for("http://p.test:11434/v1/chat/completions", "m:1", http=http)
    assert [(probe["input_tokens"], probe["output_tokens"]) for probe in cold.probes] == [(23, 1)]
    warm = counter_for("http://p.test:11434/v1/chat/completions", "m:1", http=http)
    assert warm.probes == []  # loaded: nothing was sent
    http.unload()
    reloaded = counter_for("http://p.test:11434/v1/chat/completions", "m:1", http=http)
    assert len(reloaded.probes) == 1 and reloaded.context_tokens == 8192


def test_a_context_that_cannot_be_read_again_is_unknown_not_the_old_one():
    http = Http({"/tokenize": {"count": 57, "max_model_len": 8192}})
    counter_for("http://f.test:8000/v1/chat/completions", "qwen", http=http)
    del http.answers["/tokenize"]  # the refresh fails
    assert counter_for("http://f.test:8000/v1/chat/completions", "qwen", http=http).context_tokens is None


def test_a_vllm_counter_reads_its_context_again_on_reuse():
    http = Http({"/tokenize": {"count": 57, "max_model_len": 16384}})
    first = counter_for("http://w.test:8000/v1/chat/completions", "qwen", http=http)
    http.answers["/tokenize"] = {"count": 57, "max_model_len": 4096}
    assert counter_for("http://w.test:8000/v1/chat/completions", "qwen", http=http).context_tokens == 4096
    assert first.probes == []  # counting asks the server to count; no model call

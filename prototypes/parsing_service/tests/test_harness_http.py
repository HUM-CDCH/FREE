"""The research chat's HTTP adapter against a local server: the request it sends and the reply it reads. The other harness
tests replace the adapter with a scripted reader; this is the one place its wire format is checked without a model."""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
import requests

from experiments.harness.model import OutputConstraintUnsupported, ResearchChat, ResearchReply

SCHEMA = {"type": "object", "properties": {"answer": {"type": "string"}}, "required": ["answer"], "additionalProperties": False}
TOKENS = [{"token": '{"', "logprob": -0.01, "bytes": [123, 34], "top_logprobs": [{"token": '{"', "logprob": -0.01, "bytes": [123, 34]}]},
          {"token": "answer", "logprob": 0.0, "bytes": list(b"answer"), "top_logprobs": []}]


def ok(text: str = '{"answer": "x"}') -> tuple[int, dict]:
    return 200, {"choices": [{"message": {"content": text}, "finish_reason": "stop", "logprobs": {"content": TOKENS}}],
                 "usage": {"prompt_tokens": 12, "completion_tokens": 5}}


@pytest.fixture
def server():
    made = []

    def start(answer=lambda body: ok()):
        seen: list[dict] = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                seen.append(body)
                status, payload = answer(body)
                data = json.dumps(payload).encode() if not isinstance(payload, str) else payload.encode()
                self.send_response(status)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        made.append(httpd)
        return ResearchChat(url=f"http://127.0.0.1:{httpd.server_port}/v1/chat/completions", model="m", timeout=10.0), seen
    yield start
    for httpd in made:
        httpd.shutdown()
        httpd.server_close()


def test_the_request_carries_the_experiments_sampling_schema_and_probability_settings(server):
    chat, seen = server()
    chat.complete(system="S", user="U", schema=SCHEMA, max_tokens=99, temperature=0.7, seed=5, top_logprobs=3)
    body = seen[0]
    assert (body["temperature"], body["seed"], body["max_tokens"], body["logprobs"], body["top_logprobs"]) == (0.7, 5, 99, True, 3)
    assert body["messages"] == [{"role": "system", "content": "S"}, {"role": "user", "content": "U"}]
    assert body["response_format"] == {"type": "json_schema", "json_schema": {"name": "reply", "schema": SCHEMA, "strict": True}}
    assert body["chat_template_kwargs"] == {"enable_thinking": False}
    chat.complete(system="S", user="U", schema=None)                                   # nothing asked, nothing sent
    assert seen[1]["temperature"] == 0.0 and not {"seed", "logprobs", "top_logprobs", "response_format"} & set(seen[1])


def test_the_reply_keeps_text_usage_finish_reason_and_the_servers_token_records(server):
    chat, _ = server()
    reply = chat.complete(system="S", user="U", schema=SCHEMA, top_logprobs=2)
    assert isinstance(reply, ResearchReply) and reply.text == '{"answer": "x"}' and reply.finish == "stop"
    assert (reply.input_tokens, reply.output_tokens) == (12, 5) and reply.replayed is False
    assert [t["token"] for t in reply.logprobs] == ['{"', "answer"] and reply.logprobs[0]["top_logprobs"][0]["logprob"] == -0.01
    quiet, _ = server(lambda body: (200, {"choices": [{"message": {"content": "{}"}, "finish_reason": "length"}]}))
    reply = quiet.complete(system="S", user="U", schema=None)
    assert reply.logprobs == () and reply.input_tokens is None and reply.finish == "length"   # no usage: unknown, not zero


def test_a_refused_structured_output_is_an_error_and_never_a_silent_prompt_only_retry(server):
    chat, seen = server(lambda body: (400, {"error": "response_format json_schema is not supported by this server"}))
    with pytest.raises(OutputConstraintUnsupported, match="not supported"):
        chat.complete(system="S", user="U", schema=SCHEMA)
    assert len(seen) == 1                                                                # no second request without the schema
    other, seen = server(lambda body: (400, {"error": "context length exceeded"}))
    with pytest.raises(requests.HTTPError):                                              # any other refusal is an ordinary failure
        other.complete(system="S", user="U", schema=SCHEMA)
    with pytest.raises(requests.HTTPError):
        chat.complete(system="S", user="U", schema=None)

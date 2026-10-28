"""The durable transport stops only source-anchored runs of identical array objects."""
import json
from unittest.mock import patch

import pytest

from kei_exp.kie.extract import calls
from kei_exp.kie.extract.captured_provider import CapturedChat, _ItemRepetitionGuard
from kei_exp.kie.extract.llm import ModelOutputError


class Stream:
    headers = {"content-type": "text/event-stream"}
    status_code = 200

    def __init__(self, pieces, finish=True):
        self.pieces, self.finish = pieces, finish
        self.read = 0
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.closed = True

    def raise_for_status(self):
        pass

    def iter_lines(self):
        for piece in self.pieces:
            self.read += 1
            yield ("data: " + json.dumps({"choices": [{"delta": {"content": piece}}]})).encode()
        if self.finish:
            yield b'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":34}}'


def chat(stage="entry", adapter="nuextract", on_text=None):
    return CapturedChat({"url": "http://model", "model": "test", "timeout": 1, "adapter": adapter}, {},
                        on_text=on_text, stage=stage)


def item(anchor="anchor", **values):
    return json.dumps({"_item_text": anchor, "value": "x" * 65, **values}, ensure_ascii=False)


def test_runaway_fails_call_and_closes_before_exhausting_stream():
    response = Stream(["["] + [item() + ","] * 100 + ["{}]"])
    with patch("kei_exp.kie.extract.captured_provider.requests.post", return_value=response):
        parsed, attempts = calls.complete(chat(), stage="entry", record=0, system="", user="anchor", schema={})
    call = attempts[0]
    assert parsed is None and not call.ok and call.finish is None
    assert call.input_tokens is None and call.output_tokens is None and call.seconds > 0
    assert "nuextract-item-text-v1" in call.error
    assert response.closed and response.read < len(response.pieces)


def test_supported_unicode_duplicates_and_arbitrary_boundaries():
    value = item("café   au lait", nested=[{"x": "escaped \\\" , }"}])
    text = "[" + ",".join([value] * 40) + "]"
    guard = _ItemRepetitionGuard(("cafe\u0301\u00a0au\nlait ") * 40, 0)
    for char in text:
        guard.feed(char)


def test_intervening_values_and_type_changes_reset_runs():
    first = item(flag=True)
    second = item(flag=1)
    text = "[" + ",".join([first] * 25 + [second] * 25 + ["null"] + [first] * 25 +
                          ["[]"] + [first] * 25 + [item("missing")] + [first] * 25) + "]"
    _ItemRepetitionGuard("anchor", 0).feed(text)


def test_overlapping_occurrences_and_nested_arrays():
    value = item("aa")
    guard = _ItemRepetitionGuard("a" * 20, 0)
    guard.feed("[[" + ",".join([value] * 40) + "]]")
    with pytest.raises(ModelOutputError, match="33 adjacent items"):
        _ItemRepetitionGuard("aaa", 0).feed(
            "[[" + ",".join([value] * 47) + "]]")


def test_long_distinct_and_unlocated_items_are_accepted():
    values = [item(index=i) for i in range(100)] + [item("absent")] * 50
    _ItemRepetitionGuard("anchor", 0).feed("[" + ",".join(values) + "]")


def test_normal_stream_callback_usage_and_missing_finish():
    pieces = []
    response = Stream(['{"ok":', 'true}'])
    with patch("kei_exp.kie.extract.captured_provider.requests.post", return_value=response):
        reply = chat(stage="discovery", adapter="instruct", on_text=pieces.append).complete()
    assert pieces == ['{"ok":', 'true}'] and reply.finish == "stop"
    assert (reply.input_tokens, reply.output_tokens) == (12, 34)
    response = Stream(['{"ok":true}'], finish=False)
    with patch("kei_exp.kie.extract.captured_provider.requests.post", return_value=response):
        with pytest.raises(ModelOutputError, match="without a finish"):
            chat().complete(user="anchor")
    assert response.closed


def test_buffered_reply_is_guarded():
    class Buffered(Stream):
        headers = {"content-type": "application/json"}
        def json(self):
            return {"choices": [{"message": {"content": "[" + ",".join([item()] * 40) + "]"},
                                 "finish_reason": "length"}]}
    response = Buffered([])
    with patch("kei_exp.kie.extract.captured_provider.requests.post", return_value=response):
        with pytest.raises(ModelOutputError, match="nuextract-item-text-v1"):
            chat().complete(user="anchor")
    assert response.closed


def test_durable_retry_uses_finalized_input_and_successful_checkpoint_is_reused(monkeypatch):
    import inspect
    from copy import deepcopy
    from types import SimpleNamespace
    from kei_exp.workflows import durable_extract as worker

    request = {"composer": 1, "provider": {"adapter": "nuextract", "model": "test", "url": "http://model",
                                                  "timeout": 1},
               "budget": {"context": 4096, "counted": 12, "reserve": 256},
               "body": {"stage": "entry", "record": 0, "system": "s", "user": "anchor", "schema": {},
                        "max_tokens": 256, "httpRequest": {"messages": [{"content": "legacy"}]}}}
    saved = {"checkpoint": None, "intent": "RUN", "input": {"digest": "fixed", "request": deepcopy(request)}}
    committed, posted = [], []
    class Lease:
        def __init__(self, *_): pass
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def call(self, name, *args):
            if name == "read_call": return deepcopy(saved)
            if name == "begin_call": return True
            if name == "commit_output":
                committed.append(args[2])
                return {"recoverable": False}
            raise AssertionError(name)
    def post(*args, **kwargs):
        posted.append(kwargs["json"])
        return Stream(["["] + [item() + ","] * 100)
    monkeypatch.setattr(worker, "Lease", Lease)
    monkeypatch.setattr(worker, "coordinator", lambda: None)
    monkeypatch.setattr(worker, "chat_for", lambda _: SimpleNamespace())
    monkeypatch.setattr(worker, "drop_stale_counts", lambda *args, **kwargs: None)
    monkeypatch.setattr("kei_exp.kie.extract.captured_provider.requests.post", post)
    invoke = inspect.unwrap(worker.invoke_capture)
    assert invoke("extraction", "retry", "capture") == {"ok": False, "capture": "capture"}
    call = committed[0]["calls"][0]
    assert call["finish"] is None and "nuextract-item-text-v1" in call["error"]
    assert posted[0]["messages"] == request["body"]["httpRequest"]["messages"]
    assert saved["input"]["request"] == request
    saved["checkpoint"] = {"output": {"parsed": {}, "calls": [{"ok": True}]}}
    assert invoke("extraction", "retry", "capture") == {"ok": True, "capture": "capture"}
    assert len(posted) == 1


def test_only_nuextract_entry_is_guarded():
    class Buffered(Stream):
        headers = {"content-type": "application/json"}
        def json(self):
            return {"choices": [{"message": {"content": "[" + ",".join([item()] * 40) + "]"},
                                 "finish_reason": "stop"}]}
    for adapter, stage in [("instruct", "entry"), ("nuextract", "discovery")]:
        response = Buffered([])
        with patch("kei_exp.kie.extract.captured_provider.requests.post", return_value=response) as post:
            reply = chat(adapter=adapter, stage=stage).complete(user="anchor")
        assert reply.finish == "stop" and not post.call_args.kwargs.get("stream")


def test_nested_array_runs_do_not_share_adjacency():
    value = item()
    _ItemRepetitionGuard("anchor", 0).feed("[[" + ",".join([value] * 25) + "],[" +
                                          ",".join([value] * 25) + "]]")

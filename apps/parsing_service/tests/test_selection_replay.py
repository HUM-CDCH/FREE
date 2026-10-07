"""Conditional replay must never synthesize a response or silently reorder calls."""
import json

import pytest

from experiments.extraction.selection_replay import Counts, Subsequence


def test_replay_uses_monotone_exact_subsequence_and_preserves_reply(tmp_path):
    for number, value in enumerate(["first", "omitted", "last"], 1):
        prefix = tmp_path / f"fields-{number:04}"
        prefix.with_suffix(".request.json").write_text(json.dumps({"user": value, "stops": ["x"]}))
        prefix.with_suffix(".reply.json").write_text(json.dumps({"text": value, "input_tokens": 4,
            "output_tokens": 1, "seconds": 2, "finish": "stop"}))
    chat = Subsequence(tmp_path, "fields", "model")
    assert chat.complete(user="first", stops=("x",)).text == "first"
    assert chat.complete(user="last", stops=("x",)).text == "last"
    assert len(chat.used) == 2 and chat.cursor == 3
    with pytest.raises(ValueError, match="no live generation"):
        chat.complete(user="omitted", stops=["x"])


def test_count_cache_replays_without_a_provider(tmp_path, monkeypatch):
    from experiments.extraction import selection_replay
    class Counter:
        context_tokens = 32768
        def request_tokens(self, *args):
            return 123
    monkeypatch.setattr(selection_replay, "counter_for", lambda _: Counter())
    provider = {"model": "m", "base_url": "http://unused", "context_tokens": 32768}
    counter = Counts(provider, tmp_path)
    assert counter.request_tokens("s", "u", {"type": "object"}) == 123
    monkeypatch.setattr(selection_replay, "counter_for", lambda _: pytest.fail("unexpected live tokenizer"))
    assert Counts(provider, tmp_path).request_tokens("s", "u", {"type": "object"}) == 123


def test_different_replies_to_identical_requests_cannot_be_cherry_picked(tmp_path):
    for number in (1, 2):
        (tmp_path / f"fields-{number:04}.request.json").write_text('{"user": "same"}')
        (tmp_path / f"fields-{number:04}.reply.json").write_text(json.dumps({"text": str(number)}))
    with pytest.raises(ValueError, match="ambiguous repeated request"):
        Subsequence(tmp_path, "fields", "model")

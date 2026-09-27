"""A replay verifier must reject changed outputs and unknown offline token boundaries."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

path = Path(__file__).resolve().parents[3] / "docs/validation/extraction_capture_replay.py"
spec = importlib.util.spec_from_file_location("capture_replay", path)
replay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(replay)

PROVIDER = {"model": "test", "context_tokens": 8192, "base_url": "http://unused.invalid"}


def test_offline_replay_never_queries_a_missing_token_boundary(tmp_path, monkeypatch):
    monkeypatch.setattr(replay, "counter_for", lambda *_: pytest.fail("offline counter accessed provider"))
    counter = replay.Counts(SimpleNamespace(counts={}), PROVIDER, tmp_path, False)
    with pytest.raises(ValueError, match="missing token probe"):
        counter.request_tokens("system", "source")
    assert not list(tmp_path.iterdir())


def test_observed_token_boundary_is_reused_offline_and_refuses_changed_provider(tmp_path, monkeypatch):
    monkeypatch.setattr(replay, "counter_for", lambda _: SimpleNamespace(
        context_tokens=8192, request_tokens=lambda *args: 27))
    counter = replay.Counts(SimpleNamespace(counts={}), PROVIDER, tmp_path, True)
    assert counter.request_tokens("system", "source") == 27 and counter.fresh == 1
    monkeypatch.setattr(replay, "counter_for", lambda *_: pytest.fail("cached replay accessed provider"))
    offline = replay.Counts(SimpleNamespace(counts={}), PROVIDER, tmp_path, False)
    assert offline.request_tokens("system", "source") == 27 and offline.fresh == 0
    assert offline.identity()["model"] == "test"
    changed = replay.Counts(SimpleNamespace(counts={}), {**PROVIDER, "model": "other"}, tmp_path, False)
    with pytest.raises(ValueError, match="provider mismatch"):
        changed.request_tokens("system", "source")


def test_replay_rejects_changed_values_and_unused_replies_but_allows_top_level_clocks(tmp_path, monkeypatch):
    expected = {"started": "before", "seconds": 1, "records": [{"value": 35}]}
    receipt = {"status": "completed", "attempt": 1,
               "artifact_sha256": replay.digest(json.dumps(expected, sort_keys=True).encode())}
    replay.write_new(tmp_path / "result.json", {"artifact": expected, "execution": receipt})
    replay.write_new(tmp_path / "attempt-001.finished.json", receipt)
    study = {"providers": {"fields": PROVIDER, "reasoning": PROVIDER},
             "sources": [{"id": "source", "run": "unused", "generation": "generation"}]}
    cell = {"id": "source--control--0", "source": "source", "request": None}
    regenerated = {**expected, "started": "after", "seconds": 2}
    monkeypatch.setattr(replay, "extract", lambda *args, **kwargs: regenerated)
    assert replay.replay(study, cell, tmp_path, tmp_path / "counts", False)["equal_except_top_level_clocks"]
    regenerated["records"] = [{"value": 92}]
    with pytest.raises(ValueError, match="artifact differs"):
        replay.replay(study, cell, tmp_path, tmp_path / "counts", False)
    regenerated["records"] = expected["records"]
    replay.write_new(tmp_path / "calls/fields-0001.request.json",
                     {"system": "s", "user": "u", "schema": None})
    replay.write_new(tmp_path / "calls/fields-0001.reply.json", {"input_tokens": 2})
    with pytest.raises(ValueError, match="unconsumed"):
        replay.replay(study, cell, tmp_path, tmp_path / "counts", False)

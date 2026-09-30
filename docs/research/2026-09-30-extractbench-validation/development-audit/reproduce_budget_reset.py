"""Offline counterexample: the real executor resets its cell meter on resume.

Only a fabricated source and a scripted in-process provider are used. A first
admission window permits one call; the next permits the two remaining calls.
The cumulative study allowance is three, while the configured cell cap is two.
"""
from __future__ import annotations

import json
from pathlib import Path
import socket
import tempfile


def deny_network(*args, **kwargs):
    raise RuntimeError("Network prohibited in the synthetic budget counterexample")


def main():
    socket.socket.connect = deny_network
    socket.socket.connect_ex = deny_network
    socket.create_connection = deny_network
    from experiments.harness.config import Config
    from experiments.harness.data import case_of
    from experiments.harness.extract import chunks_of
    from experiments.harness.model import Allowance, Provider, ResearchReply
    from experiments.harness.study import execute_cell

    class ScriptedChat:
        model = "audit-scripted-provider"
        accepts_sampling = True

        def __init__(self):
            self.calls = 0

        def complete(self, **request):
            self.calls += 1
            return ResearchReply('{"records": []}', 10, 5, "stop", 0)

    case = case_of({"id": "audit-synthetic-budget", "group": "audit-synthetic-budget",
        "split": "dev", "schema": {"recordDescription": "Fabricated record",
            "schemaNodes": [{"id": "value", "name": "value", "type": "string"}]},
        "gold": [], "passages": [{"id": f"p{i}_s0", "page": i,
            "text": f"Fabricated passage {i}: " + "a" * 220} for i in range(1, 4)]})
    cfg = Config.model_validate({"chunking": {"mode": "fixed", "max_chars": 300},
        "budget": {"calls": 2}, "recovery": {"retries": 0, "subdivide": False}})
    assert len(chunks_of(list(case.evidence.passages), cfg)) == 3
    chat = ScriptedChat()
    provider = Provider(chat)
    run_pin = {"code_sha256": "synthetic-audit-only", "environment": {"synthetic": True}}
    with tempfile.TemporaryDirectory(prefix="extractbench-budget-audit-") as directory:
        out = Path(directory)
        provider.allowance = Allowance(1)
        first = execute_cell(out, "synthetic-study", "base", cfg, case, provider,
                             "synthetic-offline", run_pin)
        assert first == ("stopped_by_study_budget", 1)
        # A prospective second window has the remaining two study calls. The
        # unchanged first request replays; the next two are new scripted calls.
        provider.allowance = Allowance(2)
        second = execute_cell(out, "synthetic-study", "base", cfg, case, provider,
                              "synthetic-offline", run_pin)
        assert second == ("completed", 2)
        cell = out / "cells/base--audit-synthetic-budget"
        attempts = [json.loads(p.read_text()) for p in sorted(cell.glob("attempt-*.finished.json"))]
        cumulative = sum(a["spent"]["fresh"]["calls"] for a in attempts)
        assert cumulative == chat.calls == 3 > cfg.budget.calls
        assert attempts[1]["spent"]["replayed"]["calls"] == 1
        print(json.dumps({"defect_reproduced": True, "configured_cell_call_cap": cfg.budget.calls,
            "first_attempt_scripted_calls": first[1], "second_attempt_scripted_calls": second[1],
            "cumulative_scripted_calls": cumulative, "second_attempt_replays": 1,
            "cumulative_study_call_cap": 3, "live_provider_calls": 0,
            "real_development_inputs_opened": 0, "heldout_inputs_opened": 0}))


if __name__ == "__main__":
    main()

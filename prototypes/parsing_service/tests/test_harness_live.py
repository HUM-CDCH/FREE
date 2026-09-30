"""A small real-provider smoke test of the harness. It needs a served model (KEI_EXTRACT_URL and KEI_EXTRACT_MODEL; set
HARNESS_LIVE_COUNTER=vllm when the server has /tokenize) and is left out of the fast tier by its marker. It shows that the
pipeline, the sampling and probability requests and the cache work against a real server; it says nothing about which
technique is better, and its cases are synthetic."""
from __future__ import annotations

import os

import pytest

from experiments.harness import study as st
from experiments.harness import synth
from experiments.harness.config import Config
from experiments.harness.data import case_of
from experiments.harness.evaluate import Eval, check_invariants, metrics, pool, score_case
from experiments.harness.run import meter_for, run_case

pytestmark = [pytest.mark.live_model, pytest.mark.skipif(not os.environ.get("KEI_EXTRACT_URL"), reason="set KEI_EXTRACT_URL")]


@pytest.fixture(scope="module")
def provider(tmp_path_factory):
    spec = {"url": os.environ["KEI_EXTRACT_URL"], "model": os.environ["KEI_EXTRACT_MODEL"],
            "counter": os.environ.get("HARNESS_LIVE_COUNTER"), "timeout": 900.0}
    return st.make_provider(spec, tmp_path_factory.mktemp("cache"))


def test_token_probabilities_under_structured_output_are_reported_and_say_which_kind(provider):
    """Probe: ask for a forced enum the model would not choose. A raw (pre-constraint) probability for the forced token is
    small; a processed one is near 1. The result is printed, because the confidence signals are only comparable across
    output modes when their semantics are known."""
    schema = {"type": "object", "properties": {"answer": {"type": "string", "enum": ["Zanzibar"]}}, "required": ["answer"], "additionalProperties": False}
    system, user = "Answer with JSON.", "What is the capital of France? Answer with one word."
    constrained = provider.chat.complete(system=system, user=user, schema=schema, max_tokens=40, top_logprobs=3)
    free = provider.chat.complete(system=system, user=user, schema=None, max_tokens=40, top_logprobs=3)
    from experiments.harness.signals import value_stats
    forced = value_stats(constrained, ("answer",))
    kind = "unknown" if forced is None else "processed (post-constraint: a forced token looks certain)" if forced["p_first"] > 0.5 \
        else "raw (pre-constraint: a forced token looks unlikely)"
    print("\nPROBE forced-enum value stats:", forced, "| kind:", kind, "| unconstrained reply:", repr(free.text[:60]))
    print("PROBE served identity:", provider.identity)
    assert constrained.logprobs, "the server returned no token probabilities for a constrained reply"
    assert forced is not None and 0.0 < forced["p_first"] <= 1.0


def test_the_pipeline_runs_against_the_served_model_and_reports_cost_signals_and_a_replay(provider):
    case = case_of(synth.catalogue("live", records=3, seed=2))
    rows = {}
    for name, config in (("baseline", {"signals": {"top_logprobs": 3}}),
                         ("quote", {"signals": {"top_logprobs": 3}, "evidence": {"mode": "quote"}})):
        cfg = Config.model_validate({"output": {"max_tokens": 1500}, **config})
        artifact = run_case(case, cfg, meter_for(provider, cfg), admission="counted" if provider.counter else "uncounted")
        counts, _ = score_case(case, artifact, Eval())
        assert check_invariants(counts) == []
        rows[name] = (artifact, metrics(pool([counts])))
        print(f"\nLIVE {name}: complete={artifact['coverage']['complete']} F1={rows[name][1]['field']['f1']} "
              f"fresh={artifact['cost']['fresh']} evidence_span_hit={rows[name][1]['evidence']['span_hit']}")
    base, m = rows["baseline"]
    assert base["coverage"]["complete"] and base["cost"]["fresh"]["calls"] == 1 and base["provider"]["admission"] in ("counted", "uncounted")
    assert m["field"]["recall"] >= 0.5, "a served model should read this trivially structured text"
    signal = next(r for r in base["fields"] if r["field"] == "site" and r["status"] == "value")["signals"]
    assert signal["p_first"] is not None and 0 < signal["p_first"] <= 1 and signal["verbalized"] is None
    cfg = Config.model_validate({"output": {"max_tokens": 1500}, "signals": {"top_logprobs": 3}})
    again = run_case(case, cfg, meter_for(provider, cfg))
    assert again["cost"]["fresh"]["calls"] == 0 and again["cost"]["replayed"]["calls"] == 1 and again["records"] == base["records"]

"""Studies: bounded matrices checked before any call, sealed and resumable cells, split discipline, and one comparison."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from experiments.extraction.manifest import digest
from experiments.harness import study as st
from experiments.harness import synth
from experiments.harness.config import Config
from experiments.harness.model import Allowance, OutputConstraintUnsupported, Provider, ResearchReply
from kei_exp.canonical import canonical_json
from tests.helpers.harness_chat import Reader

SPLITS = ["fit", "fit", "calibration", "dev", "dev", "test"]


def write(tmp_path: Path, **extra) -> Path:
    dataset = synth.dataset([synth.catalogue(f"c{i}", split=split, records=4, seed=i) for i, split in enumerate(SPLITS)])
    (tmp_path / "data.json").write_text(json.dumps(dataset))
    doc = {"version": 1, "id": "demo", "dataset": "data.json", "provider": {"url": "http://nowhere/v1/chat/completions", "model": "fake"},
           "base": {}, "variants": {"quote": {"evidence": {"mode": "quote"}}, "fixed": {"chunking": {"mode": "fixed", "max_chars": 200}}},
           "comparisons": [{"control": "base", "treatment": "quote", "factor": "evidence"}], **extra}
    path = tmp_path / "study.json"
    path.write_text(json.dumps(doc))
    return path


def go(path: Path, out: Path, reader: Reader | None = None, **kwargs):
    kwargs = {"execute": True, "uncounted": True, "splits": ["fit", "calibration", "dev"], "variants": None, **kwargs}
    return st.run_study(path, out, provider=Provider(reader or Reader()), **kwargs)


def test_synth_writes_a_reproducible_dataset_whose_splits_do_not_leak(tmp_path):
    st.main(["synth", str(tmp_path / "a.json"), "--cases", "16", "--records", "5"])
    st.main(["synth", str(tmp_path / "b.json"), "--cases", "16", "--records", "5"])
    assert (tmp_path / "a.json").read_bytes() == (tmp_path / "b.json").read_bytes()
    from experiments.harness.data import load_cases
    cases = load_cases(tmp_path / "a.json")                                              # load_cases refuses leaking splits
    assert {c.split for c in cases} == {"fit", "calibration", "dev", "test"} and len(cases) == 16


def test_a_variant_that_cannot_run_is_refused_before_any_call_and_an_incompatible_pair_never_starts(tmp_path):
    path = write(tmp_path, variants={"ids": {"evidence": {"mode": "ids"}}})
    reader = Reader()
    with pytest.raises(ValueError, match="layout"):
        go(path, tmp_path / "out", reader)
    assert reader.calls == []
    path = write(tmp_path, variants={"gate": {"verification": {"gate": "flag"}}}, comparisons=[])
    with pytest.raises(ValueError, match="evidence"):
        st.check_study(json.loads(path.read_text()))


def test_a_comparison_must_change_exactly_the_factor_it_declares(tmp_path):
    path = write(tmp_path, comparisons=[{"control": "base", "treatment": "quote", "factor": "chunking"}])
    with pytest.raises(ValueError, match="not exactly its declared factor"):
        st.check_study(json.loads(path.read_text()))
    two = write(tmp_path, variants={"both": {"evidence": {"mode": "quote"}, "chunking": {"mode": "fixed", "max_chars": 200}}},
                comparisons=[{"control": "base", "treatment": "both", "factor": "evidence"}])
    with pytest.raises(ValueError, match="not exactly"):
        st.check_study(json.loads(two.read_text()))


def test_the_combined_variant_and_its_minus_one_ablations_are_generated_and_each_differs_by_one_factor(tmp_path):
    path = write(tmp_path, combined={"name": "combined", "from": ["quote", "fixed"]},
                 interactions=[{"baseline": "base", "a": "quote", "b": "fixed", "ab": "combined"}])
    configs, comparisons = st.check_study(json.loads(path.read_text()))
    assert {"combined", "combined-minus-quote", "combined-minus-fixed"} <= set(configs)
    assert configs["combined"].evidence.mode == "quote" and configs["combined"].chunking.mode == "fixed"
    assert configs["combined-minus-quote"].evidence.mode == "none" and configs["combined-minus-fixed"].chunking.mode == "whole"
    minus = [c for c in comparisons if c["control"].startswith("combined-minus")]
    assert {(c["control"], tuple(c["factor"])) for c in minus} == {("combined-minus-quote", ("evidence",)), ("combined-minus-fixed", ("chunking",))}
    assert len(configs) == 6                                                            # base, two variants, combined and two minus-one: not a Cartesian product


def test_a_dry_run_sends_nothing_and_an_over_budget_projection_refuses_to_start(tmp_path):
    path = write(tmp_path, budget={"max_calls": 3})
    reader = Reader()
    plan = st.run_study(path, tmp_path / "out", execute=False, uncounted=True, splits=["fit", "calibration", "dev"], variants=None)
    assert plan["cells"] == 15 and plan["projected_calls"] >= 15 and reader.calls == []
    with pytest.raises(ValueError, match="exceed the study budget"):
        go(path, tmp_path / "out", reader)
    assert reader.calls == []
    with pytest.raises(ValueError, match="--uncounted"):
        st.run_study(path, tmp_path / "out2", execute=True, uncounted=False, splits=["dev"], variants=None, force=True)


def test_cells_are_sealed_and_resumable_and_a_changed_study_or_artifact_is_refused(tmp_path):
    path, out = write(tmp_path), tmp_path / "out"
    first = go(path, out)
    assert first["executed"] == {"completed": 15}
    reader = Reader()
    again = go(path, out, reader)
    assert again["executed"] == {"retained_completed": 15} and reader.calls == []       # nothing re-run, nothing re-sent
    seal = json.loads((out / "cells" / "base--c3" / "result.json").read_text())
    assert seal["execution"]["status"] == "completed" and len(seal["execution"]["artifact_sha256"]) == 64
    path.write_text(path.read_text().replace('"demo"', '"other"'))
    with pytest.raises(ValueError, match="another study"):
        go(path, out)
    path.write_text(path.read_text().replace('"other"', '"demo"'))
    seal["artifact"]["records"] = []
    (out / "cells" / "base--c3" / "result.json").write_text(json.dumps(seal))
    with pytest.raises(ValueError, match="unsealed or changed"):
        st.compare_study(path, out, "dev")


def test_the_test_split_is_not_touched_without_a_declared_final_variant_and_then_only_for_it_and_the_baseline(tmp_path):
    path, out = write(tmp_path), tmp_path / "out"
    with pytest.raises(ValueError, match="final"):
        go(path, out, splits=["test"])
    go(path, out)
    with pytest.raises(ValueError, match="final"):
        st.compare_study(path, out, "test")
    path = write(tmp_path, final="quote")
    plan = st.run_study(path, tmp_path / "out3", execute=False, uncounted=True, splits=["test"], variants=None)
    assert plan["cells"] == 2                                                             # the baseline and the final variant, on one test case
    go(path, tmp_path / "out3", splits=["test"])
    report = st.compare_study(path, tmp_path / "out3", "test")
    assert set(report["variants"]) == {"base", "quote"}


def test_compare_reports_pooled_metrics_with_group_intervals_paired_effects_costs_and_no_winner(tmp_path):
    path, out = write(tmp_path), tmp_path / "out"
    go(path, out, Reader(wrong={(41, "site"): "Zzz"}))
    report = st.compare_study(path, out, "dev")
    base = report["variants"]["base"]
    assert base["invariant_violations"] == [] and base["groups"] == 2 and base["metrics"]["field"]["gold_value_fields"] > 0
    assert base["metrics"]["field"]["precision"] < 1.0 and base["intervals"]["f1"]["unit"] == "group"
    assert base["cost_as_if_cold"]["calls"] == base["metrics"]["cost"]["fresh"]["calls"] + base["metrics"]["cost"]["replayed"]["calls"]
    quote = report["comparisons"][0]
    assert quote["unit"] == "group" and quote["groups"] == 2 and "percentile_95" in quote["effect"] and quote["factor"] == "evidence"
    assert "selection" in report and "winner" in report["selection"]
    assert report["variants"]["quote"]["metrics"]["evidence"]["annotated_fields"] > 0     # only the evidence variant cites anything
    assert report["variants"]["base"]["metrics"]["evidence"]["cited"] == 0
    out_file = tmp_path / "report.json"
    st.main(["compare", str(path), str(out), str(out_file), "--split", "dev"])
    assert json.loads(out_file.read_text())["split"] == "dev"


def test_a_comparison_says_when_the_two_arms_sent_the_same_requests(tmp_path):
    quote = {"evidence": {"mode": "quote"}}
    path = write(tmp_path, variants={"quote": quote, "gated": {**quote, "verification": {"gate": "flag"}}},
                 comparisons=[{"control": "base", "treatment": "quote", "factor": "evidence"},
                              {"control": "quote", "treatment": "gated", "factor": "verification"}])
    out = tmp_path / "out"
    go(path, out, splits=["dev"])
    changed, gate = st.compare_study(path, out, "dev")["comparisons"]
    assert changed["requests"]["identical"] is False and changed["requests"]["treatment_only"] > 0
    assert gate["requests"]["identical"] is True and "after the model" in gate["requests"]["note"]      # a gate changes no request: said so


def test_a_refused_output_constraint_is_a_recorded_unsupported_cell_and_the_study_goes_on(tmp_path):
    class Refuses(Reader):
        def complete(self, **kw):
            if kw["schema"] is not None:
                raise OutputConstraintUnsupported("response_format is not supported")
            return super().complete(**kw)
    path = write(tmp_path, variants={"prompted": {"output": {"constraint": "prompt"}}}, comparisons=[])
    result = go(path, tmp_path / "out", Refuses(), variants=["base", "prompted"], splits=["dev"])
    assert result["executed"] == {"unsupported": 2, "completed": 2}
    finished = json.loads(next((tmp_path / "out" / "cells").glob("base--c3/attempt-001.finished.json")).read_text())
    assert finished["status"] == "unsupported" and "json_schema" in finished["prerequisite"]
    report = st.compare_study(path, tmp_path / "out", "dev")
    assert report["variants"]["base"]["failed_cells"] and report["variants"]["prompted"]["metrics"]["field"]["recall"] is not None


def test_confidence_fuses_on_fit_calibrates_on_calibration_reports_on_dev_and_withholds_a_guarantee_it_cannot_give(tmp_path):
    wrong = {(41, "site"): "Zzz", (43, "kreis"): "Q"}
    reader = Reader(wrong=wrong, logprob={(41, "site"): -3.0, (43, "kreis"): -3.0})
    path = write(tmp_path, base={"signals": {"top_logprobs": 3}}, variants={}, comparisons=[])
    out = tmp_path / "out"
    go(path, out, reader)
    report = st.confidence_study(path, out, "base", alpha=0.1, delta=0.1)
    assert report["unit"] == "group" and report["population"]["fit"] >= report["population"]["dev"] > 0
    assert report["scores"]["raw:p_first"]["auroc"] == 1.0 and report["scores"]["fused"]["auroc"] == 1.0
    assert report["scores"]["raw:verbalized"]["coverage_of_signal"] == 0.0                # a signal nobody gave is missing, not zero
    assert set(report["calibration"]) == {"platt", "isotonic"}
    assert set(report["models"]) == {"fusion", "fit_rows", "platt", "isotonic"} and report["models"]["fit_rows"] == report["population"]["fit"]
    assert set(report["scores"]["fused"]["intervals"]) == {"auroc", "brier", "aurc"}                 # uncertainty by group, when there are groups
    for method in ("ltt", "crc"):
        assert report["risk_control"][method]["certified"] is False and "too few" in report["risk_control"][method]["reason"]
    st.main(["confidence", str(path), str(out), str(tmp_path / "conf.json"), "--variant", "base"])
    assert json.loads((tmp_path / "conf.json").read_text())["variant"] == "base"


# --- attribution: a result is compared only under the experiment that made it ------------------------------------------------

def reseal(cell: Path, edit) -> None:
    seal = json.loads((cell / "result.json").read_text())
    edit(seal["artifact"])
    seal["execution"]["artifact_sha256"] = digest(canonical_json(seal["artifact"]))       # a consistent seal: only the content is wrong
    (cell / "result.json").write_text(json.dumps(seal))


def test_a_report_is_refused_when_the_dataset_the_scorer_or_a_cell_is_not_the_one_the_run_used(tmp_path, monkeypatch):
    path, out = write(tmp_path), tmp_path / "out"
    go(path, out)
    manifest = json.loads((out / "manifest.json").read_text())
    assert {"study_sha256", "dataset_sha256", "evaluation_sha256", "code", "environment", "provider"} <= set(manifest)
    assert st.compare_study(path, out, "dev")["provenance"]["run_code_matches_current"] is True
    cell = out / "cells" / "base--c3"
    reseal(cell, lambda a: a.update(config_sha256="0" * 64))
    with pytest.raises(ValueError, match="another configuration"):
        st.compare_study(path, out, "dev")
    with pytest.raises(ValueError, match="another configuration"):
        st.confidence_study(path, out, "base", alpha=0.1, delta=0.1)
    reseal(cell, lambda a: a.update(config_sha256=Config().sha256()))
    reseal(cell, lambda a: a["source"].update(digest="f" * 64))
    with pytest.raises(ValueError, match="source snapshot"):
        st.compare_study(path, out, "dev")
    reseal(cell, lambda a: a["source"].update(digest=json.loads((cell.parent / "base--c4" / "result.json").read_text())["artifact"]["source"]["digest"]))
    pin = json.loads((cell / "pin.json").read_text())
    (cell / "pin.json").write_text(json.dumps({**pin, "study_sha256": "1" * 64}))
    with pytest.raises(ValueError, match="different study"):
        st.compare_study(path, out, "dev")
    (cell / "pin.json").write_text(json.dumps(pin))
    monkeypatch.setattr(st.Eval, "sha256", lambda self: "changed", raising=False)             # scoring rules that are not the run's
    with pytest.raises(ValueError, match="evaluation changed"):
        st.compare_study(path, out, "dev")
    monkeypatch.undo()
    data = json.loads((tmp_path / "data.json").read_text())
    data["cases"][0]["gold"][0]["fields"]["site"]["value"] = "Elsewhere"
    (tmp_path / "data.json").write_text(json.dumps(data))
    with pytest.raises(ValueError, match="dataset changed"):
        st.compare_study(path, out, "dev")
    with pytest.raises(ValueError, match="another dataset"):
        go(path, out)


def test_resuming_needs_the_same_provider_and_code_unless_a_code_change_is_allowed(tmp_path, monkeypatch):
    path, out = write(tmp_path), tmp_path / "out"
    kwargs = {"execute": True, "uncounted": True, "splits": ["dev"], "variants": None}
    st.run_study(path, out, provider=Provider(Reader(), identity={"url": "http://a"}), **kwargs)
    with pytest.raises(ValueError, match="another provider"):
        st.run_study(path, out, provider=Provider(Reader(), identity={"url": "http://b"}), **kwargs)
    monkeypatch.setattr(st, "harness_pin", lambda root: {"changed": True})
    same = Provider(Reader(), identity={"url": "http://a"})
    with pytest.raises(ValueError, match="code, or the environment, changed"):
        st.run_study(path, out, provider=same, **kwargs)
    resumed = st.run_study(path, out, provider=same, allow_code_change=True, **kwargs)
    assert resumed["executed"] == {"retained_completed": 6}
    assert st.compare_study(path, out, "dev")["provenance"]["run_code_matches_current"] is False    # and the report says so
    monkeypatch.undo()
    monkeypatch.setattr(st, "environment", lambda: {"python": "0.0"})                              # the same code under other libraries
    with pytest.raises(ValueError, match="environment"):
        st.run_study(path, out, provider=same, **kwargs)


def test_the_studys_call_allowance_is_hard_a_cut_short_cell_is_not_sealed_and_a_larger_budget_continues_it(tmp_path):
    path = write(tmp_path, base={"recovery": {"retries": 1}}, variants={}, comparisons=[], budget={"max_calls": 1})
    reader = Reader(garbage_at={0})                                                    # the first call fails, and its retry is the second call
    out = tmp_path / "out"
    result = go(path, out, reader, splits=["dev"], force=True)
    assert len(reader.calls) == 1 and result["fresh_calls_spent"] == 1                # never two calls under a budget of one
    assert result["executed"] == {"stopped_by_study_budget": 1, "not_run_budget_spent": 1}
    cut = next(d for d in (out / "cells").iterdir() if not (d / "result.json").exists() and list(d.glob("attempt-*.finished.json")))
    assert json.loads(next(cut.glob("attempt-*.finished.json")).read_text())["status"] == "stopped_by_study_budget"
    doc = json.loads(path.read_text())
    doc["budget"]["max_calls"] = 50                                                    # the budget is not part of the experiment's identity
    path.write_text(json.dumps(doc))
    resumed = go(path, out, Reader(), splits=["dev"])
    assert resumed["executed"] == {"completed": 2} and resumed["budget"] == 50
    report = st.compare_study(path, out, "dev")
    assert report["variants"]["base"]["attempt_spend"]["not_sealed"] == 1 and report["variants"]["base"]["attempt_spend"]["attempts"] == 3
    assert report["variants"]["base"]["cost_as_if_cold"]["calls"] >= 2                # sealed cells only; the cut attempt is in attempt_spend


@pytest.mark.parametrize("first_usage", ["call_cap", "known", "unknown", "partial", "transport"])
def test_resuming_a_cell_keeps_prior_fresh_charges_and_unknown_token_reservations(tmp_path, first_usage):
    from experiments.harness.data import case_of
    case = case_of({"id": "resume", "group": "resume", "split": "dev", "gold": [],
                    "schema": {"recordDescription": "record", "schemaNodes": [{"id": "v", "name": "value", "type": "string"}]},
                    "passages": [{"id": f"p{i}_s0", "page": i, "text": f"Passage {i}: " + "a" * 220} for i in range(1, 4)]})

    class Counter:
        context_tokens = 4096
        def request_tokens(self, *args):
            return 10

    class Chat:
        model = "scripted"
        calls = 0
        def complete(self, **kw):
            self.calls += 1
            if self.calls == 1:
                if first_usage == "transport":
                    raise OSError("connection lost after admission")
                if first_usage == "unknown":
                    return ResearchReply('{"records": []}', None, None, "stop", 0)
                if first_usage == "partial":
                    return ResearchReply('{"records": []}', 10, None, "stop", 0)
            return ResearchReply('{"records": []}', 10, kw["max_tokens"], "stop", 0)

    first_charge = 532 if first_usage == "partial" else 522
    budget = {"calls": 2} if first_usage == "call_cap" else {"calls": 10, "tokens": first_charge * 2}
    cfg = Config.model_validate({"chunking": {"mode": "fixed", "max_chars": 300}, "output": {"max_tokens": 512},
                                 "budget": budget, "recovery": {"retries": 0, "subdivide": False}})
    chat = Chat()
    provider = Provider(chat, tmp_path / "cache", counter=Counter())
    provider.allowance = Allowance(1)
    args = (tmp_path, "study", "base", cfg, case, provider, "counted", {})
    assert st.execute_cell(*args) == ("stopped_by_study_budget", 1)
    resumed = Provider(chat, tmp_path / "cache", counter=Counter())
    resumed.allowance = Allowance(2)
    assert st.execute_cell(tmp_path, "study", "base", cfg, case, resumed, "counted", {}) == ("completed", 1)
    directory = tmp_path / "cells/base--resume"
    attempts = [json.loads(p.read_text()) for p in sorted(directory.glob("attempt-*.finished.json"))]
    assert sum(a["spent"]["fresh"]["calls"] for a in attempts) == chat.calls == 2
    assert attempts[1]["spent"]["replayed"]["calls"] == (0 if first_usage == "transport" else 1)
    if cfg.budget.tokens is not None:
        assert attempts[0]["budget_spent"]["tokens"] == first_charge
        assert sum(a["budget_spent"]["tokens"] for a in attempts) <= cfg.budget.tokens
    artifact = json.loads((directory / "result.json").read_text())["artifact"]
    assert not artifact["coverage"]["complete"]
    assert any("budget exhausted" in i["detail"] for i in artifact["issues"])


@pytest.mark.parametrize("unknown, token_cap", [(False, 1000), (True, 1000), (True, None)])
def test_legacy_cell_charges_are_retained_and_unrecorded_unknown_token_reservations_refuse_resume(tmp_path, unknown, token_cap):
    from experiments.harness.data import case_of
    case = case_of(synth.catalogue("legacy", records=1))
    cfg = Config.model_validate({"budget": {"calls": 1, "tokens": token_cap}})
    directory = tmp_path / "cells/base--legacy"
    directory.mkdir(parents=True)
    (directory / "attempt-001.started.json").write_text("{}")
    finished = {"spent": {"fresh": {"calls": 1, "input_tokens": 500, "output_tokens": 500, "unknown_usage": int(unknown)}}}
    original = json.dumps(finished)
    (directory / "attempt-001.finished.json").write_text(original)
    reader = Reader()
    args = (tmp_path, "study", "base", cfg, case, Provider(reader), "counted", {})
    if unknown and token_cap is not None:
        with pytest.raises(ValueError, match="unknown token usage without a durable budget charge"):
            st.execute_cell(*args)
        assert not (directory / "attempt-002.started.json").exists()
    else:
        assert st.execute_cell(*args) == ("completed", 0)
        assert json.loads((directory / "attempt-002.started.json").read_text())["prior_budget_spent"]["calls"] == 1
    assert reader.calls == []
    assert (directory / "attempt-001.finished.json").read_text() == original


def test_direct_cell_resume_refuses_an_unfinished_attempt_without_refunding_calls(tmp_path):
    from experiments.harness.data import case_of
    case = case_of(synth.catalogue("unfinished", records=1))
    directory = tmp_path / "cells/base--unfinished"
    directory.mkdir(parents=True)
    (directory / "attempt-001.started.json").write_text("{}")
    reader = Reader()
    with pytest.raises(ValueError, match="unfinished attempts"):
        st.execute_cell(tmp_path, "study", "base", Config(), case, Provider(reader), "uncounted", {})
    assert reader.calls == [] and not (directory / "attempt-002.started.json").exists()


def test_a_failed_cell_keeps_what_it_spent_and_the_study_goes_on(tmp_path):
    class Breaks(Reader):
        def complete(self, **kw):
            if len(self.calls) == 1:              # the second call of the run, the second of the first cell
                self.calls.append(kw)
                raise RuntimeError("worker died")
            return super().complete(**kw)
    path = write(tmp_path)
    out = tmp_path / "failing"
    result = go(path, out, Breaks(), variants=["fixed"], splits=["dev"])
    assert result["executed"] == {"failed": 1, "completed": 1}
    failed = next(f for f in (out / "cells").glob("fixed--*/attempt-001.finished.json") if json.loads(f.read_text())["status"] == "failed")
    record = json.loads(failed.read_text())
    assert record["spent"]["fresh"]["calls"] == 2
    assert record["spent"]["fresh"]["failed"] == 1 and "worker died" in record["error"]             # both calls stay counted: it cost its slot
    assert not (failed.parent / "result.json").exists()                                                # and nothing is sealed as a result
    assert {"code_sha256", "environment"} <= set(record)                                               # each attempt says what code ran it


def test_the_projection_bounds_recovery_by_its_tree_and_its_retries():
    from experiments.harness.data import case_of
    case = case_of(synth.catalogue("c", records=4))
    plain = st.project(case, Config())
    assert plain == {"calls": 1, "upper_bound_with_recovery": 1}
    tree = st.project(case, Config.model_validate({"recovery": {"subdivide": True, "retries": 1}}))
    assert tree["calls"] == 1 and tree["upper_bound_with_recovery"] == 2 * (2 ** 3 - 1)          # (1 + retries) x a binary tree of depth 2
    both = st.project(case, Config.model_validate({"sampling": {"n": 3, "temperature": 0.5}, "verification": {"model": True},
                                                    "evidence": {"mode": "quote"}, "merge": {"resolver": True}}))
    assert both["calls"] == 3 + len(case.gold) and both["upper_bound_with_recovery"] >= both["calls"]


def test_a_paired_effect_uses_only_groups_whose_cases_ran_in_both_arms_and_names_the_rest(tmp_path):
    import shutil
    cases = [synth.catalogue("a", split="fit", group="ga", seed=1), synth.catalogue("b", split="dev", group="g1", seed=2),
             synth.catalogue("c", split="dev", group="g1", seed=3), synth.catalogue("d", split="dev", group="g2", seed=4),
             synth.catalogue("e", split="dev", group="g3", seed=5)]
    (tmp_path / "data.json").write_text(json.dumps(synth.dataset(cases)))
    path = tmp_path / "study.json"
    path.write_text(json.dumps({"version": 1, "id": "pairs", "dataset": "data.json", "provider": {"url": "http://nowhere/v1/chat/completions", "model": "fake"},
                                "base": {}, "variants": {"quote": {"evidence": {"mode": "quote"}}},
                                "comparisons": [{"control": "base", "treatment": "quote", "factor": "evidence"}]}))
    out = tmp_path / "out"
    go(path, out, splits=["dev"])
    shutil.rmtree(out / "cells" / "quote--c")                    # the treatment arm never read one of group g1's two documents
    shutil.rmtree(out / "cells" / "quote--e")                    # and none of group g3
    report = st.compare_study(path, out, "dev")
    effect = report["comparisons"][0]
    assert effect["groups"] == 1 and effect["unpaired_groups"] == {"g1": "different cases ran in the two arms", "g3": "not run in the treatment"}
    assert report["variants"]["base"]["cases"] == 4 and report["variants"]["quote"]["cases"] == 2
    assert len(report["variants"]["quote"]["missing_cells"]) == 2                                         # the gaps are listed, not filled


def test_a_schema_kept_in_its_own_file_is_pinned_like_the_rest_of_the_case(tmp_path):
    dataset = synth.dataset([synth.catalogue(f"c{i}", split=split, records=4, seed=i) for i, split in enumerate(SPLITS)])
    for case in dataset["cases"]:
        case["schema"] = "schema.json"
    (tmp_path / "schema.json").write_text(json.dumps(synth.SCHEMA))
    (tmp_path / "data.json").write_text(json.dumps(dataset))
    path = tmp_path / "study.json"
    path.write_text(json.dumps({"version": 1, "id": "files", "dataset": "data.json", "provider": {"url": "http://nowhere/v1/chat/completions", "model": "fake"},
                                "base": {}, "variants": {}, "comparisons": []}))
    out = tmp_path / "out"
    go(path, out, splits=["dev"])
    changed = json.loads((tmp_path / "schema.json").read_text())
    changed["recordDescription"] = "One numbered entry of another catalogue."          # the extraction instructions changed, no pinned file did
    (tmp_path / "schema.json").write_text(json.dumps(changed))
    with pytest.raises(ValueError, match="another dataset"):
        go(path, out, splits=["dev"])
    with pytest.raises(ValueError, match="dataset changed"):
        st.compare_study(path, out, "dev")


def test_cells_made_by_different_code_are_named_in_the_report_whichever_code_reads_it(tmp_path, monkeypatch):
    path, out = write(tmp_path), tmp_path / "out"
    kwargs = {"execute": True, "uncounted": True, "splits": ["dev"]}
    same = Provider(Reader(), identity={"url": "http://a"})
    st.run_study(path, out, provider=same, variants=["base"], **kwargs)
    monkeypatch.setattr(st, "harness_pin", lambda root: {"other": True})
    st.run_study(path, out, provider=same, variants=["quote"], allow_code_change=True, **kwargs)
    report = st.compare_study(path, out, "dev")
    assert report["provenance"]["run_code_matches_current"] is False and len(report["provenance"]["cells_by_code_sha256"]) == 2
    monkeypatch.undo()
    assert st.compare_study(path, out, "dev")["provenance"]["run_code_matches_current"] is False       # still two versions, whoever is current
    assert sum(st.compare_study(path, out, "dev")["provenance"]["cells_by_code_sha256"].values()) == 4


def test_an_arm_that_found_nothing_stays_in_the_paired_effect_as_a_zero_and_costs_are_compared_on_the_matched_cases(tmp_path):
    path, out = write(tmp_path), tmp_path / "out"
    go(path, out, variants=["base"], splits=["dev"])
    go(path, out, Reader(raise_at=set(range(50))), variants=["quote"], splits=["dev"])       # every call of this arm fails: no record at all
    effect = st.compare_study(path, out, "dev")["comparisons"][0]
    assert effect["groups"] == 2 and effect["effect"]["mean"] < 0 and effect["unpaired_groups"] == {}    # two total misses are in, not dropped
    assert effect["cost_delta_as_if_cold"]["cases"] == 2 and effect["cost_delta_as_if_cold"]["calls"] == 0


def test_the_confidence_report_can_assess_the_final_variant_on_test_with_fit_and_calibration_frozen(tmp_path):
    reader = Reader(wrong={(41, "site"): "Zzz"}, logprob={(41, "site"): -3.0})
    path = write(tmp_path, base={"signals": {"top_logprobs": 3}}, variants={"quote": {"evidence": {"mode": "quote"}}}, comparisons=[], final="base")
    out = tmp_path / "out"
    go(path, out, reader, splits=["fit", "calibration", "dev", "test"], variants=["base"])
    report = st.confidence_study(path, out, "base", alpha=0.1, delta=0.1, assess="test")
    assert report["assessed_on"] == "test" and report["population"]["test"] > 0 and report["provenance"]["run_code_matches_current"] is True
    dev = st.confidence_study(path, out, "base", alpha=0.1, delta=0.1)
    assert report["models"]["fusion"] == dev["models"]["fusion"]                       # the same fit either way: test never touches it
    with pytest.raises(ValueError, match="final variant or the baseline"):
        st.confidence_study(path, out, "quote", alpha=0.1, delta=0.1, assess="test")


def test_a_confidence_model_is_not_fitted_from_one_class_and_the_raw_signals_are_still_reported(tmp_path):
    dataset = synth.dataset([synth.catalogue(f"c{i}", split=split, records=4, seed=i, first=40 + 10 * i) for i, split in enumerate(SPLITS)])
    (tmp_path / "data.json").write_text(json.dumps(dataset))
    path = tmp_path / "study.json"
    path.write_text(json.dumps({"version": 1, "id": "one-class", "dataset": "data.json", "provider": {"url": "http://nowhere/v1/chat/completions", "model": "fake"},
                                "base": {"signals": {"top_logprobs": 3}}, "variants": {}, "comparisons": []}))
    out = tmp_path / "out"
    go(path, out, Reader(wrong={(71, "site"): "Zzz"}, logprob={(71, "site"): -3.0}))          # the only error is in a dev case
    report = st.confidence_study(path, out, "base", alpha=0.1, delta=0.1)
    assert list(report["not_estimable"]) == ["fusion, calibrators and risk control"] and "only right values" in next(iter(report["not_estimable"].values()))
    assert "fused" not in report["scores"] and "models" not in report and report["calibration"] == {} and report["risk_control"] == {}
    assert report["scores"]["raw:p_first"]["auroc"] == 1.0 and report["scores"]["rank_baseline"]["n"] == report["population"]["dev"]   # descriptive
    out2 = tmp_path / "out2"
    go(path, out2, Reader(wrong={(41, "site"): "Zzz"}, logprob={(41, "site"): -3.0}))          # an error in fit, none in calibration
    half = st.confidence_study(path, out2, "base", alpha=0.1, delta=0.1)
    assert "fused" in half["scores"] and list(half["not_estimable"]) == ["calibrators and risk control"] and half["calibration"] == {}

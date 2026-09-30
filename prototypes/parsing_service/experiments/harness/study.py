"""Studies: a base configuration, variants of it, a bounded ablation matrix, sealed cells and one comparison.

python -m experiments.harness synth DATASET.json [--cases N --records R]
python -m experiments.harness run STUDY OUTPUT [--execute --uncounted --split S ... --variant V ...]
python -m experiments.harness compare STUDY OUTPUT REPORT [--split dev]
python -m experiments.harness confidence STUDY OUTPUT REPORT --variant V
python -m experiments.harness score DATASET CASE ARTIFACT.json [--accepted-only]

A study is one JSON file: the dataset, the provider, the scoring rules, the base configuration, variants as section
overrides of it, the declared one-factor comparisons and interactions, and (optionally) a combined variant with its
combined-minus-one ablations. `run` without `--execute` only prints the projected number of model calls; with it, cells
(variant x case) are sealed like the existing study cells, resumable and never overwritten. Only splits fit, calibration
and dev run by default; `test` runs only for the study's declared final variant and its baseline.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import platform
import random
import re
import sys
import time
from datetime import UTC, datetime
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

import numpy as np

from experiments.extraction.analyze import paired_interval
from experiments.extraction.manifest import differences, digest, read, write_new
from experiments.harness import confidence as cf
from experiments.harness import synth, extractbench
from experiments.harness.config import Config
from experiments.harness.data import Case, load_cases
from experiments.harness.evaluate import Eval, bootstrap, check_invariants, metrics, pool, score_case
from experiments.harness.extract import chunks_of, groups_of, retrieve
from experiments.harness.model import Allowance, OutputConstraintUnsupported, Provider, ResearchChat
from experiments.harness.production import adapt
from experiments.harness.run import run_case
from kei_exp.canonical import canonical_json

SAFE = re.compile(r"[a-zA-Z0-9_+-]+")
DEFAULT_SPLITS = ("fit", "calibration", "dev")


def merged(base: dict, override: dict) -> dict:
    """`override` laid over `base` section by section and key by key; anything that is not a mapping replaces."""
    out = dict(base)
    for key, value in override.items():
        out[key] = merged(base[key], value) if isinstance(value, dict) and isinstance(base.get(key), dict) else value
    return out


def expand(study: dict) -> dict[str, Config]:
    """Every configuration of the study, validated: the base, each variant, and (if declared) the combined variant and
    each combined-minus-one. An invalid or unsupported combination raises here, before any call."""
    base, variants = study["base"], study.get("variants", {})
    raw = {"base": base, **{name: merged(base, override) for name, override in variants.items()}}
    combined = study.get("combined")
    if combined:
        def combo(names: list[str]) -> dict:
            out = base
            for name in names:
                out = merged(out, variants[name])
            return out
        raw[combined["name"]] = combo(combined["from"])
        for member in combined["from"]:
            raw[f"{combined['name']}-minus-{member}"] = combo([m for m in combined["from"] if m != member])
    for name in raw:
        if not SAFE.fullmatch(name):
            raise ValueError(f"unsafe variant name {name!r}")
    return {name: Config.model_validate(cfg) for name, cfg in raw.items()}


def sections_changed(a: Config, b: Config) -> set[str]:
    return {key.split(".")[0] for key in differences(a.model_dump(mode="json"), b.model_dump(mode="json"))}


def comparisons_of(study: dict, configs: dict[str, Config]) -> list[dict]:
    """The declared comparisons plus the combined-minus-one ones, each checked to change exactly its declared factor."""
    found = list(study.get("comparisons", []))
    combined = study.get("combined")
    if combined:
        for member in combined["from"]:
            factor = sorted({key for key in study["variants"][member]})
            found.append({"control": f"{combined['name']}-minus-{member}", "treatment": combined["name"], "factor": factor})
    for comparison in found:
        wanted = {comparison["factor"]} if isinstance(comparison["factor"], str) else set(comparison["factor"])
        changed = sections_changed(configs[comparison["control"]], configs[comparison["treatment"]])
        if changed != wanted:
            raise ValueError(f"comparison {comparison} changes {sorted(changed)}, not exactly its declared factor {sorted(wanted)}")
    return found


def check_study(study: dict) -> tuple[dict[str, Config], list[dict]]:
    if study.get("version") != 1:
        raise ValueError("study version 1 required")
    if not SAFE.fullmatch(study["id"]):
        raise ValueError("unsafe study id")
    configs = expand(study)
    found = comparisons_of(study, configs)
    for interaction in study.get("interactions", []):
        one, two = (sections_changed(configs[interaction["baseline"]], configs[interaction[k]]) for k in ("a", "b"))
        both = sections_changed(configs[interaction["baseline"]], configs[interaction["ab"]])
        if one & two or both != one | two:
            raise ValueError(f"interaction {interaction}: a and b must change disjoint sections that ab changes together")
    if study.get("final") not in (None, *configs):
        raise ValueError("final names an unknown variant")
    return configs, found


def harness_pin(service: Path) -> dict:
    """The digest of every file a result depends on: the service, the harness, and the study helpers it imports."""
    files = [*service.joinpath("src").rglob("*.py"), *service.joinpath("src").rglob("*.json"), *service.joinpath("experiments/harness").glob("*.py"),
             service / "experiments/extraction/manifest.py", service / "experiments/extraction/analyze.py"]
    return {str(p.relative_to(service)): digest(p.read_bytes()) for p in sorted(files)}


def case_pin(case: Case) -> str:
    """One resolved case: its source snapshot, schema (wherever the dataset file got it from), gold, key, group and split."""
    return digest(canonical_json({"id": case.id, "group": case.group, "split": case.split, "source": [case.evidence.generation, case.evidence.digest],
                                  "schema": case.schema.model_dump(mode="json", by_alias=True), "gold": case.gold,
                                  "record_key": case.record_key, "exhaustive": case.exhaustive,
                                  **({"annotations": case.annotations} if case.annotations else {}),
                                  **({"record_scope": case.record_scope} if case.record_scope != "records" else {})}))


def _version(name: str) -> str | None:
    try:
        return version(name)
    except PackageNotFoundError:     # a library provided without its metadata: recorded as unknown, not a failed run
        return None


def environment() -> dict:
    """What else can change a result: the interpreter and the libraries that validate, fit and score (not the kernel)."""
    return {"python": sys.version.split()[0], "system": f"{platform.system()} {platform.machine()}",
            **{name: _version(name) for name in ("numpy", "scipy", "jsonschema", "pydantic", "requests")}}


# --- providers ----------------------------------------------------------------------------------------------------------

def make_provider(spec: dict, cache: Path) -> Provider:
    """The study's provider: the research chat, a served-tokenizer counter when the spec asks for one (vLLM's /tokenize),
    and the identity the server reports, pinned into every cache key."""
    import requests

    from kei_exp.kie.extract.tokens import counter_for
    chat = ResearchChat(url=spec["url"], model=spec["model"], timeout=spec.get("timeout", 600.0))
    counter = counter_for(chat) if spec.get("counter") == "vllm" else None
    base = spec["url"].split("/chat/completions")[0]
    served = None
    try:
        for entry in requests.get(base + "/models", timeout=30).json().get("data", []):
            if entry.get("id") == spec["model"]:
                served = {k: entry.get(k) for k in ("id", "max_model_len", "root") if k in entry}   # not `created`: a restart is not another model
    except (OSError, ValueError):
        pass
    return Provider(chat, cache, counter, {"url": spec["url"], "model": spec["model"], "served": served,
                                            "context_tokens": counter.context_tokens if counter else None,
                                            **({"deployment": spec["deployment"]} if "deployment" in spec else {})})


# --- projection and cells -----------------------------------------------------------------------------------------------

def project(case: Case, cfg: Config) -> dict:
    """An estimate of the fresh calls a case needs before recovery (chunks x groups x samples, one document-view call per
    chunk, one verification call per expected record; records are estimated by the gold's, which a run never sees) and an
    upper bound with recovery: every task retried `retries` times and, with `subdivide`, every failure halved to `depth`."""
    chunks = chunks_of(list(case.evidence.passages), cfg)
    groups = groups_of(case, cfg)
    tasks = sum(sum(c.retrieval != "skipped" for c in retrieve(chunks, g, case.schema.record_description, cfg)) for g in groups) * cfg.sampling.n
    extra = (len(chunks) if "document" in cfg.sampling.views else 0) + (len(case.gold) if cfg.verification.model else 0)
    per_task = (1 + cfg.recovery.retries) * ((2 ** (cfg.recovery.depth + 1) - 1) if cfg.recovery.subdivide else 1)
    resolver = len(case.gold) * len(case.schema.record_nodes) if cfg.merge.resolver else 0
    return {"calls": tasks + extra, "upper_bound_with_recovery": tasks * per_task + extra + resolver}     # verification and arbitration counts use the gold's record count


def _cell_budget_spent(directory: Path, cfg: Config) -> dict[str, int]:
    """Earlier attempts consume the same cell cap. Legacy unknown usage cannot silently refund token reservations."""
    for started in directory.glob("attempt-*.started.json"):
        if not started.with_name(started.name.replace(".started.json", ".finished.json")).exists():
            raise ValueError("unfinished attempts have unknown spend; reconcile them before resuming")
    previous = {"calls": 0, "tokens": 0}
    for finished in directory.glob("attempt-*.finished.json"):
        record = read(finished)
        fresh = record["spent"]["fresh"]
        previous["calls"] += fresh["calls"]
        charge = record.get("budget_spent")
        if charge is None:
            if cfg.budget.tokens is not None and fresh.get("unknown_usage", 0):
                raise ValueError("prior attempt has unknown token usage without a durable budget charge; reconcile it before resuming")
            previous["tokens"] += fresh["input_tokens"] + fresh["output_tokens"]
        else:
            previous["tokens"] += charge["tokens"]
    return previous


def execute_cell(out: Path, study_sha: str, name: str, cfg: Config, case: Case, provider: Provider, admission: str,
                 run_pin: dict) -> tuple[str, int]:
    """Run one sealed cell; returns its status and the fresh model calls this attempt spent (failed attempts included). A
    cell the study's call allowance cut short is not sealed: it is a smaller experiment than its configuration names."""
    directory = out / "cells" / f"{name}--{case.id}"
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        pin = {"study_sha256": study_sha, "variant": name, "case": case.id, "config_sha256": cfg.sha256(), "case_sha256": case_pin(case),
               "source": {"generation": case.evidence.generation, "digest": case.evidence.digest}}
        if (directory / "pin.json").exists():
            if read(directory / "pin.json") != pin:
                raise ValueError("cell belongs to a different study, configuration or source")
        else:
            write_new(directory / "pin.json", pin)
        if (directory / "result.json").exists():
            done = read(directory / "result.json")
            if digest(canonical_json(done["artifact"])) != done["execution"]["artifact_sha256"]:
                raise ValueError("a sealed artifact changed")
            return "retained_completed", 0
        previous = _cell_budget_spent(directory, cfg)
        attempt = len(list(directory.glob("attempt-*.started.json"))) + 1
        prefix = directory / f"attempt-{attempt:03}"
        write_new(prefix.with_suffix(".started.json"), {"at": datetime.now(UTC).isoformat(), **pin, "prior_budget_spent": previous})
        clock = time.monotonic()
        meter = provider.view(max(0, cfg.budget.calls - previous["calls"]),
                              None if cfg.budget.tokens is None else max(0, cfg.budget.tokens - previous["tokens"]))
        denied = provider.allowance.denied if provider.allowance else 0
        artifact, terminal = None, {}
        try:
            artifact = run_case(case, cfg, meter, admission=admission)
            terminal = {"status": "completed", "artifact_sha256": digest(canonical_json(artifact))}
            if provider.allowance and provider.allowance.denied > denied:
                artifact, terminal = None, {"status": "stopped_by_study_budget", "error": "the study's call allowance ran out during this cell"}
        except OutputConstraintUnsupported as error:
            terminal = {"status": "unsupported", "error": str(error)[:300], "prerequisite": "a server that supports response_format json_schema"}
        except Exception as error:   # a failed cell keeps its reason; the rest of the study goes on
            terminal = {"status": "failed", "error_type": type(error).__name__, "error": str(error)[:500]}
        terminal |= {"attempt": attempt, "wall_seconds": round(time.monotonic() - clock, 3),
                     "spent": meter.spent, "budget_spent": meter.budget_spent, **run_pin}
        if artifact is not None:
            write_new(directory / "result.json", {"artifact": artifact, "execution": terminal})   # result and seal commit together
        write_new(prefix.with_suffix(".finished.json"), terminal)
        return terminal["status"], meter.spent["fresh"]["calls"]


def cells_to_run(study: dict, configs: dict[str, Config], cases: list[Case], splits: list[str], variants: list[str] | None) -> list[tuple]:
    final = study.get("final")
    plan = []
    for name, cfg in configs.items():
        if variants and name not in variants:
            continue
        for case in cases:
            if case.split not in splits or (case.split == "test" and name not in ("base", final)):
                continue
            plan.append((name, cfg, case))
    random.Random(study.get("order_seed", 20260930)).shuffle(plan)
    return plan


def pins_of(study_path: Path, study: dict, provider_identity: dict | None) -> dict:
    """Everything a result depends on that the study file does not spell out: the resolved dataset (source, schema and gold of
    every case, wherever its file got them), the scoring rules, the code, the environment and the provider's reported identity."""
    cases = load_cases(study_path.parent / study["dataset"])
    identity = {key: value for key, value in study.items() if key != "budget"}     # a larger allowance continues the same experiment
    return {"study_sha256": digest(canonical_json(identity)), "dataset_sha256": digest(canonical_json(sorted(case_pin(c) for c in cases))),
            "evaluation_sha256": Eval(**study.get("evaluation", {})).sha256(), "provider": provider_identity,
            "code": harness_pin(Path(__file__).resolve().parents[2]), "environment": environment()}


def verify_output(study_path: Path, out: Path, study: dict, *, rescore: bool = False) -> dict:
    """The output's manifest, provided the study file, dataset and scoring rules are the ones the cells were made under.
    Code and environment may have moved on (a newer scorer may re-score sealed cells); the caller reports whether they did."""
    if not (out / "manifest.json").exists():
        raise ValueError("no manifest: this is not an output directory of a run")
    manifest = read(out / "manifest.json")
    now = pins_of(study_path, study, None)
    for key in ("study_sha256", "dataset_sha256", *(() if rescore else ("evaluation_sha256",))):
        if manifest[key] != now[key]:
            raise ValueError(f"{key.split('_')[0]} changed since this output was made; results would be attributed to a different experiment")
    return manifest


def run_study(study_path: Path, out: Path, *, execute: bool, uncounted: bool, splits: list[str], variants: list[str] | None,
              provider: Provider | None = None, force: bool = False, allow_code_change: bool = False) -> dict:
    study = json.loads(study_path.read_text())
    configs, _ = check_study(study)
    cases = load_cases(study_path.parent / study["dataset"])
    if "test" in splits and not study.get("final"):
        raise ValueError("the test split runs only for a declared final variant: set `final` in the study")
    plan = cells_to_run(study, configs, cases, splits, variants)
    todo = [(name, cfg, case) for name, cfg, case in plan if not (out / "cells" / f"{name}--{case.id}" / "result.json").exists()]
    projections = [project(case, cfg) for _, cfg, case in todo]
    projected = sum(p["calls"] for p in projections)
    limit = study.get("budget", {}).get("max_calls")
    report = {"cells": len(plan), "cells_to_run": len(todo), "projected_calls": projected,
              "upper_bound_with_recovery": sum(p["upper_bound_with_recovery"] for p in projections), "budget": limit,
              "note": "estimates for the cells not yet sealed; verification and arbitration counts use the gold's record count "
                      "(a run never sees it); without --execute nothing is sent"}
    if not execute:
        return report
    if limit is not None and projected > limit and not force:
        raise ValueError(f"projected {projected} calls exceed the study budget of {limit}; raise the budget or select fewer cells")
    if provider is None:
        provider = make_provider(study["provider"], out / "cache")
        if provider.counter is None and not uncounted:
            raise ValueError("this provider gives no served-tokenizer count, so budgets are character limits, which do not prove fit; "
                             "pass --uncounted to accept that, or set provider.counter to vllm")
    pins = pins_of(study_path, study, provider.identity)
    if (out / "manifest.json").exists():
        existing = read(out / "manifest.json")
        for key in ("study_sha256", "dataset_sha256", "evaluation_sha256", "provider"):
            if existing[key] != pins[key]:
                raise ValueError(f"this output directory belongs to another {key.split('_')[0]}; results would mix experiments")
        if (existing["code"] != pins["code"] or existing["environment"] != pins["environment"]) and not allow_code_change:
            raise ValueError("harness or service code, or the environment, changed since this output began; "
                             "start a new output or pass --allow-code-change")
    else:
        write_new(out / "manifest.json", {"study": study, **pins})
    run_pin = {"code_sha256": digest(canonical_json(pins["code"])), "environment": pins["environment"]}
    unfinished = [p for p in (out / "cells").glob("*/attempt-*.started.json")
                  if not p.with_name(p.name.replace(".started.json", ".finished.json")).exists()]
    if unfinished:
        raise ValueError("unfinished attempts have unknown spend; reconcile them before resuming: " +
                         ", ".join(str(p.relative_to(out)) for p in unfinished))
    if limit is not None:    # one allowance for the study: what its earlier attempts spent is gone, and no retry can overrun it
        before = sum(read(f).get("spent", {}).get("fresh", {}).get("calls", 0) for f in (out / "cells").glob("*/attempt-*.finished.json"))
        provider.allowance = Allowance(max(0, limit - before))
    statuses: dict[str, int] = {}
    spent = 0
    for name, cfg, case in plan:
        if provider.allowance is not None and provider.allowance.remaining <= 0 and (
                not (out / "cells" / f"{name}--{case.id}" / "result.json").exists()):
            statuses["not_run_budget_spent"] = statuses.get("not_run_budget_spent", 0) + 1
            continue
        status, calls = execute_cell(out, pins["study_sha256"], name, cfg, case, provider, "counted" if provider.counter else "uncounted", run_pin)
        spent += calls
        statuses[status] = statuses.get(status, 0) + 1
        print(f"{name}--{case.id}: {status}", flush=True)
    return {**report, "executed": statuses, "fresh_calls_spent": spent}


# --- comparison -----------------------------------------------------------------------------------------------------------

def load_cells(out: Path, configs: dict[str, Config], cases: list[Case], rules: Eval, splits: list[str], manifest: dict) -> dict:
    """Score every sealed cell: {variant: {split: {"groups": {group: counts}, "cases": {group: {case ids}}, "outcomes": [...],
    "costs": {case: cost as if cold}, "code": {code digest: cells}, "attempts": everything the cells' attempts spent}}}.
    A cell is refused unless its pin, its configuration, its case and its source are the ones now defined."""
    result: dict[str, dict[str, dict]] = {}
    for name in configs:
        for case in cases:
            if case.split not in splits:
                continue
            slot = result.setdefault(name, {}).setdefault(case.split, {"groups": {}, "cases": {}, "outcomes": [], "missing": [], "failed": [],
                                                                       "costs": {}, "code": {}, "requests": {}, "documents": {}, "attempts": {"fresh_calls": 0, "attempts": 0, "not_sealed": 0}})
            directory = out / "cells" / f"{name}--{case.id}"
            for finished in directory.glob("attempt-*.finished.json"):      # every attempt's spending, sealed or not
                record = read(finished)
                slot["attempts"]["fresh_calls"] += record.get("spent", {}).get("fresh", {}).get("calls", 0)
                slot["attempts"]["attempts"] += 1
                slot["attempts"]["not_sealed"] += record["status"] != "completed"
            if not (directory / "result.json").exists():
                finished = sorted(directory.glob("attempt-*.finished.json"))
                slot["missing" if not finished else "failed"].append({"case": case.id, **(read(finished[-1]) if finished else {"status": "not_run"})})
                continue
            pin = read(directory / "pin.json")
            if pin["study_sha256"] != manifest["study_sha256"]:
                raise ValueError(f"{directory.name}: made under a different study")
            if pin["case_sha256"] != case_pin(case):
                raise ValueError(f"{directory.name}: the case's source, schema or gold changed since the run")
            done = read(directory / "result.json")
            artifact = done["artifact"]
            if digest(canonical_json(artifact)) != done["execution"]["artifact_sha256"]:
                raise ValueError(f"unsealed or changed result: {directory.name}")
            if artifact["config_sha256"] != configs[name].sha256():
                raise ValueError(f"{directory.name}: made under another configuration than variant {name!r} now defines")
            if artifact["source"] != {"generation": case.evidence.generation, "digest": case.evidence.digest}:
                raise ValueError(f"{directory.name}: the source snapshot changed since the run")
            counts, outcomes = score_case(case, artifact, rules)
            slot["documents"][case.id] = {"group": case.group, "counts": counts, "metrics": metrics(counts),
                                         "coverage": artifact.get("coverage"), "issues": artifact.get("issues", []),
                                         "requests": artifact.get("requests", [])}
            slot["costs"][case.id] = {k: counts.get(f"fresh_{k}", 0) + counts.get(f"replayed_{k}", 0)
                                      for k in ("calls", "input_tokens", "output_tokens", "seconds")}
            slot["requests"][case.id] = set(artifact.get("requests", []))
            code = done["execution"].get("code_sha256")
            slot["code"][code] = slot["code"].get(code, 0) + 1
            slot["groups"][case.group] = pool([slot["groups"].get(case.group, {}), counts])
            slot["cases"].setdefault(case.group, set()).add(case.id)
            for o in outcomes:
                slot["outcomes"].append({**o, "group": case.group, "split": case.split})
    return result


def group_f1(counts: dict) -> float | None:
    return metrics(counts)["field"]["f1"]


def provenance_of(manifest: dict, slots: list[dict]) -> dict:
    """What made the cells a report reads: the code each cell ran under against the code now, the environment, the provider
    the run reported, and the scorer. A report over cells made by more than one code version says so."""
    current = digest(canonical_json(harness_pin(Path(__file__).resolve().parents[2])))
    made: dict[str | None, int] = {}
    for slot in slots:
        for code, n in slot["code"].items():
            made[code] = made.get(code, 0) + n
    return {"run_code_matches_current": set(made) <= {current}, "cells_by_code_sha256": made, "current_code_sha256": current,
            "manifest_code_matches_current": digest(canonical_json(manifest["code"])) == current,
            "environment_matches_current": manifest["environment"] == environment(), "environment_at_run": manifest["environment"],
            "provider": manifest["provider"], "scorer_sha256": digest((Path(__file__).parent / "evaluate.py").read_bytes())}


def compare_study(study_path: Path, out: Path, split: str, *, rescore: bool = False) -> dict:
    study = json.loads(study_path.read_text())
    configs, comparisons = check_study(study)
    if split == "test" and not study.get("final"):
        raise ValueError("test results are reported only for a declared final variant; the split was not used to select")
    manifest = verify_output(study_path, out, study, rescore=rescore)
    cases = load_cases(study_path.parent / study["dataset"])
    rules = Eval(**study.get("evaluation", {}))
    scored = load_cells(out, configs, cases, rules, [split], manifest)
    shown = {n: s[split] for n, s in scored.items() if split in s and (split != "test" or n in ("base", study.get("final")))}
    variants = {}
    for name, slot in shown.items():
        total = pool(list(slot["groups"].values()))
        variants[name] = {"config_sha256": configs[name].sha256(), "documents": slot["documents"], "groups": len(slot["groups"]),
                          "cases": sum(len(ids) for ids in slot["cases"].values()), "attempt_spend": slot["attempts"],
                          "missing_cells": slot["missing"],
                          "failed_cells": slot["failed"], "invariant_violations": check_invariants(total), "metrics": metrics(total),
                          "intervals": {key: bootstrap(slot["groups"], lambda t, key=key: metrics(t)["field"][key]) for key in ("precision", "recall", "f1")}}
        cost = variants[name]["metrics"]["cost"]
        variants[name]["cost_as_if_cold"] = {k: cost["fresh"][k] + cost["replayed"][k] for k in cost["fresh"]}
        price = study["provider"].get("price_per_million_tokens")        # an estimate only where the study states a price
        if price:
            cold = variants[name]["cost_as_if_cold"]
            variants[name]["estimated_cost_as_if_cold"] = (cold["input_tokens"] * price["input"] + cold["output_tokens"] * price["output"]) / 1e6
    effects = []
    for c in comparisons:
        if c["control"] not in shown or c["treatment"] not in shown:
            continue
        control, treatment = shown[c["control"]]["groups"], shown[c["treatment"]]["groups"]
        same = shown[c["control"]]["cases"], shown[c["treatment"]]["cases"]
        paired = [g for g in control if g in treatment and same[0][g] == same[1][g]      # the same documents ran in both arms
                  and group_f1(control[g]) is not None and group_f1(treatment[g]) is not None]
        deltas = [group_f1(treatment[g]) - group_f1(control[g]) for g in paired]
        unpaired = {g: "not run in the control" if g not in control else "not run in the treatment" if g not in treatment
                    else "different cases ran in the two arms" if same[0][g] != same[1][g] else "field F1 undefined"
                    for g in sorted((set(control) | set(treatment)) - set(paired))}
        matched = sorted({i for g in paired for i in same[0][g]})     # cost is compared on the very cases the quality effect is
        costs = shown[c["control"]]["costs"], shown[c["treatment"]]["costs"]
        sent = shown[c["control"]]["requests"], shown[c["treatment"]]["requests"]
        only = [sum(len(sent[a].get(i, set()) - sent[b].get(i, set())) for i in matched) for a, b in ((0, 1), (1, 0))]
        effects.append({**c, "unit": "group", "metric": "field F1", "groups": len(paired), "unpaired_groups": unpaired,
                        "effect": paired_interval(deltas),
                        "requests": {"control_only": only[0], "treatment_only": only[1], "identical": not any(only) and bool(matched),
                                     "note": "identical: the configurations differ but every request sent was the same, so the treatment "
                                             "either changed only what happens after the model (aggregation, gate, alignment) or did nothing"},
                        "cost_delta_as_if_cold": {"cases": len(matched), **{k: round(sum(costs[1][i][k] for i in matched) - sum(costs[0][i][k] for i in matched), 6)
                                                                            for k in ("calls", "input_tokens", "output_tokens", "seconds")}}})
    interactions = []
    for it in study.get("interactions", []):
        if not all(it[k] in shown for k in ("baseline", "a", "b", "ab")):
            continue
        arms = [shown[it[k]] for k in ("baseline", "a", "b", "ab")]
        common = {g for g in set.intersection(*(set(a["groups"]) for a in arms)) if len({frozenset(a["cases"][g]) for a in arms}) == 1}
        deltas = []
        for g in sorted(common):
            f = {k: group_f1(shown[it[k]]["groups"][g]) for k in ("baseline", "a", "b", "ab")}
            if all(v is not None for v in f.values()):
                deltas.append(f["ab"] - f["a"] - f["b"] + f["baseline"])
        interactions.append({**it, "unit": "group", "metric": "field F1 difference of differences", "groups": len(deltas), "effect": paired_interval(deltas)})
    return {"study": study["id"], "split": split, "variants": variants, "comparisons": effects, "interactions": interactions,
            "provenance": {**provenance_of(manifest, list(shown.values())), "evaluation_version": 2,
                           "original_evaluation_sha256": manifest["evaluation_sha256"], "rescored": rescore},
            "limits": ["Documents of one group are resampled together; intervals over few groups are descriptive, not evidence of generalisation.",
                       "Synthetic or development data test the implementation, not real-world superiority.",
                       "Model calls are not deterministic even at temperature 0; repeats would measure serving variability.",
                       "Cost is real inference plus replayed replies at their recorded cost, for sealed cells only; what failed or unsealed "
                       "attempts spent is `attempt_spend`, and cost deltas use the cases both arms completed.",
                       "Model-seconds are as recorded when each reply was made, under whatever load the server had then: compare "
                       "calls and tokens, not seconds, across arms."],
            "selection": "none: this report names no winner; a variant is chosen on split dev alone and reported once on test"}


def confidence_study(study_path: Path, out: Path, variant: str, alpha: float, delta: float, target: str = "value",
                     assess: str = "dev") -> dict:
    """Fusion is fit on split `fit`, calibrators and thresholds on `calibration`, and everything is reported on `assess`:
    `dev`, or `test` for the declared final variant or the baseline only (the fitting and calibration stay frozen on theirs)."""
    study = json.loads(study_path.read_text())
    configs, _ = check_study(study)
    if assess == "test" and (not study.get("final") or variant not in ("base", study["final"])):
        raise ValueError("the test split is assessed only for the declared final variant or the baseline")
    manifest = verify_output(study_path, out, study)
    cases = load_cases(study_path.parent / study["dataset"])
    splits = ("fit", "calibration", assess)
    scored = load_cells(out, {variant: configs[variant]}, cases, Eval(**study.get("evaluation", {})), list(splits), manifest)[variant]
    rows = {s: cf.table(scored[s]["outcomes"], target) for s in splits if s in scored}
    for split in splits:
        if not rows.get(split):
            raise ValueError(f"no scored values in split {split!r}; run the study for that split first")
    y = {s: np.array([r["y"] for r in rows[s]]) for s in rows}
    lacking = {s: "only right values" if y[s].all() else "only wrong values" for s in ("fit", "calibration") if len(set(y[s].tolist())) < 2}
    fusion = None if "fit" in lacking else cf.fit_fusion(rows["fit"])

    def ranked(subset: list[dict]) -> np.ndarray:    # a row with no signal at all ranks last: it has no baseline score
        return np.array([cf.rank_score(r["signals"]) or 0.0 for r in subset])
    report: dict[str, Any] = {"study": study["id"], "variant": variant, "target": target, "assessed_on": assess,
                              "population": {s: len(rows[s]) for s in rows}, "unit": "group",
                              "provenance": provenance_of(manifest, list(scored.values())),
                              "scores": {"rank_baseline": cf.evaluate(ranked(rows[assess]), y[assess])}, "calibration": {}, "risk_control": {},
                              "not_estimable": {}}
    for signal in ("verbalized", "p_first", "p_mean", "margin", "agreement", "view_agreement", "align", "verdict"):
        usable = [r for r in rows[assess] if r["signals"].get(signal) is not None]
        report["scores"][f"raw:{signal}"] = {"coverage_of_signal": len(usable) / len(rows[assess]), **(cf.evaluate(
            np.array([r["signals"][signal] for r in usable]), np.array([r["y"] for r in usable])) if usable else {})}
    if fusion is None:     # a model with one class to learn from returns a constant, which is no result
        report["not_estimable"]["fusion, calibrators and risk control"] = f"split fit has {lacking['fit']}: nothing to fit"
    else:
        def fused(subset: list[dict]) -> np.ndarray:
            return fusion.score([r["signals"] for r in subset])
        shown = fused(rows[assess])
        report["scores"]["fused"] = {**cf.evaluate(shown, y[assess]), "intervals": {
            name: cf.group_interval(rows[assess], shown, metric) for name, metric in (("auroc", cf.auroc), ("brier", cf.brier), ("aurc", cf.aurc))}}
        report["models"] = {"fusion": fusion.dump(), "fit_rows": len(rows["fit"])}
        if "calibration" in lacking:
            report["not_estimable"]["calibrators and risk control"] = f"split calibration has {lacking['calibration']}: nothing to calibrate"
        else:
            for calibrator in (cf.Platt(), cf.Isotonic()):
                calibrator.fit(fused(rows["calibration"]), y["calibration"])
                report["calibration"][type(calibrator).__name__.lower()] = cf.evaluate(calibrator.predict(shown), y[assess])
                report["models"][type(calibrator).__name__.lower()] = calibrator.dump()
            for method in ("ltt", "crc"):
                certificate = cf.certify(rows["calibration"], fused(rows["calibration"]), alpha=alpha, delta=delta, method=method)
                if certificate["certified"]:
                    certificate["assessed"] = cf.micro_macro(rows[assess], shown, certificate["threshold"])
                report["risk_control"][method] = certificate
    report["note"] = ("Research diagnostics only: no formal certification is claimed by this screening harness. "
                      f"Fusion was fit on split fit, calibrators and thresholds on calibration, everything reported on {assess}. "
                      "Raw-signal scores are descriptive: intervals over few groups are not inference.")
    return report


# --- command line ---------------------------------------------------------------------------------------------------------

def synth_dataset(path: Path, cases: int, records: int) -> None:
    """A synthetic dataset, one group per case; every split gets at least one case (so at least four)."""
    if cases < 4:
        raise ValueError("a dataset needs at least four cases: one per split")
    counts = {"test": max(1, cases // 8), "calibration": max(1, cases // 4), "dev": max(1, cases // 4)}
    counts["fit"] = cases - sum(counts.values())
    layout = [split for split in ("fit", "calibration", "dev", "test") for _ in range(counts[split])]
    write_new(path, synth.dataset([synth.catalogue(f"case{i:03}", split=split, records=records, seed=i) for i, split in enumerate(layout)]))


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    s = commands.add_parser("synth")
    s.add_argument("dataset", type=Path)
    s.add_argument("--cases", type=int, default=16)
    s.add_argument("--records", type=int, default=6)
    r = commands.add_parser("run")
    r.add_argument("study", type=Path)
    r.add_argument("output", type=Path)
    r.add_argument("--execute", action="store_true", help="send model calls; without it only the projection is printed")
    r.add_argument("--uncounted", action="store_true", help="accept character budgets when the provider has no /tokenize")
    r.add_argument("--split", action="append", choices=("fit", "calibration", "dev", "test"))
    r.add_argument("--variant", action="append")
    r.add_argument("--force", action="store_true", help="run although the projection exceeds the study budget")
    r.add_argument("--allow-code-change", action="store_true", help="continue an output made by other harness or service code")
    adapter = commands.add_parser("extractbench", help="prepare pinned development PDFs; holdout is never ingested")
    adapter.add_argument("selection", type=Path)
    adapter.add_argument("snapshot", type=Path)
    adapter.add_argument("output", type=Path)
    adapter.add_argument("--smoke", action="store_true")
    c = commands.add_parser("compare")
    c.add_argument("study", type=Path)
    c.add_argument("output", type=Path)
    c.add_argument("report", type=Path)
    c.add_argument("--split", default="dev", choices=("fit", "calibration", "dev", "test"))
    c.add_argument("--rescore", action="store_true", help="new versioned score of original sealed predictions; never reruns inference")
    f = commands.add_parser("confidence")
    f.add_argument("study", type=Path)
    f.add_argument("output", type=Path)
    f.add_argument("report", type=Path)
    f.add_argument("--variant", required=True)
    f.add_argument("--alpha", type=float, default=0.1)
    f.add_argument("--delta", type=float, default=0.1)
    f.add_argument("--target", default="value", choices=("value", "supported"))
    f.add_argument("--assess", default="dev", choices=("dev", "test"), help="the split reported on; test only for the final variant or the baseline")
    p = commands.add_parser("score", help="score a saved production artifact (Article or Catalog) against a case's gold")
    p.add_argument("dataset", type=Path)
    p.add_argument("case")
    p.add_argument("artifact", type=Path)
    p.add_argument("--accepted-only", action="store_true", help="leave out values the artifact kept only as proposals")
    args = parser.parse_args(argv)
    if args.command == "extractbench":
        manifest = extractbench.prepare(args.selection, args.snapshot, args.output, smoke=args.smoke)
        print(json.dumps({k: manifest[k] for k in ("selected_documents", "ingested_documents", "failures")}, indent=2))
    elif args.command == "score":
        case = next(c for c in load_cases(args.dataset) if c.id == args.case)
        counts, _ = score_case(case, adapt(json.loads(args.artifact.read_text()), case), Eval(excluded_flags=("proposed",) if args.accepted_only else ()))
        print(json.dumps({"case": case.id, "invariant_violations": check_invariants(counts), "metrics": metrics(counts)}, indent=1))
    elif args.command == "synth":
        synth_dataset(args.dataset, args.cases, args.records)
    elif args.command == "run":
        print(json.dumps(run_study(args.study, args.output, execute=args.execute, uncounted=args.uncounted,
                                   splits=args.split or list(DEFAULT_SPLITS), variants=args.variant, force=args.force,
                                   allow_code_change=args.allow_code_change), indent=1))
    elif args.command == "compare":
        report = compare_study(args.study, args.output, args.split, rescore=args.rescore)
        write_new(args.report, report)
        for name, v in report["variants"].items():
            field = v["metrics"]["field"]
            print(f"{name:24} F1 {field['f1']}  P {field['precision']}  R {field['recall']}  groups {v['groups']}  "
                  f"calls(as if cold) {v['cost_as_if_cold']['calls']}")
    else:
        report = confidence_study(args.study, args.output, args.variant, args.alpha, args.delta, args.target, args.assess)
        write_new(args.report, report)
        print(json.dumps({"population": report["population"], "risk_control": {k: v.get("reason", "certified") for k, v in report["risk_control"].items()}}, indent=1))


if __name__ == "__main__":
    main()

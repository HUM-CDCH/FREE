"""The runner: one case under one configuration becomes one prediction artifact.

Stages, each a plain function from its module: chunk and retrieve and decompose (`extract`), read (`extract` + `model`),
resolve and check evidence (`evidence`), join records (`merge`), optionally vote over samples and compare views,
optionally resolve conflicts and verify with a model (`merge`, `evidence`), gate, and assemble signals (`signals`). The
artifact keeps the coverage ledger, every call, the raw and normalised values, and each field's contributors; it never
claims completeness beyond what the ledger shows, and recall stays unmeasured.
"""
from __future__ import annotations

import time
from collections import defaultdict
from dataclasses import asdict
from typing import Any

from experiments.harness import evidence as ev
from experiments.harness import extract as ex
from experiments.harness import merge as mg
from experiments.harness import signals as sg
from experiments.harness.config import HARNESS_VERSION, PROMPT_VERSION, Config
from experiments.harness.data import Case
from experiments.harness.model import Metered
from kei_exp.kie.extract.stages import contains


def meter_for(provider, cfg: Config) -> Metered:
    """A case's view of the provider under the configuration's call and token budgets."""
    return provider.view(cfg.budget.calls, cfg.budget.tokens)


def _check_provider(cfg: Config, meter: Metered) -> None:
    sampling = cfg.sampling.temperature or cfg.sampling.seed is not None or cfg.signals.top_logprobs
    if sampling and not getattr(meter.provider.chat, "accepts_sampling", False):
        raise ValueError("this provider takes no temperature, seed or token-probability request; use the research adapter")


def _failed(checks: dict | None, flags: list[str]) -> bool | None:
    """A deterministic check failed: the value does not conform, its citation does not resolve, or its printed form is not
    in the cited text. None when nothing was checked."""
    if "type_mismatch" in flags:
        return True
    if not checks:
        return None
    return any(checks[key] is False for key in ("type_ok", "cited_exists", "literal"))


def _slot(members: list[tuple[int, dict]], sample: int, name: str, chunks: list[str], coverage: mg.Coverage) -> dict | str | None:
    """What one sample says of one field of a record: its consolidated field; ABSENT where it read every chunk of the record
    for this field and found no such record; None where it did not, so its answer is missing and never counts as dissent."""
    found = next((rec["fields"] for s, rec in members if s == sample), None)
    if found is not None:
        return found[name]
    return mg.ABSENT if all(coverage.covered(c, name, sample) for c in chunks) else None


def _agree(final: dict, records: list[tuple], case: Case) -> dict[str, bool | None]:
    """Cross-view agreement: whether the document-guided listing, in its own labels, states each final value in the
    listing record that shares most values with it. Missing (None) when that view read no such chunk."""
    if not records:
        return {}
    facts = [[value for _, value in record["facts"]] for record in records]
    values = {name: f["value"] for name, f in final["fields"].items() if f["status"] == "value"}

    def found(pool: list[str], value: Any) -> bool:
        return all(any(contains(text, str(item)) for text in pool) for item in (value if isinstance(value, list) else [value]))
    shared = [sum(found(pool, v) for v in values.values()) for pool in facts]
    best = max(range(len(facts)), key=lambda i: (shared[i], -i))
    return {name: found(facts[best], v) if shared[best] else False for name, v in values.items()}


def run_case(case: Case, cfg: Config, meter: Metered, *, admission: str = "uncounted") -> dict[str, Any]:
    """Run `case` under `cfg` against `meter`'s provider. A refused configuration raises before any call; a failed or
    refused region is a ledger row and a status, never a silent gap."""
    case = case.inference()  # gold, split labels and evaluation rules cannot reach any inference stage
    started = time.monotonic()
    groups = ex.groups_of(case, cfg)
    _check_provider(cfg, meter)
    nodes = case.schema.record_nodes
    by_name = {node.name: node for node in nodes}
    chunks = ex.chunks_of(list(case.evidence.passages), cfg)
    by_chunk = {c.id: c for c in chunks}
    ledger: dict[tuple[str, int], dict] = {}
    jobs, keys = [], []
    for g, group in enumerate(groups):
        for chunk in ex.retrieve(chunks, group, case.schema.record_description, cfg):
            primary = chunk.context.primary
            row = {"chunk": chunk.id, "group": g, "retrieval": chunk.retrieval, "score": chunk.score,
                   "first": primary[0].id if primary else None, "last": primary[-1].id if primary else None,
                   "required_passages": [p.id for p in primary], "calls": 0}
            ledger[(chunk.id, g)] = row
            if chunk.retrieval == "skipped":
                row["status"] = "not_retrieved"
            elif len(ex.render(chunk.context.passages, cfg.input.mode)) > cfg.budget.input_chars:
                row |= {"status": "refused", "reason": "the chunk's text exceeds budget.input_chars and is never cut"}
            else:
                for sample in range(cfg.sampling.n):
                    task = ex.Task(chunk.id, g, sample)
                    jobs.append(lambda t=task, c=chunk, gr=group: ex.with_recovery(t, c, c.context.primary, gr, case, cfg, meter))
                    keys.append((chunk.id, g, sample))
    results: dict[tuple, list[ex.Result]] = defaultdict(list)
    for key, batch in zip(keys, ex.run_tasks(jobs, cfg), strict=True):
        results[key] += batch
    read: dict[tuple[str, int, int], frozenset[str]] = {}
    for (chunk_id, g), row in ledger.items():
        if "status" in row:
            continue
        samples = [(s, results[(chunk_id, g, s)]) for s in range(cfg.sampling.n)]
        for s, batch in samples:    # a field is read when every task that asked for it succeeded
            read[(chunk_id, g, s)] = frozenset({n for r in batch for n in r.fields} - {n for r in batch if not r.ok for n in r.fields})
        rs = [r for _, batch in samples for r in batch]
        row["regions"] = [{"task": r.task.id, "sample": r.task.sample, "passages": list(r.passages),
                           "fields": list(r.fields), "status": "processed" if r.ok else "failed", "error": r.error}
                          for r in rs]
        whole = any(all(r.ok for r in batch) for _, batch in samples)
        row |= {"status": "processed" if whole else "partial" if any(r.ok for r in rs) else "failed",
                "calls": sum(len(r.calls) for r in rs),
                "errors": [{"task": r.task.id, "error": r.error, "recovered": bool(r.recovered)} for r in rs if not r.ok][:5],
                "recovered_from": [r.recovered for r in rs if r.recovered]}
    coverage = mg.Coverage([c.id for c in chunks], read, [[n.name for n in group] for group in groups])
    calls = [call for batch in results.values() for r in batch for call in r.calls]
    replies = sum(r.replies for batch in results.values() for r in batch)
    valid = sum(r.valid for batch in results.values() for r in batch)

    candidates: list[dict] = []
    for (chunk_id, g, sample), batch in results.items():
        for result in batch:
            if not result.ok:
                continue    # a failed region is on the ledger; the valid regions beside it keep their records
            for cand in result.records:
                shown = tuple(p for p in by_chunk[chunk_id].context.passages if p.id in cand["shown"])
                per_field = {}
                for name, f in cand["fields"].items():
                    f["entries"] = per_field[name] = ev.entries_for(f, f["value"], case, shown, cfg)
                if cfg.evidence.alignment.disambiguate == "record":
                    ev.disambiguate(per_field, case)
                for name, f in cand["fields"].items():
                    f["checks"] = ev.checks(f, by_name[name], f["entries"], case, cfg)
                candidates.append(cand)

    per_sample = []
    for sample in range(cfg.sampling.n):
        members = mg.cluster([c for c in candidates if c["sample"] == sample and c["view"] == "field"], case, cfg, coverage)
        per_sample.append([{"chunks": sorted({m["chunk"] for m in ms}, key=coverage.order.index),
                            "first": (coverage.order.index(ms[0]["chunk"]), ms[0]["index"]),
                            "fields": mg.consolidate(ms, nodes, coverage)} for ms in members])
    outvoted: list[dict] = []
    if cfg.sampling.n == 1:
        final = per_sample[0]
    else:
        final = []
        for members in mg.align_samples(per_sample, case, cfg):
            chunks = sorted({c for _, rec in members for c in rec["chunks"]}, key=coverage.order.index)
            final.append({"chunks": chunks, "first": min(rec["first"] for _, rec in members),
                          "fields": {name: mg.vote([_slot(members, s, name, chunks, coverage) for s in range(cfg.sampling.n)],
                                                   by_name[name], cfg.sampling.aggregate == "majority") for name in by_name}})
        if cfg.sampling.aggregate == "majority":       # a record most of the samples that read its region did not find is outvoted
            outvoted = [r for r in final if all(f["status"] == "absent" for f in r["fields"].values())]
            final = [r for r in final if all(r is not o for o in outvoted)]
    final.sort(key=lambda r: r["first"])

    document: dict[str, list] = defaultdict(list)
    doc_ok: dict[str, bool] = {}
    if "document" in cfg.sampling.views:
        doc_jobs = [(chunk, ex.Task(chunk.id, 0, 0, "document")) for chunk in chunks
                    if any(read.get((chunk.id, g, s)) for g in range(len(groups)) for s in range(cfg.sampling.n))]
        outputs = ex.run_tasks([lambda c=c, t=t: [ex.run_document_task(t, c, case, cfg, meter)] for c, t in doc_jobs], cfg)
        for (chunk, _), batch in zip(doc_jobs, outputs, strict=True):
            calls += [call for r in batch for call in r.calls]
            doc_ok[chunk.id] = all(r.ok for r in batch)
            document[chunk.id] += [rec for r in batch for rec in r.records]

    extra_calls: list = []
    if cfg.merge.resolver:      # before verification, which judges what the resolver chose; both run on the study's workers
        conflicts = [(name, f) for rec in final for name, f in rec["fields"].items()
                     if f["status"] == "unresolved" and "conflict" in f["flags"] and len(f["alternatives"]) > 1]
        for made in ex.run_tasks([lambda n=n, f=f: mg.resolve_conflict(n, f, case, cfg, meter) for n, f in conflicts], cfg):
            extra_calls += made
    verdicts_of: list[dict] = [{} for _ in final]
    if cfg.verification.model:
        for i, (found, made) in enumerate(ex.run_tasks([lambda rec=rec: ev.verify_record(rec["fields"], case, cfg, meter) for rec in final], cfg)):
            verdicts_of[i] = found
            extra_calls += made
    rows: list[dict] = []
    for i, rec in enumerate(final):
        verdicts = verdicts_of[i]
        seen = [document[c] for c in rec["chunks"] if c in doc_ok]
        agree = _agree(rec, [r for rs in seen for r in rs], case) if seen and all(doc_ok[c] for c in rec["chunks"] if c in doc_ok) else {}
        for name, f in rec["fields"].items():
            f["verdict"] = verdicts.get(name)
            if f["status"] == "value" and cfg.verification.gate != "off" and ev.unsupported({"checks": f["checks"], "verdict": f["verdict"]}):
                if cfg.verification.gate == "abstain":
                    f["status"] = "unsupported"
                f["flags"] = [*f["flags"], "unsupported"]
            segments = {s["segment"] for e in f["entries"] for s in e["spans"]}
            confidence = [case.ocr_confidence[s] for s in segments if s in case.ocr_confidence]
            f["signals"] = sg.assemble(f["winners"], votes=f.get("votes"), view=agree.get(name), evidence=f["entries"],
                                       verdict=f["verdict"], ocr=min(confidence) if confidence else None,
                                       conflict="conflict" in f["flags"], invalid=_failed(f.get("checks"), f["flags"]))
            rows.append({"record": i, "field": name, "status": f["status"], "raw": f["raw"], "value": f["value"],
                         "normalized": f["normalized"], "alternatives": f["alternatives"], "evidence": f["entries"],
                         "checks": f.get("checks"), "verdict": f["verdict"], "flags": f["flags"], "signals": f["signals"],
                         "votes": list(f["votes"]) if f.get("votes") else None, "contributors": f["contributors"]})
    every = [*calls, *extra_calls]
    statuses = [row["status"] for row in ledger.values()]
    exhaustive = cfg.retrieval.mode == "exhaustive"
    complete = exhaustive and all(s == "processed" for s in statuses)
    return {
        "harness_version": HARNESS_VERSION, "prompt_version": PROMPT_VERSION, "case": case.id, "config": cfg.model_dump(mode="json"),
        "config_sha256": cfg.sha256(), "source": {"generation": case.evidence.generation, "digest": case.evidence.digest},
        "provider": {"model": meter.model, "identity": meter.provider.identity, "admission": admission},
        "records": [{row["field"]: row["value"] if row["status"] == "value" else None for row in rows if row["record"] == i}
                    for i in range(len(final))],
        "fields": rows,
        "evidence": [{"path": ["records", r["record"], r["field"]], "segment": e["spans"][0]["segment"], "page": (e["pages"] or [None])[0],
                      "bbox_pt": (e["bbox_pt"] or [None])[0], "spans": e["spans"], "alternatives": e["alternatives"],
                      "method": e["method"], "approximate": e["approximate"]}
                     for r in rows if r["status"] == "value" for e in r["evidence"] if e["spans"]],
        "coverage": {"exhaustive": exhaustive, "complete": complete, "chunks": len(chunks),
                     "processed": statuses.count("processed"), "partial": statuses.count("partial"), "failed": statuses.count("failed"),
                     "refused": statuses.count("refused"), "not_retrieved": statuses.count("not_retrieved"),
                     "recall": "unmeasured",
                     "note": "processed regions were read; that no record was missed is not established"},
        "ledger": sorted(ledger.values(), key=lambda r: (coverage.order.index(r["chunk"]), r["group"])),
        "calls": [asdict(c) for c in every], "requests": sorted(set(meter.requests)),
        "tokens": {"input": sum(c.input_tokens or 0 for c in every), "output": sum(c.output_tokens or 0 for c in every)},
        "cost": {**meter.spent, "wall_seconds": round(time.monotonic() - started, 3)},
        "validity": {"total": replies, "valid": valid},
        "issues": [{"code": {"failed": "region_failed", "refused": "region_failed", "partial": "region_partial"}.get(r["status"], "task_failed"),
                    "detail": r["errors"][0]["error"] if r.get("errors") else r.get("reason"), "chunk": r["chunk"], "group": r["group"]}
                   for r in ledger.values() if r["status"] in ("failed", "refused", "partial") or r.get("errors")]
        + [{"code": "record_outvoted", "detail": "most of the samples that read this region found no such record", "chunk": r["chunks"][0],
            "group": None} for r in outvoted]
        + [{"code": "record_identity_ambiguous", "detail": "candidate retained; equality or repeated extracted key cannot establish occurrence identity",
            "chunk": c["chunk"], "group": c["group"], "index": c["index"]}
           for c in candidates if c.get("identity_ambiguous")],
    }

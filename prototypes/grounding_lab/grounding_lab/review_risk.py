"""Exploratory grouped risk scores for prioritizing human review.

Consumes a rich ``model_benchmark --dump`` JSONL file. Labels from one
document never fit that document's scores. These six-document scores compare
rankings only; they are not production confidence and never auto-accept.

Usage: python -m grounding_lab.review_risk outcomes/run.jsonl --output ranked.jsonl
"""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter
from pathlib import Path

import numpy as np


ROUTES = ("zero-hit", "loose-only", "strict-single", "strict-multi")


def _selected(row: dict) -> dict | None:
    anchor_id = row.get("bestCandidateAnchorId")
    return next(
        (candidate for candidate in row["candidates"] if candidate["anchorId"] == anchor_id),
        None,
    )


def _features(row: dict, evidence: bool) -> list[float]:
    before = len(row["candidateAnchorIdsBeforePruning"])
    after = len(row["candidates"])
    siblings = row["siblingCount"]
    selected = _selected(row)
    best = row["bestRawScore"]
    margin = row["rawMargin"]
    coverage = (selected or {}).get("rowSiblingCoverage", 0) / max(1, siblings)
    values = [float(row["route"] == route) for route in ROUTES]
    values += [
        math.log1p(before),
        math.log1p(after),
        float(row["bareNumber"]),
        float(row.get("suffixAmbiguous", False)),
        float(row["valueType"] in {"int", "float"}),
        float(row["valueType"] == "bool"),
        math.log1p(len(row["normalizedValue"])),
        math.log1p(siblings),
        coverage,
        float(best is not None),
        float(best or 0.0),
        float(bool(selected and selected["verbatim"])),
    ]
    if evidence:
        values += [
            float(margin or 0.0),
            float(bool(selected and selected.get("hasRowContext", False))),
        ]
    return values


def _weights(rows: list[dict]) -> np.ndarray:
    counts = Counter(row["doc"] for row in rows)
    weights = np.asarray([1 / counts[row["doc"]] for row in rows], dtype=float)
    return weights * len(weights) / weights.sum()


def _fit(rows: list[dict], target, *, evidence: bool):
    x = np.asarray([_features(row, evidence) for row in rows], dtype=float)
    y = np.asarray([target(row) for row in rows], dtype=float)
    weights = _weights(rows)
    mean = np.average(x, axis=0, weights=weights)
    variance = np.average((x - mean) ** 2, axis=0, weights=weights)
    scale = np.where(variance > 1e-12, np.sqrt(variance), 1.0)
    design = np.column_stack((np.ones(len(x)), (x - mean) / scale))
    probability = (float(weights @ y) + 0.5) / (float(weights.sum()) + 1.0)
    beta = np.zeros(design.shape[1])
    beta[0] = math.log(probability / (1 - probability))
    if np.all(y == y[0]):
        return mean, scale, beta

    penalty = np.eye(len(beta))
    penalty[0, 0] = 0.0
    for _ in range(50):
        predicted = 1 / (1 + np.exp(-np.clip(design @ beta, -35, 35)))
        gradient = design.T @ (weights * (predicted - y)) + penalty @ beta
        curvature = weights * predicted * (1 - predicted)
        hessian = design.T @ (curvature[:, None] * design) + penalty
        hessian += np.eye(len(beta)) * 1e-8
        step = np.linalg.solve(hessian, gradient)
        beta -= step
        if np.linalg.norm(step) < 1e-8:
            break
    return mean, scale, beta


def _predict(model, rows: list[dict], *, evidence: bool) -> np.ndarray:
    mean, scale, beta = model
    x = np.asarray([_features(row, evidence) for row in rows], dtype=float)
    design = np.column_stack((np.ones(len(x)), (x - mean) / scale))
    return 1 / (1 + np.exp(-np.clip(design @ beta, -35, 35)))


def fit_frozen(rows: list[dict]) -> dict:
    """Fit on development labels once; serialize all parameters for holdout use."""
    evidence_rows = [r for r in rows if r["supported"] and r.get("bestCandidateAnchorId") is not None]
    if not rows or not evidence_rows:
        raise ValueError("development data needs supported claims with evidence candidates")
    return {
        "version": 1,
        "trainingDocuments": sorted({r["doc"] for r in rows}),
        "value": [part.tolist() for part in _fit(rows, lambda r: r["supported"], evidence=False)],
        "evidence": [part.tolist() for part in _fit(evidence_rows, lambda r: r["bestCandidateAnchorId"] in r["goldAnchorIds"], evidence=True)],
    }


def score_frozen(rows: list[dict], model: dict) -> list[dict]:
    """Inference never reads target labels or adjusts the frozen parameters."""
    if model.get("version") != 1:
        raise ValueError("unknown frozen risk model version")
    if set(model["trainingDocuments"]) & {r["doc"] for r in rows}:
        raise ValueError("holdout documents overlap development training documents")
    if not rows:
        return []
    value = _predict([np.asarray(p) for p in model["value"]], rows, evidence=False)
    candidates = [r for r in rows if r.get("bestCandidateAnchorId") is not None]
    evidence = iter(_predict([np.asarray(p) for p in model["evidence"]], candidates, evidence=True) if candidates else [])
    result = []
    for row, support in zip(rows, value):
        correct = float(next(evidence)) if row.get("bestCandidateAnchorId") is not None else None
        result.append({**row, "valueRiskScore": 1-float(support),
                       "evidenceRiskScore": None if correct is None else 1-correct,
                       "reviewRiskScore": 1-float(support)*correct if correct is not None else 1.0,
                       "riskScoreTraining": "frozen development-only parameters; no auto-accept"})
    return result


def score_grouped(rows: list[dict]) -> list[dict]:
    """Leave-one-document-out value/evidence risks, preserving row order."""
    if len({row["doc"] for row in rows}) < 2:
        raise ValueError("grouped scoring requires at least two documents")
    scored = [dict(row) for row in rows]
    for held_doc in sorted({row["doc"] for row in rows}):
        train = [row for row in rows if row["doc"] != held_doc]
        held_indices = [i for i, row in enumerate(rows) if row["doc"] == held_doc]
        held = [rows[i] for i in held_indices]

        value_model = _fit(train, lambda row: row["supported"], evidence=False)
        value_support = _predict(value_model, held, evidence=False)
        evidence_train = [
            row for row in train
            if row["supported"] and row.get("bestCandidateAnchorId") is not None
        ]
        evidence_held = [row for row in held if row.get("bestCandidateAnchorId") is not None]
        if evidence_train and evidence_held:
            evidence_model = _fit(
                evidence_train,
                lambda row: row["bestCandidateAnchorId"] in row["goldAnchorIds"],
                evidence=True,
            )
            evidence_predictions = _predict(evidence_model, evidence_held, evidence=True)
        else:
            evidence_predictions = [None] * len(evidence_held)
        evidence_support = iter(evidence_predictions)

        for index, row, value_probability in zip(held_indices, held, value_support):
            evidence_prediction = (
                next(evidence_support)
                if row.get("bestCandidateAnchorId") is not None else None
            )
            evidence_probability = (
                float(evidence_prediction) if evidence_prediction is not None else None
            )
            joint = value_probability * evidence_probability if evidence_probability is not None else 0.0
            scored[index].update({
                "valueRiskScore": 1 - float(value_probability),
                "evidenceRiskScore": None if evidence_probability is None else 1 - evidence_probability,
                "reviewRiskScore": 1 - joint,
                "riskScoreTraining": "leave-one-document-out; exploratory; no auto-accept",
            })
    return scored


def _error(row: dict) -> bool:
    return row.get("bestCandidateAnchorId") not in row["goldAnchorIds"]


def _brier(rows: list[dict], probability, target) -> float:
    return (
        float(np.mean([(probability(row) - target(row)) ** 2 for row in rows]))
        if rows else math.nan
    )


def _macro_at_k(rows, documents, score, error, eligible, k) -> tuple[float, float]:
    precisions, recalls = [], []
    for document in documents:
        ranked = sorted(
            (row for row in rows if row["doc"] == document and eligible(row)),
            key=score,
            reverse=True,
        )
        if not ranked:
            continue
        top = ranked[:k]
        errors = sum(error(row) for row in ranked)
        found = sum(error(row) for row in top)
        precisions.append(found / len(top))
        if errors:
            recalls.append(found / errors)
    return float(np.mean(precisions)), float(np.mean(recalls)) if recalls else math.nan


def report(rows: list[dict]) -> str:
    documents = sorted({row["doc"] for row in rows})
    lines = [
        "# Exploratory review-risk ranking",
        "",
        ("Frozen development-only scores on untouched evaluation claims. "
         if rows and all(r.get("riskScoreTraining", "").startswith("frozen") for r in rows)
         else "Leave-one-document-out scores; policy/features were already selected on this set. ")
        + "Do not use these scores as production confidence or for auto-accept.",
        "",
        "## Review queues",
        "",
        "Macro-averaged per Extraction. Recall is within the supplied labelled claims "
        "and omits Extractions with no eligible errors.",
        "",
        "| queue | error precision@1 | @3 | @5 | sampled-error recall@1 | @3 | @5 |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    queues = (
        ("joint: values + proposed evidence", lambda r: r["reviewRiskScore"], _error, lambda r: True),
        ("value only", lambda r: r["valueRiskScore"], lambda r: not r["supported"], lambda r: True),
        ("evidence only (supported)", lambda r: r["evidenceRiskScore"], _error,
         lambda r: r["supported"] and r["evidenceRiskScore"] is not None),
        ("linked proposals", lambda r: r["reviewRiskScore"], _error,
         lambda r: r.get("bestCandidateAnchorId") is not None),
        ("linked proposals, legacy confidence", lambda r: 1 - (r.get("legacyConfidence") or 0.0), _error,
         lambda r: r.get("bestCandidateAnchorId") is not None),
    )
    for label, score, error, eligible in queues:
        values = [_macro_at_k(rows, documents, score, error, eligible, k) for k in (1, 3, 5)]
        lines.append(
            f"| {label} | {values[0][0]:.3f} | {values[1][0]:.3f} | {values[2][0]:.3f} | "
            f"{values[0][1]:.3f} | {values[1][1]:.3f} | {values[2][1]:.3f} |"
        )

    evidence_rows = [
        row for row in rows
        if row["supported"] and row.get("evidenceRiskScore") is not None
    ]
    lines += [
        "",
        "## Calibration diagnostics",
        "",
        "| target | Brier |",
        "|---|---:|",
        f"| value Brier | {_brier(rows, lambda r: 1-r['valueRiskScore'], lambda r: r['supported']):.3f} |",
        f"| evidence Brier (supported with candidate) | "
        f"{_brier(evidence_rows, lambda r: 1-r['evidenceRiskScore'], lambda r: not _error(r)):.3f} |",
        f"| joint Brier | {_brier(rows, lambda r: 1-r['reviewRiskScore'], lambda r: not _error(r)):.3f} |",
        "",
        "`sampled-error recall` covers supplied labels; whole-Extraction recall requires labels for every emitted leaf.",
    ]
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--freeze", type=Path, help="fit development input and save frozen model parameters")
    mode.add_argument("--frozen", type=Path, help="score holdout input without fitting")
    args = parser.parse_args()
    rows = [json.loads(line) for line in args.input.read_text(encoding="utf-8").splitlines()]
    if args.freeze:
        args.freeze.write_text(json.dumps(fit_frozen(rows), indent=2) + "\n", encoding="utf-8")
        return 0
    scored = score_frozen(rows, json.loads(args.frozen.read_text(encoding="utf-8"))) if args.frozen else score_grouped(rows)
    if args.output:
        with args.output.open("w", encoding="utf-8") as out:
            for row in scored:
                out.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(report(scored), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

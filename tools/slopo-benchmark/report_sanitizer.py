"""Remove review-only labels from benchmark reports."""

from __future__ import annotations

from typing import Any


def remove_evaluation_labels(full: dict[str, Any]) -> dict[str, Any]:
    for cluster in full["top"]:
        cluster["relevant"] = None
        cluster["state"] = "unreviewed"
    for key in ("p20", "p50"):
        metrics = full[key]
        if not metrics:
            continue
        metrics.update(
            {
                "reviewed": 0,
                "unknown": metrics["returned"],
                "known_precision_lower_bound": 0.0,
                "reviewed_precision": 0.0,
            }
        )
    return full

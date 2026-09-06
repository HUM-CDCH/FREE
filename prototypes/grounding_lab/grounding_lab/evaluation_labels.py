"""Lab gold labels: alternatives are OR; anchors within an alternative are AND."""
from __future__ import annotations


def evidence_sets(claim: dict) -> list[list[str]]:
    if "goldAnchorSets" in claim:
        sets = claim["goldAnchorSets"]
    elif isinstance(claim.get("goldAnchorIds"), list):
        sets = [[anchor] for anchor in claim["goldAnchorIds"]]
    elif "goldAnchorId" in claim:
        sets = [[claim["goldAnchorId"]]] if claim["goldAnchorId"] is not None else []
    else:
        raise ValueError("missing gold labels (null is unlabelled, [] is unsupported)")
    if not isinstance(sets, list) or any(
        not isinstance(group, list) or not group
        or any(not isinstance(anchor, str) or not anchor for anchor in group)
        or len(set(group)) != len(group)
        for group in sets
    ):
        raise ValueError("goldAnchorSets must contain nonempty sets of distinct anchor IDs")
    return sets


def evidence_correct(proposed: list[str], gold: list[list[str]]) -> bool:
    # Extra unrelated anchors are not evidence: a proposal must match an accepted set.
    return bool(proposed) and any(set(proposed) == set(accepted) for accepted in gold)

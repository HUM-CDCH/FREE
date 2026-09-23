"""Boundary labels and block-F1: the measurement the Phase 1 gate asks for (grounded catalogue design §9).

A reviewer labels every non-blank source line of a sample of book pages with the printed label of the entry that
owns it, or with nothing. Lines are the segmentation's own units (`kie.stages.layout.lines`): a canonical segment id
and a raw code-point range, bound to one parse generation, so a label file is refused against any other parse. A
pre-filled file carries the segmenter's answer for the reviewer to correct; it is never itself a gold standard.

Matching definition `exact-line-set@1`, frozen: on the labelled pages, a predicted block matches a gold block when
both own exactly the same set of lines. Printed labels are not part of the match; disagreements are reported. Precision
counts the predicted blocks with at least one line on the labelled pages, recall the gold blocks. A gold block is a
boundary block when it appears in more than one region (book page and column) or owns the first or last entry line
of a region it appears in; every other gold block is interior.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from kei_exp.kie.extract.evidence import Evidence, Passage, load
from kei_exp.kie.recipe import load_recipe
from kei_exp.kie.segmentation import Segmentation, SegmentationInvalid, load_segmentation
from kei_exp.kie.stages.layout import Line, lines

LABELS_VERSION = 1
MATCHING = "exact-line-set@1"

LineKey = tuple[str, int, int]
BookPage = tuple[int, int]  # (PDF page, unit): unit 0 is the page itself, else a book page of a spread


class _Base(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class LabelledLine(_Base):
    segment: str
    start: int = Field(ge=0)
    end: int = Field(gt=0)
    text: str                            # the line as the parse has it: shown to the reviewer, checked when scoring
    entry: str | None                    # the owning entry's printed label; `31#2` tells two entries printed 31 apart
    predicted: str | None = None         # pre-fill only: the segmenter's role and reason; never scored


class BoundaryLabels(_Base):
    labels_version: Literal[1]
    matching: Literal["exact-line-set@1"]
    generation: str
    parse_digest: str
    pages: list[BookPage] = Field(min_length=1)
    sample: dict                         # how the pages were chosen, so a reader can judge what they represent
    prefilled_from: str | None           # the segmentation digest a pre-fill came from; None when labelled from scratch
    lines: list[LabelledLine]


class LabelsRefused(ValueError):
    """A label file that cannot be scored against this parse; the message names the check it failed."""


def source_lines(evidence: Evidence) -> list[Line]:
    """Every non-blank line the segmentation disposes of, in reading order (withheld segments included)."""
    return lines(sorted((*evidence.passages, *evidence.withheld), key=lambda passage: (passage.page, passage.index)))


def _book_page(passage: Passage) -> BookPage:
    return passage.page, passage.unit


def _key(line: Line | LabelledLine) -> LineKey:
    return (line.segment, line.start, line.end)


def sample_pages(evidence: Evidence, segmentation: Segmentation, count: int = 20,
                 seed: int = 0) -> tuple[list[BookPage], dict]:
    """`count` book pages, one drawn by `seed` from each of `count` consecutive strata of the candidates in reading
    order. Candidates are the book pages where the segmentation put an entry or an unresolved line: pages it read as
    prose, index or furniture only are not sampled, which the returned description says."""
    roles = {(d.segment_id, d.start, d.end): d.role for d in segmentation.dispositions}
    candidates: list[BookPage] = []
    for line in source_lines(evidence):
        page = _book_page(line.passage)
        if roles.get(_key(line)) in ("entry", "unresolved") and page not in candidates:
            candidates.append(page)
    rng = random.Random(seed)
    strata = min(count, len(candidates))
    chosen = []
    for stratum in range(strata):
        low, high = stratum * len(candidates) // strata, (stratum + 1) * len(candidates) // strata
        chosen.append(candidates[rng.randrange(low, high)])
    return chosen, {"seed": seed, "strata": strata, "candidates": len(candidates),
                    "segmentation": segmentation.digest,
                    "restriction": "book pages with an entry or unresolved line in that segmentation"}


def prefill(evidence: Evidence, segmentation: Segmentation, pages: list[BookPage], sample: dict) -> BoundaryLabels:
    """A label file for `pages` holding the segmentation's answer, for a reviewer to correct line by line."""
    labels = {block.id: block.entry_label for block in segmentation.blocks}
    dispositions = {(d.segment_id, d.start, d.end): d for d in segmentation.dispositions}
    wanted = set(pages)
    rows = []
    for line in source_lines(evidence):
        if _book_page(line.passage) not in wanted:
            continue
        disposition = dispositions[_key(line)]
        rows.append(LabelledLine(segment=line.segment, start=line.start, end=line.end, text=line.text,
                                 entry=labels[disposition.block] if disposition.role == "entry" else None,
                                 predicted=disposition.role + (f": {disposition.reason}" if disposition.reason
                                                               else "")))
    return BoundaryLabels(labels_version=LABELS_VERSION, matching=MATCHING, generation=evidence.generation,
                          parse_digest=evidence.digest, pages=sorted(wanted), sample=sample,
                          prefilled_from=segmentation.digest, lines=rows)


def _ratio(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 4) if denominator else None


def _f1(precision: float | None, recall: float | None) -> float | None:
    if precision is None or recall is None:
        return None
    return round(2 * precision * recall / (precision + recall), 4) if precision + recall else 0.0


def score(labels: BoundaryLabels, evidence: Evidence, segmentation: Segmentation) -> dict:
    """Block-F1 of `segmentation` against `labels` on the labelled pages, with the boundary/interior breakdown and
    every numbering or coverage exception there. Refused unless the labels cover exactly those pages' lines."""
    if (labels.generation, labels.parse_digest) != (evidence.generation, evidence.digest):
        raise LabelsRefused(f"the labels are for generation {labels.generation}, not {evidence.generation}")
    if (segmentation.generation, segmentation.parse_digest) != (evidence.generation, evidence.digest):
        raise LabelsRefused(f"the segmentation was cut from generation {segmentation.generation}")
    wanted = set(labels.pages)
    on_pages = [line for line in source_lines(evidence) if _book_page(line.passage) in wanted]
    expected = {_key(line): line for line in on_pages}
    given = {_key(line): line for line in labels.lines}
    if len(given) != len(labels.lines):
        raise LabelsRefused("a line is labelled twice")
    if set(given) != set(expected):
        missing, extra = sorted(set(expected) - set(given)), sorted(set(given) - set(expected))
        raise LabelsRefused(f"the labels must cover exactly the labelled pages' lines: missing {missing[:3]}, "
                            f"not on those pages {extra[:3]}")
    for key, line in given.items():
        if line.text != expected[key].text:
            raise LabelsRefused(f"{key[0]}[{key[1]}:{key[2]}] reads {expected[key].text!r}, not {line.text!r}")
        if line.entry is not None and not line.entry.split("#", 1)[0].strip():
            raise LabelsRefused(f"{key[0]}[{key[1]}:{key[2]}] names an empty entry label")

    gold: dict[str, set[LineKey]] = {}
    for line in labels.lines:
        if line.entry is not None:
            gold.setdefault(line.entry, set()).add(_key(line))
    block_label = {block.id: block.entry_label for block in segmentation.blocks}
    predicted: dict[str, set[LineKey]] = {}
    for disposition in segmentation.dispositions:
        key = (disposition.segment_id, disposition.start, disposition.end)
        if disposition.role == "entry" and key in expected:
            predicted.setdefault(disposition.block, set()).add(key)
    by_lines = {frozenset(keys): block for block, keys in predicted.items()}
    matches = {entry: by_lines[frozenset(keys)] for entry, keys in gold.items() if frozenset(keys) in by_lines}

    region = {key: (line.passage.page, line.passage.unit, line.passage.crop_order) for key, line in expected.items()}
    order = {key: position for position, key in enumerate(expected)}
    entry_lines: dict[tuple, list[LineKey]] = {}
    for keys in gold.values():
        for key in keys:
            entry_lines.setdefault(region[key], []).append(key)
    edges = set()
    for keys in entry_lines.values():
        keys.sort(key=order.__getitem__)
        edges |= {keys[0], keys[-1]}
    boundary = {entry for entry, keys in gold.items() if len({region[key] for key in keys}) > 1 or keys & edges}

    def breakdown(entries: set[str]) -> dict:
        matched = sum(entry in matches for entry in entries)
        return {"gold": len(entries), "matched": matched, "recall": _ratio(matched, len(entries))}

    precision, recall = _ratio(len(matches), len(predicted)), _ratio(len(matches), len(gold))
    gold_entry = {key for keys in gold.values() for key in keys}
    predicted_entry = {key for keys in predicted.values() for key in keys}
    unresolved = Counter(d.reason for d in segmentation.dispositions
                         if d.role == "unresolved" and (d.segment_id, d.start, d.end) in expected)
    labelled_segments = {key[0] for key in expected}
    return {
        "matching": MATCHING, "labels_version": labels.labels_version, "generation": evidence.generation,
        "segmentation": segmentation.digest, "recipe": f"{segmentation.recipe.id}@{segmentation.recipe.version}",
        "prefilled_from": labels.prefilled_from, "pages": len(wanted), "lines": len(expected),
        "gold_blocks": len(gold), "predicted_blocks": len(predicted), "matched": len(matches),
        "precision": precision, "recall": recall, "f1": _f1(precision, recall),
        "boundary": breakdown(boundary), "interior": breakdown(set(gold) - boundary),
        "label_disagreements": sorted([entry, block_label[block]] for entry, block in matches.items()
                                      if entry.split("#", 1)[0] != block_label[block]),
        "unmatched_gold": sorted(set(gold) - set(matches)),
        "unmatched_predicted": sorted(block_label[block] for block in set(predicted) - set(matches.values())),
        "entry_lines_predicted_otherwise": len(gold_entry - predicted_entry),
        "other_lines_predicted_as_entry": len(predicted_entry - gold_entry),
        "unresolved": dict(sorted(unresolved.items(), key=lambda item: str(item[0]))),
        "exceptions": [{"label": start.label, "role": start.role, "reason": start.reason}
                       for start in segmentation.rejected_starts
                       if start.span.segment_id in labelled_segments and start.role != "list_item"]
                      + [{"code": diagnostic.code, "detail": diagnostic.detail}
                         for diagnostic in segmentation.diagnostics
                         if any(span.segment_id in labelled_segments for span in diagnostic.spans)],
    }


def report(evidence: Evidence, segmentation: Segmentation, seconds: float | None = None) -> dict:
    """What a full-catalogue segmentation accounted for, by role and reason; no accuracy is implied."""
    numbers = [block.entry_no for block in segmentation.blocks]
    return {
        "run_id": evidence.run_id, "source_name": evidence.source_name, "generation": evidence.generation,
        "parse_digest": evidence.digest, "pages": evidence.page_count,
        "recipe": segmentation.recipe.model_dump(), "segmentation": segmentation.digest, "seconds": seconds,
        "blocks": len(segmentation.blocks), "entry_numbers": [min(numbers), max(numbers)] if numbers else None,
        "continuations": sum(block.continuation for block in segmentation.blocks),
        "coverage": segmentation.coverage.model_dump(),
        "unresolved": dict(Counter(str(d.reason) for d in segmentation.dispositions if d.role == "unresolved")),
        "rejected_starts": dict(Counter(start.reason for start in segmentation.rejected_starts)),  # names the role
        "diagnostics": dict(Counter(diagnostic.code for diagnostic in segmentation.diagnostics)),
        "order_issues": len(evidence.order_issues),
    }


def _segmentation(run_dir: Path, evidence: Evidence, recipe_ref: str) -> tuple[Segmentation, float | None]:
    """The run's published artifact when it proves out, else one computed in memory: evaluation never writes into
    the run it measures."""
    from kei_exp.kie.stages.segment import segment
    recipe = load_recipe(recipe_ref)
    try:
        found = load_segmentation(run_dir, evidence, recipe)
    except SegmentationInvalid:
        found = None
    if found is not None:
        return found, None
    clock = time.monotonic()
    made = segment(evidence, recipe)
    return made, round(time.monotonic() - clock, 3)


def main(argv: list[str] | None = None) -> int:
    """`python -m kei_exp.kie.boundaries {report,prefill,score} RUN_DIR ...`; JSON on stdout, the run untouched."""
    parser = argparse.ArgumentParser(description="segmentation report, boundary label pre-fill and block-F1")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("report", "prefill", "score"):
        command = commands.add_parser(name)
        command.add_argument("run_dir", type=Path)
        command.add_argument("--recipe", default="numbered-catalogue-de@1")
        if name == "prefill":
            command.add_argument("--pages", type=int, default=20)
            command.add_argument("--seed", type=int, default=0)
        if name == "score":
            command.add_argument("labels", type=Path)
    args = parser.parse_args(argv)
    evidence = load(args.run_dir)
    segmentation, seconds = _segmentation(args.run_dir, evidence, args.recipe)
    if args.command == "report":
        out = report(evidence, segmentation, seconds)
    elif args.command == "prefill":
        pages, sample = sample_pages(evidence, segmentation, args.pages, args.seed)
        if not pages:
            print("refused: the segmentation put no entry or unresolved line on any page", file=sys.stderr)
            return 2
        out = prefill(evidence, segmentation, pages, sample).model_dump(mode="json")
    else:
        labels = BoundaryLabels.model_validate_json(args.labels.read_text(encoding="utf-8"))
        try:
            out = score(labels, evidence, segmentation)
        except LabelsRefused as error:
            print(f"refused: {error}", file=sys.stderr)
            return 2
    json.dump(out, sys.stdout, ensure_ascii=False, indent=1)
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

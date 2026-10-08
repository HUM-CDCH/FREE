"""Discovery windows cut by the token budget, the printed page or the column, read live. Not used by product workflows.

For each window plan it reports record-start recall against numbered gold starts, the ledger's unresolved text, calls,
cut-off replies, wall time, and when each entry could start were entries run as soon as the windows deciding it were
read (the `pipelined` times; the product starts every entry after the last window). `--scale K` repeats the source's
pages K times with the gold numbers shifted, a synthetic long source for throughput only. The models come from the
environment as for the live tests (`KEI_EXTRACT_URL`, `KEI_EXTRACT_MODEL`, `KEI_NUEXTRACT_URL`, ...). `--values GOLD`
instead runs whole extractions under each `--defaults` version and scores their values against gold rows.

    python -m experiments.extraction.discovery_windows RUN_DIR --gold 205 233 --by budget page column --repeats 2
    python -m experiments.extraction.discovery_windows RUN_DIR --values reference.json --defaults 1 2
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
import tempfile
import time
import unicodedata
from collections import Counter
from functools import partial
from itertools import groupby
from pathlib import Path

from kei_exp.kie.extract import discovery, run, unified
from kei_exp.kie.extract.models import chats_for
from kei_exp.kie.extract.tokens import counters_for
from kei_exp.kie.passages import Evidence, load

SCHEMA = {"recordDescription": "One numbered entry of an archaeological site catalogue.", "schemaNodes": [
    {"id": "n", "name": "catalog_number", "type": "integer"},
    {"id": "l", "name": "locality", "type": "string", "description": "the place name right after the number"},
    {"id": "f", "name": "findspot", "type": "string", "description": "after Fdpl."},
    {"id": "m", "name": "map_sheet", "type": "integer", "description": "the first number after Mbl."},
    {"id": "t", "name": "find_type", "type": "string", "description": "the find category after FA:"}]}
NUMBERED = re.compile(r"(?m)^(\d{1,4})\. (?=\S)")


def gold_starts(evidence: Evidence, first: int, last: int) -> dict[str, int]:
    """Segment -> catalogue number of every line that opens with a number in [first, last]."""
    found = {passage.id: int(match.group(1)) for passage in evidence.passages
             for match in NUMBERED.finditer(passage.text) if first <= int(match.group(1)) <= last}
    missing = set(range(first, last + 1)) - set(found.values())
    if missing or len(found) != last - first + 1:
        raise SystemExit(f"gold numbers not each found once: missing {sorted(missing)}, {len(found)} starts")
    return found


def scaled(evidence: Evidence, copies: int, first: int, last: int, directory: Path) -> Path:
    """The source's pages repeated `copies` times as a fixture result, each copy's gold numbers shifted on."""
    from tests.helpers import catalogue
    span, pages = last - first + 1, []
    for copy in range(copies):
        def renumber(text: str, copy: int = copy) -> str:
            return NUMBERED.sub(lambda m: f"{int(m.group(1)) + copy * span}. "
                                if first <= int(m.group(1)) <= last else m.group(0), text)
        for page, of_page in groupby(evidence.passages, key=lambda passage: passage.page):
            units = []
            for unit, of_unit in groupby(of_page, key=lambda passage: passage.unit):
                crops = [{"segments": [{"text": renumber(passage.text), "label": passage.label} for passage in crop]}
                         for _, crop in groupby(of_unit, key=lambda passage: passage.crop)]
                units.append({"index": unit, "crops": crops})
            pages.append({"page": copy * evidence.page_count + page, "units": units})
    return catalogue.write({"pages": pages, "source_name": "scaled.pdf"}, directory)


def once(evidence: Evidence, gold: dict[str, int], by: str, workers: int, overlap: int | None) -> dict:
    request = run.ExtractRequest.model_validate({"schema": SCHEMA, "options": {"strategy": "catalog", "unified": {
        "defaults": 1, **({"overlap": overlap} if overlap is not None else {})}}})
    chat = chats_for(request.options)
    counters = counters_for(chat)
    execution = unified._execution(evidence, request.schema_, request.options.unified, chat, counters)
    effective = execution["effective"]
    budget = unified._Budget(chat, counters, effective["stages"], lambda: None)
    finished: dict[str, float] = {}
    started = time.monotonic()

    def ask(record, system, user, schema, calls, issues):
        answer = budget.ask("discovery", record, system, user, schema, calls, issues)
        finished[user] = time.monotonic() - started
        return answer
    body = discovery.discover(evidence, request.schema_.record_description, partial(budget.fits, "discovery"), ask,
                              overlap=effective["overlap"], splits=effective["splits"], by=by, workers=workers)
    wall = time.monotonic() - started
    return {"by": by, "workers": workers, "overlap": effective["overlap"], "wall": wall,
            **score(evidence, gold, body, finished, wall), "body": {key: body[key] for key in ("entries", "ledger")}}


def score(evidence: Evidence, gold: dict[str, int], body: dict, finished: dict[str, float], wall: float) -> dict:
    units = discovery.units_of(evidence.passages)
    texts = {passage.id: passage.text for passage in evidence.passages}
    position = {(unit.segment, unit.start): index for index, unit in enumerate(units)}
    spans = []  # each read window's first and last unit index and when its reply returned
    for window in body["windows"]:
        first, last = (position[(each["segment"], each["start"])] for each in window["primary"])
        shown = discovery.text_of(units[first:last + 1], texts, [f"L{n}" for n in range(1, last - first + 2)])
        spans.append((first, last, next((at for user, at in finished.items() if shown in user), wall)))

    def window_of(segment: str, start: int) -> int:
        index = max(i for (s, at), i in position.items() if s == segment and at <= start)
        return next(n for n, (first, last, _) in enumerate(spans) if first <= index <= last)

    ready = []  # an entry is decided once the windows over its text and the next window are read
    for entry in body["entries"]:
        segment, offset = entry["id"].rsplit("@", 1)
        touched = [window_of(segment, int(offset)), *(window_of(each["segment"], each["start"])
                                                      for each in entry["ranges"])]
        ready.append(max(spans[n][2] for n in range(min(touched), min(max(touched) + 1, len(spans) - 1) + 1)))
    found = [entry["id"].rsplit("@", 1)[0] for entry in body["entries"]]
    hit = set(found) & set(gold)
    calls = body["calls"]
    rows = body["ledger"]
    chars = Counter()
    for row in rows:
        chars[row["disposition"]] += row["end"] - row["start"]
    # Each gold record's text runs from its start line to the next gold start (or the source's end): how much of it
    # the entry opening at that start owns, and how many other entries open inside it (a record cut in pieces).
    starts = sorted(position[(segment, 0)] for segment in gold)
    record_of = [None] * len(units)  # unit index -> the gold record (its start segment) the line belongs to
    for number, first in enumerate(starts):
        for index in range(first, starts[number + 1] if number + 1 < len(starts) else len(units)):
            record_of[index] = units[first].segment
    owner = {}  # unit index -> the entry owning the line's first character
    for row in rows:
        for index, unit in enumerate(units):
            if unit.segment == row["segment"] and row["start"] <= unit.start < row["end"]:
                owner[index] = row["entry"]
    own, total, inside = Counter(), Counter(), Counter()
    for index, record in enumerate(record_of):
        if record is not None:
            total[record] += units[index].end - units[index].start
            own[record] += (units[index].end - units[index].start) * (owner.get(index) == f"{record}@0")
    for entry in body["entries"]:
        segment, offset = entry["id"].rsplit("@", 1)
        index = max(i for (s, at), i in position.items() if s == segment and at <= int(offset))
        if record_of[index] is not None and entry["id"] != f"{record_of[index]}@0":
            inside[record_of[index]] += 1
    return {"windows": len(spans), "failed_windows": sum(not window["ok"] for window in body["windows"]),
            "calls": len(calls), "failed_calls": sum(not call.ok for call in calls),
            "cut_off": sum("cut off" in (call.error or "") for call in calls),
            "output_tokens": sum(call.output_tokens or 0 for call in calls),
            "max_input_tokens": max((call.input_tokens or 0 for call in calls), default=0),
            "gold": len(gold), "entries": len(found), "true": len(hit), "recall": len(hit) / len(gold),
            "precision": len(hit) / len(found) if found else 0.0, "missed": sorted(gold[s] for s in set(gold) - hit),
            "extra": sorted(set(found) - set(gold)), "ends": dict(Counter(entry["end"] for entry in body["entries"])),
            "chars": dict(chars), "unresolved_share": chars["unresolved"] / max(1, sum(chars.values())),
            "own_text": sum(own.values()) / max(1, sum(total.values())),
            "whole_records": sum(own[record] == total[record] and not inside[record] for record in total),
            "split_records": sum(1 for record in total if inside[record]), "pieces_inside": sum(inside.values()),
            "first_entry_ready": min(ready, default=None), "median_entry_ready": statistics.median(ready) if ready
            else None, "issues": dict(Counter(issue.code for issue in body["issues"]))}


def same(got, expected) -> bool:
    def norm(value) -> str:
        return " ".join(unicodedata.normalize("NFKC", str(value)).casefold().split()).rstrip(".")
    return got is not None and norm(got) == norm(expected)


def values(evidence: Evidence, rows: list[dict], version: int, chunks: int) -> dict:
    """The whole unified extraction under defaults `version`, its records scored against gold rows by catalogue number:
    a number extracted twice or not in the gold is not scored, and counts against the run."""
    request = run.ExtractRequest.model_validate({"schema": SCHEMA, "options": {"strategy": "catalog", "unified": {
        "defaults": version}}})
    started = time.monotonic()
    result = run.dispatch(None, evidence, request, chats_for(request.options), chunks=chunks)
    wall = time.monotonic() - started
    gold = {row["values"]["catalog_number"]: row["values"] for row in rows}
    names = [node["name"] for node in SCHEMA["schemaNodes"] if node["name"] != "catalog_number"]
    numbers = Counter(record.get("catalog_number") for record in result["records"])
    right, present = Counter(), Counter(name for row in gold.values() for name in names if row.get(name) is not None)
    for record in result["records"]:
        expected = gold.get(record.get("catalog_number"))
        if expected is not None and numbers[record["catalog_number"]] == 1:
            right.update(name for name in names if expected.get(name) is not None and same(record.get(name), expected[name]))
    return {"defaults": version, "wall": wall, "records": len(result["records"]),
            "matched": sum(numbers[number] == 1 for number in gold), "duplicated": sum(numbers[number] > 1 for number in gold),
            "spurious": sum(count for number, count in numbers.items() if number not in gold),
            "fields": {name: f"{right[name]}/{present[name]}" for name in names},
            "accuracy": sum(right.values()) / max(1, sum(present.values()))}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("run_dir", type=Path)
    parser.add_argument("--gold", nargs=2, type=int, metavar=("FIRST", "LAST"))
    parser.add_argument("--by", nargs="+", default=["budget", "page", "column"], choices=["budget", "page", "column"])
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--overlap", type=int)
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--scale", type=int, default=1)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--values", type=Path, help="gold rows (JSON with `rows[].values`): score whole extractions")
    parser.add_argument("--defaults", nargs="+", type=int, default=[1, 2])
    parser.add_argument("--windows", choices=["budget", "page", "column"], help="replace version 2's discovery windows")
    args = parser.parse_args()
    evidence = load(args.run_dir)
    if args.windows:
        unified.DEFAULTS[2] = {**unified.DEFAULTS[2], "windows": args.windows}
    if args.values:
        rows = json.loads(args.values.read_text(encoding="utf-8"))["rows"]
        results = []
        for _ in range(args.repeats):
            for version in args.defaults:
                results.append(values(evidence, rows, version, args.workers))
                print(json.dumps(results[-1]), flush=True)
        if args.out:
            args.out.write_text(json.dumps(results, indent=1) + "\n", encoding="utf-8")
        return
    first, last = args.gold
    with tempfile.TemporaryDirectory() as scratch:
        if args.scale > 1:
            evidence = load(scaled(evidence, args.scale, first, last, Path(scratch)))
            last = first + args.scale * (last - first + 1) - 1
        gold = gold_starts(evidence, first, last)
        results = []
        for repeat in range(args.repeats):
            for by in args.by:
                result = {"repeat": repeat, "scale": args.scale, **once(evidence, gold, by, args.workers, args.overlap)}
                results.append(result)
                print(json.dumps({key: value for key, value in result.items() if key not in ("extra", "body")}), flush=True)
    if args.out:
        args.out.write_text(json.dumps(results, indent=1) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()

"""A synthetic catalogue whose gold and evidence offsets are known by construction: the only local gold there is.

It tests implementation correctness (matching, alignment, merging, statistics), never real-world superiority. Sites
repeat between entries, so a quoted site matches several places and only one is the entry's own (the others are gold
decoys); the last entry of each odd page continues on the next page; every third entry has no date, which the gold
states as absent.
"""
from __future__ import annotations

import random

SCHEMA = {"recordDescription": "One numbered entry of a catalogue.", "schemaNodes": [
    {"id": "n", "name": "entry_no", "type": "integer"},
    {"id": "s", "name": "site", "type": "string", "description": "the find place after the number"},
    {"id": "k", "name": "kreis", "type": "string", "description": "the district after Kreis"},
    {"id": "f", "name": "finds", "type": "array", "itemType": "string", "description": "the finds listed after Funde"},
    {"id": "d", "name": "date", "type": "string", "description": "the year after Datiert, when given"}]}
SITES = ["Aue", "Bach", "Dorf", "Eck", "Feld", "Grund"]
KREISE = ["Moor", "Ried", "Heide"]
FINDS = ["Scherben", "Feuerstein", "Eisen", "Bronze", "Knochen", "Perlen"]


def _ref(segment: str, text: str, needle: str, after: int = 0) -> dict:
    start = text.index(needle, after)
    return {"segment": segment, "start": start, "end": start + len(needle)}


def _add(passages: list[dict], page: int, text: str) -> str:
    segment = f"p{page}_s{sum(p['page'] == page for p in passages)}"
    passages.append({"id": segment, "page": page, "text": text, "label": "Text", "confidence": 0.99})
    return segment


def _evidence(entry: dict) -> dict:
    (segment, first), *rest = entry["pieces"]
    found = {"entry_no": [_ref(segment, first, str(entry["no"]))],
             "site": [_ref(segment, first, entry["site"], len(str(entry["no"])))],
             "kreis": [_ref(segment, first, entry["kreis"], first.index("Kreis"))], "finds": []}
    remaining = list(entry["finds"])
    for segment, text in entry["pieces"]:
        position = text.index("Funde") if "Funde" in text else 0
        while remaining and (at := text.find(remaining[0], position)) >= 0:
            value = remaining.pop(0)
            found["finds"].append({"segment": segment, "start": at, "end": at + len(value)})
            position = at + len(value)
    if entry["date"]:
        segment, text = entry["pieces"][-1]
        found["date"] = [_ref(segment, text, entry["date"], text.index("Datiert"))]
    return found


def catalogue(case_id: str, *, group: str | None = None, split: str = "dev", records: int = 6, seed: int = 0,
              first: int = 40, per_page: int = 3) -> dict:
    """An inline case: `records` entries over pages of `per_page`; gold names value, absent and evidence per field."""
    rng = random.Random(seed)
    entries = [{"no": no, "site": rng.choice(SITES), "kreis": rng.choice(KREISE),
                "finds": rng.sample(FINDS, rng.randint(2, 3)),
                "date": None if no % 3 == 0 else str(1800 + rng.randint(0, 99))} for no in range(first, first + records)]
    passages: list[dict] = []
    for index, entry in enumerate(entries):
        page = index // per_page + 1
        head = f"{entry['no']}. {entry['site']}. Kreis {entry['kreis']}. Funde: "
        dated = f" Datiert: {entry['date']}." if entry["date"] else ""
        cut = index % per_page == per_page - 1 and index + 1 < len(entries) and page % 2 == 1
        first_text = head + (entry["finds"][0] + "," if cut else ", ".join(entry["finds"]) + "." + dated)
        entry["pieces"] = [(_add(passages, page, first_text), first_text)]
        if cut:
            more = ", ".join(entry["finds"][1:]) + "." + dated
            entry["pieces"].append((_add(passages, page + 1, more), more))
        entry["cross_page"] = cut
        entry["evidence"] = _evidence(entry)
    gold = []
    for entry in entries:
        ev = entry["evidence"]
        decoys = [{**span, "supports": False} for other in entries if other is not entry and other["site"] == entry["site"]
                  for span in other["evidence"]["site"]]   # the same site text, another entry's
        fields = {"entry_no": {"value": entry["no"], "evidence": ev["entry_no"]},
                  "site": {"value": entry["site"], "evidence": ev["site"] + decoys},
                  "kreis": {"value": entry["kreis"], "evidence": ev["kreis"]},
                  "finds": {"value": entry["finds"], "evidence": ev["finds"]},
                  "date": {"value": entry["date"], "evidence": ev["date"]} if entry["date"] else {"absent": True}}
        gold.append({"cross_page": entry["cross_page"], "fields": fields})
    return {"id": case_id, "group": group or case_id, "split": split, "passages": passages, "schema": SCHEMA,
            "record_key": ["entry_no"], "exhaustive": True, "gold": gold}


def dataset(cases: list[dict]) -> dict:
    return {"version": 1, "cases": cases}

"""Score the PR #267 resolution comparison exactly as protocol.md (amendment 1) declares.

    python score.py OUT_DIR REPORT.json
Reads every `{N,Q}-*.json` capture, the sealed dev and held-out gold, and writes per-paper and total measures, the
items and places to adjudicate, and the acceptance verdict per condition.
"""
from __future__ import annotations

import json
import re
import sys
import unicodedata
from pathlib import Path

ABLATION = Path(__file__).resolve().parents[1] / "ablation-20261007"
SCALARS = ("title", "doi", "year")
VALUE_COLUMNS = ("thermal_value_celsius", "amino_acid_imino_acid_value", "amino_acid_hydroxyproline_value",
                 "amino_acid_proline_value")


def text(value) -> str | None:
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    folded = " ".join(unicodedata.normalize("NFKC", str(value)).casefold().split())
    return folded.rstrip(".") or None


def doi(value) -> str | None:
    value = text(value)
    if value is None:
        return None
    for prefix in ("https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "http://dx.doi.org/", "doi.org/",
                   "doi:", "doi "):
        if value.startswith(prefix):
            value = value[len(prefix):]
    return value.replace(" ", "") or None


def year(value) -> int | None:
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    try:
        return int(str(value).strip())
    except ValueError:
        return -1  # a non-integer reading is never the own year


NORMAL = {"title": text, "doi": doi, "year": year}


def number(value) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(str(value).replace(",", "").strip())
    except ValueError:
        return None


def gold() -> dict[str, dict]:
    papers = {}
    held = json.loads((ABLATION / "gold/gold_heldout.json").read_text())
    for paper in held["papers"]:
        papers[paper["document"]] = {"set": "held-out", "title": paper["paper_title"], "doi": paper["doi"] or None,
                                     "year": paper["year"], "rows": paper["rows"]}
    import openpyxl
    sheet = openpyxl.load_workbook(ABLATION / "gold/gold_dev_corrected.xlsx", read_only=True).worksheets[0]
    rows = list(sheet.iter_rows(values_only=True))
    header = rows[0]
    for values in rows[1:]:
        row = dict(zip(header, values))
        paper = papers.setdefault(row["document"], {"set": "dev", "title": row["paper_title"], "doi": row["doi"],
                                                    "year": row["year"], "rows": []})
        paper["rows"].append(row)
    return papers


def gold_name(source_name: str) -> str:
    """The gold document a capture's source is: a 360-dpi re-parse is named after the canonical run it re-parsed."""
    if not source_name.startswith("ocr360-"):
        return source_name
    run_id = source_name.removeprefix("ocr360-").removesuffix(".pdf")
    sources = json.loads((ABLATION / "run-dev-b1prime/extractor-config.json").read_text())["sources"]
    return next(source["source_name"] for source in sources if source["canonical_run_id"] == run_id)


def species_match(item_species, row_species) -> bool:
    a, b = text(item_species), text(row_species)
    return bool(a and b and (a == b or a in b or b in a))


def item_values(item: dict) -> list[float]:
    found = []
    for key in ("thermal_data", "amino_acids"):
        for each in item.get(key) or []:
            if isinstance(each, dict) and (value := number(each.get("value"))) is not None:
                found.append(value)
    return found


def row_values(row: dict) -> list[float]:
    return [value for column in VALUE_COLUMNS if (value := number(row.get(column))) is not None]


def matches(item: dict, row: dict) -> bool:
    if not species_match(item.get("species"), row.get("scientific_name")):
        return False
    wanted = row_values(row)
    if wanted:
        return any(abs(have - want) <= 0.005 for have in item_values(item) for want in wanted)
    tissue, printed = text(row.get("tissue")), text(item.get("tissue"))
    return bool(tissue and printed and (tissue in printed or printed in tissue))


def own(field: str, value, gold_value) -> bool:
    normal = NORMAL[field]
    return normal(value) == normal(gold_value)


def score_paper(capture: dict, paper: dict) -> dict:
    assembled, resolved = capture["assembly_alone"], capture["resolved"]
    readings = [reading["fields"] for reading in capture["readings"]]
    prompts = "\n".join(prompt["user"] for prompt in capture["resolution_prompts"])
    out: dict = {"parts": len(capture["parts"]), "resolved_called": capture["resolved_called"],
                 "resolution_calls": sum(len(p["calls"]) for p in capture["resolution_prompts"]),
                 "resolution_failed": sum(not c["ok"] for p in capture["resolution_prompts"] for c in p["calls"]),
                 "part_calls_failed": sum(not c["ok"] for r in capture["readings"] for c in r["calls"]),
                 "unsure_answers": sum(json.dumps(p["answer"]).count("UNSURE") for p in capture["resolution_prompts"]),
                 "null_list_answers": sum(1 for p in capture["resolution_prompts"] if isinstance(p["answer"], dict)
                                          for k, v in p["answer"].items() if k.startswith("L") and v is None)}
    if assembled is None:  # one part, or no part answered: nothing resolved, nothing to compare
        out["excluded"] = "resolution not called"
        return out
    # Scalars
    places = []
    for field in SCALARS:
        target = paper[field]
        read = [reading.get(field) for reading in readings]
        nonnull = [value for value in read if value is not None]
        before, after = assembled.get(field), resolved.get(field)
        state = lambda value: "own" if own(field, value, target) else ("null" if value is None else "wrong")
        place = {"field": field, "gold": target, "readings": read, "assembly": before, "resolved": after,
                 "assembly_state": state(before), "resolved_state": state(after),
                 "unopposed": len(nonnull) == 1 and len(read) > 1,
                 "own_read_by_a_part": any(own(field, value, target) for value in nonnull)}
        if place["assembly_state"] == "null":
            place["assembly_state"] = "null-conflict" if nonnull else "null-unread"
        shown = [line for line in prompts.splitlines()
                 if target is not None and "(printed " in line and any(
                     own(field, value, target) and json.dumps(value, ensure_ascii=False)[:200] in line
                     for value in nonnull)]
        place["own_printed_several"] = bool(shown)
        places.append(place)
    out["places"] = places
    out["own_assembly"] = sum(p["assembly_state"] == "own" for p in places)
    out["own_resolved"] = sum(p["resolved_state"] == "own" for p in places)
    out["scalar_losses"] = [p for p in places if p["assembly_state"] == "own" and p["resolved_state"] != "own"]
    out["scalar_gains"] = [p for p in places if p["assembly_state"] != "own" and p["resolved_state"] == "own"]
    out["unopposed_removed"] = [p for p in places if p["unopposed"] and p["assembly"] is not None and p["resolved"] is None]
    out["unopposed_own_removed"] = [p for p in out["unopposed_removed"] if own(p["field"], p["assembly"], p["gold"])]
    out["unopposed_kept"] = [p for p in places if p["unopposed"] and p["resolved"] is not None]
    out["printed_several_own_lost"] = [p for p in places if p["own_printed_several"] and p["resolved_state"] != "own"]
    # Items
    items_before = assembled.get("sample_records") or []
    items_after = resolved.get("sample_records") or []
    sources_before = {tuple(key): value for key, value in capture["capture"]["assembly"]["item_sources"]}
    sources_after = {tuple(key): value for key, value in capture["capture"]["resolution"]["item_sources"]}
    by_origin = {json.dumps(sources_before.get(("sample_records", index)), sort_keys=True): index
                 for index in range(len(items_before))}
    kept = set()
    for index, item in enumerate(items_after):
        origin = json.dumps(sources_after.get(("sample_records", index)), sort_keys=True)
        if origin in by_origin:
            kept.add(by_origin[origin])
        else:  # fall back to the first unclaimed equal item
            kept.add(next(i for i, each in enumerate(items_before) if each == item and i not in kept))
    rows = paper["rows"]
    matched = {index: [r for r, row in enumerate(rows) if matches(item, row)] for index, item in enumerate(items_before)}
    covered_before = {r for index in matched for r in matched[index]}
    covered_after = {r for index in kept for r in matched[index]}
    parts_of = {index: sorted({source["unit"] for source in sources_before.get(("sample_records", index)) or []})
                for index in range(len(items_before))}
    multi = {r for r in covered_before
             if len({unit for index in matched if r in matched[index] for unit in parts_of[index]}) > 1}
    dropped = [index for index in range(len(items_before)) if index not in kept]
    out.update({
        "gold_rows": len(rows), "items_assembled": len(items_before), "items_resolved": len(items_after),
        "rows_covered_assembly": len(covered_before), "rows_covered_resolved": len(covered_after),
        "rows_lost": sorted(covered_before - covered_after),
        "own_copies_dropped": [i for i in dropped if matched[i] and set(matched[i]) <= covered_after],
        "multi_part_rows": sorted(multi), "multi_part_rows_lost": sorted(multi - covered_after),
        "unmatched_dropped": [i for i in dropped if not matched[i]],
        "unmatched_kept": [i for i in kept if not matched[i]],
        "items": [{"index": i, "parts": parts_of[i], "kept": i in kept, "gold_rows": matched[i],
                   "item": items_before[i]} for i in range(len(items_before))],
        "lost_row_detail": [rows[r] for r in sorted(covered_before - covered_after)],
    })
    return out


def verdict(total: dict) -> dict:
    a1 = total["rows_lost"] <= 0.05 * total["rows_covered_assembly"]
    a2 = total["own_resolved"] >= total["own_assembly"] and total["scalar_losses"] <= 1
    a3 = total["multi_part_rows_lost"] == 0 and total["printed_several_own_lost"] <= 1
    a4 = total["unopposed_own_removed"] == 0
    return {"A1": a1, "A2": a2, "A3": a3, "A4": a4, "accepted": a1 and a2 and a3 and a4}


def main(out_dir: Path, report: Path) -> None:
    papers = gold()
    result = {"conditions": {}}
    for condition in ("N", "Q"):
        per_paper, total = {}, {}
        for path in sorted(out_dir.glob(f"{condition}-*.json")):
            capture = json.loads(path.read_text())
            name = gold_name(capture["source_name"])
            if name not in papers:
                raise SystemExit(f"no gold for {name}")
            scored = score_paper(capture, papers[name])
            scored["set"] = papers[name]["set"]
            per_paper[name] = scored
        keys = ("parts", "resolution_calls", "resolution_failed", "part_calls_failed", "unsure_answers",
                "null_list_answers", "own_assembly", "own_resolved", "gold_rows", "items_assembled", "items_resolved",
                "rows_covered_assembly", "rows_covered_resolved")
        listed = ("scalar_losses", "scalar_gains", "unopposed_removed", "unopposed_own_removed", "unopposed_kept",
                  "printed_several_own_lost", "rows_lost", "own_copies_dropped", "multi_part_rows",
                  "multi_part_rows_lost", "unmatched_dropped", "unmatched_kept")
        scored_papers = [p for p in per_paper.values() if "excluded" not in p]
        total = {key: sum(p.get(key, 0) for p in scored_papers) for key in keys}
        total.update({key: sum(len(p.get(key, [])) for p in scored_papers) for key in listed})
        total["papers"] = len(per_paper)
        total["excluded"] = [name for name, p in per_paper.items() if "excluded" in p]
        total["scalar_places"] = 3 * len(scored_papers)
        result["conditions"][condition] = {"total": total, "verdict": verdict(total), "papers": per_paper}
    report.write_text(json.dumps(result, ensure_ascii=False, indent=1, default=str))
    for condition, data in result["conditions"].items():
        print(condition, json.dumps(data["total"]), data["verdict"])


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))

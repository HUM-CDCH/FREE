"""Score the PR #275 measurement exactly as protocol.md declares.

    python score_p2s.py CAPTURES_DIR REPORT.json
CAPTURES_DIR holds `corpus/` (the 12 annotated papers) and `synthetic/` (the 4 generated documents), each with
`{N,Q}-*.json` captures from harness/run_paired.py. Writes every measure, the items to adjudicate and the verdict.
"""
from __future__ import annotations

import importlib.util
import json
import re
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("score267", HERE.parent / "pr267-resolution-comparison" / "score.py")
score267 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(score267)
TRUTH = HERE / "synthetic" / "documents"
CONDITIONS = ("N", "Q")


def canonical(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def list_blocks(user: str) -> dict[str, dict[str, tuple[str, object]]]:
    """Each list place of a resolution request: label -> (the label of its first equal item, the item shown)."""
    blocks = user.split("\n### Places\n", 1)[1].split("\n\n")
    out = {}
    for block in blocks:
        lines = block.splitlines()
        key = lines[0].split(" ", 1)[0]
        if not key.startswith("L"):
            continue
        items = {}
        for line in lines[1:]:
            label, rest = line.strip().split(" = ", 1)
            item, _ = json.JSONDecoder().raw_decode(rest)
            same = re.search(r"\(same value as (I\d+)\)$", rest)
            items[label] = (same.group(1) if same else label, item)
        out[key] = items
    return out


def label_events(prompts: list[dict]) -> list[dict]:
    """Every equal group (two or more equal items in one list part) and how its labels decide it."""
    events = []
    for prompt in prompts:
        answer = prompt["answer"] if isinstance(prompt["answer"], dict) else {}
        for key, items in list_blocks(prompt["user"]).items():
            labels = answer.get(key)
            if not isinstance(labels, dict):
                continue
            groups: dict[str, list[str]] = {}
            for label, (first, _) in items.items():
                groups.setdefault(first, []).append(label)
            for members in groups.values():
                if len(members) < 2:
                    continue
                reasons = [labels.get(label) for label in members]
                kind = ("repeat_beside_other_only" if "REPEAT" in reasons and "OTHER" in reasons and "OWN" not in reasons
                        else "repeat_beside_own" if "REPEAT" in reasons and "OWN" in reasons
                        else "all_repeat" if set(reasons) == {"REPEAT"} else "no_repeat")
                events.append({"key": key, "labels": dict(zip(members, reasons)), "kind": kind,
                               "item": items[members[0]][1]})
    return events


def view(capture: dict, which: str) -> dict:
    """The capture with `which` (resolution: the fix; baseline) in the slots score.py reads."""
    if which == "resolution":
        return capture
    return {**capture, "resolved": capture["baseline_resolved"], "resolution_prompts": capture["baseline_prompts"],
            "capture": {**capture["capture"], "resolution": capture["capture"]["baseline"]}}


def lists(root: dict | None) -> dict[str, list]:
    return {key: value for key, value in (root or {}).items() if isinstance(value, list)}


def codes(capture: dict, which: str) -> Counter:
    return Counter(issue["code"] for issue in capture["capture"].get(which, {}).get("issues", []))


def fits(capture: dict) -> list[dict]:
    """Every fix resolution call whose counted request and reply reserve exceed its context."""
    return [call for prompt in capture["resolution_prompts"] for call in prompt["calls"]
            if call["counted_input_tokens"] + call["max_output_tokens"] > call["context_tokens"]]


def unchanged_elsewhere(capture: dict, events: list[dict]) -> dict:
    """C2: without a baseline budget refusal, the baseline sent only the fix's requests, and the two results differ
    only in copies of a repeat beside another work's item alone."""
    exceeded = codes(capture, "baseline")["resolution_exceeds_budget"]
    out = {"baseline_exceeded": exceeded, "fix_requests": len(capture["resolution_prompts"]),
           "baseline_requests": len(capture["baseline_prompts"]),
           "baseline_reused": sum(p["reused"] for p in capture["baseline_prompts"])}
    fix, base = capture["capture"]["resolution"]["root"], capture["capture"]["baseline"]["root"]
    allowed = Counter(canonical(event["item"]) for event in events if event["kind"] == "repeat_beside_other_only"
                      for label, reason in event["labels"].items() if reason == "REPEAT")
    differing = Counter()
    for key in set(lists(fix)) | set(lists(base)):
        differing += Counter(canonical(item) for item in base.get(key) or []) - Counter(
            canonical(item) for item in fix.get(key) or [])
        differing += Counter(canonical(item) for item in fix.get(key) or []) - Counter(
            canonical(item) for item in base.get(key) or [])
    scalars_differ = [key for key in set(fix) | set(base) if not isinstance(fix.get(key, base.get(key)), list)
                      and canonical(fix.get(key)) != canonical(base.get(key))]
    out["items_differing"] = sum(differing.values())
    out["items_differing_outside_events"] = sum((differing - allowed).values())
    out["scalars_differing"] = scalars_differ
    out["holds"] = (exceeded > 0) or (out["baseline_reused"] == out["baseline_requests"] == out["fix_requests"]
                                      and out["items_differing_outside_events"] == 0 and not scalars_differ)
    return out


def score_corpus(directory: Path) -> dict:
    papers = score267.gold()
    result = {}
    for condition in CONDITIONS:
        per = {"fix": {}, "baseline": {}}
        checks, events_all = {}, {}
        for path in sorted(directory.glob(f"{condition}-*.json")):
            capture = json.loads(path.read_text())
            name = score267.gold_name(capture["source_name"])
            if name not in papers:
                raise SystemExit(f"no gold for {name}")
            events = label_events(capture["resolution_prompts"]) if capture["resolved_called"] else []
            events_all[name] = events
            for which, key in (("resolution", "fix"), ("baseline", "baseline")):
                scored = score267.score_paper(view(capture, which), papers[name])
                scored["set"] = papers[name]["set"]
                per[key][name] = scored
            if capture["resolved_called"]:
                checks[name] = unchanged_elsewhere(capture, events)
                checks[name]["fix_calls_over_budget"] = len(fits(capture))
        totals = {}
        for key in ("fix", "baseline"):
            scored_papers = [p for p in per[key].values() if "excluded" not in p]
            keys = ("own_assembly", "own_resolved", "gold_rows", "items_assembled", "items_resolved",
                    "rows_covered_assembly", "rows_covered_resolved", "resolution_calls", "resolution_failed",
                    "part_calls_failed", "unsure_answers", "null_list_answers", "parts")
            listed = ("scalar_losses", "scalar_gains", "unopposed_removed", "unopposed_own_removed", "unopposed_kept",
                      "printed_several_own_lost", "rows_lost", "own_copies_dropped", "multi_part_rows",
                      "multi_part_rows_lost", "unmatched_dropped", "unmatched_kept")
            total = {k: sum(p.get(k, 0) for p in scored_papers) for k in keys}
            total.update({k: sum(len(p.get(k, [])) for p in scored_papers) for k in listed})
            total["papers"] = len(per[key])
            total["excluded"] = [name for name, p in per[key].items() if "excluded" in p]
            total["scalar_places"] = 3 * len(scored_papers)
            totals[key] = {"total": total, "verdict": score267.verdict(total)}
        result[condition] = {"fix": totals["fix"], "baseline": totals["baseline"], "unchanged_elsewhere": checks,
                             "events": events_all, "papers": per}
    return result


def object_id(item) -> str | None:
    value = item.get("record_id") if isinstance(item, dict) else None
    return "".join(str(value).split()).upper() if value else None


def score_synthetic(directory: Path) -> dict:
    result = {}
    for condition in CONDITIONS:
        documents = {}
        for path in sorted(directory.glob(f"{condition}-*.json")):
            capture = json.loads(path.read_text())
            truth = json.loads((TRUTH / capture["source"] / "truth.json").read_text())
            own = {object_id(item) for item in truth["items"]}
            cited = {object_id(item) for item in truth["cited"]}
            out: dict = {"parts": len(capture["parts"]), "resolved_called": capture["resolved_called"],
                         "part_calls_failed": sum(not c["ok"] for r in capture["readings"] for c in r["calls"]),
                         "own_gold": len(own), "cited_gold": len(cited)}
            if not capture["resolved_called"] or capture["assembly_alone"] is None:
                out["excluded"] = "resolution not called"
                documents[capture["source"]] = out
                continue
            events = label_events(capture["resolution_prompts"])
            assembled = capture["assembly_alone"].get("items") or []

            def counts(items):
                ids = [object_id(item) for item in items]
                return {"items": len(items), "own_ids": {i for i in ids if i in own},
                        "own_copies": sum(i in own for i in ids), "cited_copies": sum(i in cited for i in ids),
                        "unmatched": [item for item, i in zip(items, ids) if i not in own and i not in cited]}
            before = counts(assembled)
            out["assembly"] = {**before, "own_ids": len(before["own_ids"]), "unmatched": len(before["unmatched"])}
            for which, key, root in (("resolution", "fix", capture["resolved"]),
                                     ("baseline", "baseline", capture["baseline_resolved"])):
                after = counts((root or {}).get("items") or [])
                deleted = sorted(before["own_ids"] - after["own_ids"])
                out[key] = {"items": after["items"], "own_ids": len(after["own_ids"]), "own_deleted": deleted,
                            "own_copies": after["own_copies"], "cited_copies": after["cited_copies"],
                            "unmatched_kept": len(after["unmatched"]),
                            "exceeded": codes(capture, which)["resolution_exceeds_budget"],
                            "resolution_failed": codes(capture, which)["resolution_failed"],
                            "list_parts": sum(1 for p in (capture["resolution_prompts"] if key == "fix"
                                                          else capture["baseline_prompts"])
                                              for k in list_blocks(p["user"])),
                            "requests": len(capture["resolution_prompts"] if key == "fix"
                                            else capture["baseline_prompts"])}
            out["baseline"]["reused"] = sum(p["reused"] for p in capture["baseline_prompts"])
            out["fix_calls_over_budget"] = len(fits(capture))
            out["unsure_answers"] = sum(json.dumps(p["answer"]).count("UNSURE") for p in capture["resolution_prompts"])
            out["null_list_answers"] = sum(1 for p in capture["resolution_prompts"] if isinstance(p["answer"], dict)
                                           for k, v in p["answer"].items() if k.startswith("L") and v is None)
            out["events"] = [{**event, "object_id": object_id(event["item"]),
                              "class": ("own" if object_id(event["item"]) in own else
                                        "cited" if object_id(event["item"]) in cited else "unmatched")}
                             for event in events]
            # S3: an own object gone after the fix with a copy dropped as a repeat beside another's item alone.
            other_only = {e["object_id"] for e in out["events"] if e["kind"] == "repeat_beside_other_only"}
            out["s3_violations"] = [i for i in out["fix"]["own_deleted"] if i in other_only]
            fix_root = capture["resolved"].get("items") or []
            kept = Counter(canonical(item) for item in fix_root)
            dropped = Counter(canonical(item) for item in assembled) - kept
            out["fix_dropped"] = [{"item": json.loads(item), "copies": n, "class": (
                "own" if object_id(json.loads(item)) in own else
                "cited" if object_id(json.loads(item)) in cited else "unmatched")} for item, n in dropped.items()]
            documents[capture["source"]] = out
        scored = [d for d in documents.values() if "excluded" not in d]
        own_assembly = sum(d["assembly"]["own_ids"] for d in scored)
        total = {"documents": len(documents), "excluded": [k for k, d in documents.items() if "excluded" in d],
                 "own_assembly": own_assembly}
        for key in ("fix", "baseline"):
            total[key] = {"own_deleted": sum(len(d[key]["own_deleted"]) for d in scored),
                          "own_ids": sum(d[key]["own_ids"] for d in scored),
                          "own_copies": sum(d[key]["own_copies"] for d in scored),
                          "cited_copies": sum(d[key]["cited_copies"] for d in scored),
                          "unmatched_kept": sum(d[key]["unmatched_kept"] for d in scored),
                          "exceeded": sum(d[key]["exceeded"] for d in scored),
                          "list_parts": sum(d[key]["list_parts"] for d in scored)}
        total["assembly"] = {k: sum(d["assembly"][k] for d in scored)
                             for k in ("items", "own_ids", "own_copies", "cited_copies", "unmatched")}
        total["fix_calls_over_budget"] = sum(d["fix_calls_over_budget"] for d in scored)
        total["events"] = Counter(e["kind"] for d in scored for e in d["events"])
        total["s3_violations"] = [i for d in scored for i in d["s3_violations"]]
        verdict = {
            "S1": total["fix"]["exceeded"] == 0 and total["fix_calls_over_budget"] == 0,
            "S2": total["fix"]["own_deleted"] <= 0.05 * own_assembly,
            "S3": not total["s3_violations"],
        }
        verdict["all"] = all(verdict.values()) and bool(scored)
        result[condition] = {"total": total, "verdict": verdict, "documents": documents}
    return result


def main(captures: Path, report: Path) -> None:
    corpus = score_corpus(captures / "corpus")
    synthetic = score_synthetic(captures / "synthetic")
    verdict = {}
    for condition in CONDITIONS:
        c1 = corpus[condition]["fix"]["verdict"]
        c2 = all(check["holds"] for check in corpus[condition]["unchanged_elsewhere"].values())
        verdict[condition] = {"C1": c1, "C2": c2, "synthetic": synthetic[condition]["verdict"],
                              "all": bool(c1.get("all")) and c2 and synthetic[condition]["verdict"]["all"]}
    report.write_text(json.dumps({"verdict": verdict, "corpus": corpus, "synthetic": synthetic},
                                 ensure_ascii=False, indent=1, default=list))
    for condition in CONDITIONS:
        print(condition, json.dumps(verdict[condition]))
        print("  corpus fix", json.dumps(corpus[condition]["fix"]["total"], default=list))
        print("  synthetic", json.dumps(synthetic[condition]["total"], default=list))


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))

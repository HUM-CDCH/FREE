"""Summarize rev-8 OCR contention results per phase: python3 analyze.py RESULTS_DIR [LABEL...]

For each document: seconds spent cutting (CPU layout), in OCR, and exporting; the OCR server's running and
waiting requests during that document's OCR phase; and, for an injected small document, the book's phase when it
started and how its time compares with the same document alone.
"""
import json
import sys
from pathlib import Path


def phases(record: dict) -> dict[str, tuple[float, float]]:
    marks = [(p["t"], p["name"]) for p in record.get("phases", [])] + [(record["end"], "end")]
    spans: dict[str, tuple[float, float]] = {"setup": (record["start"], marks[0][0] if marks else record["end"])}
    for (start, name), (end, _) in zip(marks, marks[1:]):
        spans[name] = (start, end)
    return spans


def load_window(samples: list[dict], start: float, end: float) -> dict:
    rows = [s for s in samples if start <= s["t"] <= end and "error" not in s]
    if not rows:
        return {}
    return {"running": round(sum(r["running"] for r in rows) / len(rows), 2),
            "waiting": round(sum(r["waiting"] for r in rows) / len(rows), 2),
            "waiting_max": max(r["waiting"] for r in rows)}


def phase_at(spans: dict, t: float) -> str:
    return next((name for name, (a, b) in spans.items() if a <= t < b), "after")


def main() -> None:
    directory = Path(sys.argv[1])
    labels = sys.argv[2:] or sorted(p.stem for p in directory.glob("*.json") if not p.stem.endswith(".samples"))
    for label in labels:
        report = json.loads((directory / f"{label}.json").read_text())
        samples = json.loads((directory / f"{label}.samples.json").read_text())
        print(f"\n## {label}  (SURYA_INFERENCE_PARALLEL={report['surya_parallel']})")
        spans_by_doc = {}
        for name, record in report["results"].items():
            if name == "warmup":
                continue
            if record.get("error"):
                print(f"  {name}: ERROR {record['error']}")
                continue
            spans = phases(record)
            spans_by_doc[name] = spans
            durations = {k: round(b - a, 1) for k, (a, b) in spans.items()}
            ocr = spans.get("ocr")
            crops = next((p["total"] for p in record["phases"] if p["name"] == "ocr"), None)
            print(f"  {name}: {record['seconds']} s total  phases={durations}  crops={crops}")
            if ocr:
                print(f"    OCR server during its OCR phase: {load_window(samples, *ocr)}")
        if "small" in spans_by_doc and "book" in spans_by_doc:
            small = report["results"]["small"]
            print(f"  small started during the book's '{phase_at(spans_by_doc['book'], small['start'])}' phase "
                  f"and finished during '{phase_at(spans_by_doc['book'], small['end'])}'")


if __name__ == "__main__":
    main()

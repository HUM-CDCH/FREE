"""Compare the records of two extraction results by entry number: python3 compare_records.py A.json B.json

Each file is a harness report; the records are those of its "doc", "split" or "big" extraction. Prints how many
entries match exactly, which are missing on either side, and every differing field.
"""
import json
import sys
from pathlib import Path

FIELDS = ("entry_no", "site_name", "bezirk", "kreis", "fundart")


def records(path: Path) -> dict:
    results = json.loads(path.read_text())["results"]
    run = results.get("doc") or results.get("split") or results.get("big")
    return {row.get("entry_no"): row for row in run["extracted"]}


def main() -> None:
    a, b = (records(Path(p)) for p in sys.argv[1:3])
    same, differences = 0, []
    for key in sorted(set(a) & set(b), key=lambda k: (k is None, k)):
        diff = {f: (a[key].get(f), b[key].get(f)) for f in FIELDS if a[key].get(f) != b[key].get(f)}
        if diff:
            differences.append((key, diff))
        else:
            same += 1
    print(f"entries: {len(a)} vs {len(b)}; identical: {same}; differing: {len(differences)}")
    print(f"only in first: {sorted(k for k in set(a) - set(b) if k is not None)}")
    print(f"only in second: {sorted(k for k in set(b) - set(a) if k is not None)}")
    for key, diff in differences[:30]:
        print(f"  entry {key}: {diff}")


if __name__ == "__main__":
    main()

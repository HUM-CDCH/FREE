"""Print the indexed source bodies for benchmark review candidates."""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
from typing import Any


BENCH_DIR = Path(__file__).resolve().parent
SUMMARY_PATH = BENCH_DIR / "results" / "summary.json"
DATABASE_PATH = BENCH_DIR / "work" / "base.db"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Show every indexed body belonging to one or more cluster IDs."
    )
    parser.add_argument("cluster_ids", nargs="+", help="Cluster IDs from summary.json")
    parser.add_argument(
        "--members-only",
        action="store_true",
        help="Print member locations without their indexed source bodies.",
    )
    return parser.parse_args()


def indexed_units() -> dict[int, dict[str, Any]]:
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute(
            """
            SELECT cu.id, f.path, cu.name, cu.start_line, cu.end_line, cu.body
            FROM code_units AS cu
            JOIN files AS f ON f.id = cu.file_id
            """
        ).fetchall()
    finally:
        connection.close()
    return {int(row["id"]): dict(row) for row in rows}


def clusters_by_id(summary: dict[str, Any]) -> dict[str, dict[str, Any]]:
    clusters: dict[str, dict[str, Any]] = {}
    for configuration in summary["configurations"]:
        for rank, cluster in enumerate(configuration["full_repository"]["top"], 1):
            entry = clusters.setdefault(
                cluster["id"],
                {"members": cluster["members"], "appearances": []},
            )
            entry["appearances"].append(
                f"{configuration['configuration']} #{rank} ({cluster['max_score']:.4f})"
            )
    return clusters


def main() -> None:
    args = parse_args()
    summary = json.loads(SUMMARY_PATH.read_text(encoding="utf-8"))
    clusters = clusters_by_id(summary)
    units = indexed_units()

    for cluster_id in args.cluster_ids:
        cluster = clusters.get(cluster_id)
        if cluster is None:
            raise SystemExit(f"Unknown cluster ID: {cluster_id}")
        print(f"\n## {cluster_id}")
        print(", ".join(cluster["appearances"]))
        for member in cluster["members"]:
            unit = units[int(member["unit_id"])]
            print(
                f"\n### {unit['path']}::{unit['name']} "
                f"lines {unit['start_line']}-{unit['end_line']}"
            )
            if not args.members_only:
                print("\n```text")
                print(str(unit["body"]).rstrip())
                print("\n```")


if __name__ == "__main__":
    main()

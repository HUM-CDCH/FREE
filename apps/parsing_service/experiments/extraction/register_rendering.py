"""Register the twelve-cell rendering comparison; this command performs no inference.

python -m experiments.extraction.register_rendering R1_MANIFEST R3_MANIFEST
"""
import argparse
import copy
import subprocess
from datetime import UTC, datetime
from pathlib import Path

from .manifest import checked, code_pin, pin, read, validate, write_new


def register(parent_path: Path, service: Path) -> dict:
    parent = read(parent_path)
    papers = set(read(checked(parent["evaluation"]["gold"]))["sources"])
    sources = [copy.deepcopy(source) for source in parent["sources"] if source["id"] in papers]
    if len(papers) != 6 or {source["id"] for source in sources} != papers:
        raise ValueError("R3 requires all six registered collagen sources")
    plain = copy.deepcopy(parent["methods"]["schema"])
    if plain["article"]["context"] != "full" or plain["article"].get("selection") is not None:
        raise ValueError("R3 requires the full-source schema method without selection")
    plain["article"].pop("rendering", None)
    plain["article"]["grounding"] = "off"
    structured = copy.deepcopy(plain)
    structured["article"]["rendering"] = "structured"
    for source in sources:
        source["methods"] = ["plain", "structured"]
    study = {key: copy.deepcopy(parent[key]) for key in (
        "version", "providers", "sampling", "evaluation", "primary_metric", "uncertainty")}
    study["evaluation"]["protocol"] = pin(Path(__file__).with_name("rendering-protocol.md"))
    study.update({
        "id": "extraction-rendering-20260927-r3", "registered_at": datetime.now(UTC).isoformat(),
        "base_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=service, text=True).strip(),
        "parent_manifest": pin(parent_path), "code_files": code_pin(service), "sources": sources,
        "methods": {"plain": plain, "structured": structured}, "repeats": 1, "order_seed": 20260927,
        "comparisons": [{"control": "plain", "treatment": "structured", "factor": "article.rendering"}],
        "interactions": [],
        "scope": "Fresh upstream-rendering comparison on six development papers; grounding disabled in both arms.",
    })
    validate(study, service)
    return study


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("parent", type=Path)
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()
    study = register(args.parent, Path(__file__).resolve().parents[2])
    write_new(args.manifest, study)
    print("Registered 12 cells; no inference performed.")


if __name__ == "__main__":
    main()

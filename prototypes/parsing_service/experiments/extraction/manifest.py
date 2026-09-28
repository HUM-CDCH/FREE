"""Pinned study inputs and declared comparisons, independent of inference and scoring."""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from pathlib import Path

from kei_exp.kie.extract.run import ExtractRequest
from kei_exp.kie.passages import load


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read(path: Path):
    return json.loads(path.read_text())


def write_new(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as target:
        temporary = Path(target.name)
        try:
            json.dump(value, target, ensure_ascii=False, indent=2)
            target.write("\n")
            target.flush()
            os.fsync(target.fileno())
            os.link(temporary, path)  # atomic publication that refuses to replace an existing artifact
        finally:
            temporary.unlink(missing_ok=True)


def pin(path: Path) -> dict:
    return {"path": str(path.resolve()), "sha256": digest(path.read_bytes())}


def checked(item: dict) -> Path:
    path = Path(item["path"])
    if digest(path.read_bytes()) != item["sha256"]:
        raise ValueError(f"changed pinned input: {path}")
    return path


def code_pin(service: Path) -> dict:
    files = sorted([*service.joinpath("src").rglob("*.py"), *service.joinpath("src").rglob("*.json"),
                    *service.joinpath("experiments/extraction").glob("*.py")])
    return {str(p.relative_to(service)): digest(p.read_bytes()) for p in files}


def flat(value, prefix="") -> dict:
    if isinstance(value, dict):
        return {key: item for name, child in value.items()
                for key, item in flat(child, f"{prefix}.{name}" if prefix else name).items()}
    return {prefix: value}


def differences(left: dict, right: dict) -> set[str]:
    left, right = flat(left), flat(right)
    return {key for key in left.keys() | right.keys() if left.get(key) != right.get(key)}


def request(source: dict, method: dict) -> ExtractRequest:
    options = json.loads(json.dumps(method))
    if options.get("article") is not None:
        options["article"]["identity_fields"] = source["identity_fields"]
    return ExtractRequest.model_validate({"schema": read(checked(source["schema"])), "options": options})


def validate(study: dict, service: Path, *, verify_files=True) -> list[dict]:
    if study["version"] != 1 or not study["sources"] or not study["methods"]:
        raise ValueError("study version 1 requires sources and methods")
    if type(study["repeats"]) is not int or study["repeats"] < 1:
        raise ValueError("repeats must be a positive integer")
    names = [source["id"] for source in study["sources"]]
    if len(set(names)) != len(names):
        raise ValueError("duplicate source IDs")
    for name in [study["id"], *names, *study["methods"]]:
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", name):
            raise ValueError(f"unsafe identifier: {name}")
    for comparison in study["comparisons"]:
        changed = differences(study["methods"][comparison["control"]], study["methods"][comparison["treatment"]])
        if changed != {comparison["factor"]}:
            raise ValueError(f"comparison {comparison} changes {sorted(changed)}, not exactly its declared factor")
    if verify_files:
        if code_pin(service) != study["code_files"]:
            raise ValueError("implementation changed since registration; register a new study revision")
        for item in study.get("evaluation", {}).values():
            checked(item)
    cells = []
    for source in study["sources"]:
        if source["exposure"] not in ("development", "unannotated"):
            raise ValueError("this protocol has no independent held-out annotations")
        if verify_files:
            checked(source["schema"])
            if source.get("pdf") is not None:
                checked(source["pdf"])
            for item in source["canonical_files"]:
                checked(item)
            evidence = load(Path(source["run"]))
            if (evidence.generation, evidence.digest) != (source["generation"], source["digest"]):
                raise ValueError(f"canonical generation changed for {source['id']}")
        for method in source["methods"]:
            configured = request(source, study["methods"][method]) if verify_files else None
            for repeat in range(study["repeats"]):
                cells.append({"id": f"{source['id']}--{method}--{repeat}", "source": source["id"],
                              "method": method, "repeat": repeat, "request": configured})
    return cells

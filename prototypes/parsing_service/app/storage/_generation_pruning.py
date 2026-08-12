"""Discovery and removal of abandoned canonical document generations."""

from __future__ import annotations

import shutil
from collections.abc import Iterator
from pathlib import Path

from app.storage import paths
from app.storage.atomic_json import read_json


def _iter_string_values(value: object) -> Iterator[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _iter_string_values(item)
    elif isinstance(value, list):
        for item in value:
            yield from _iter_string_values(item)


def _manifest_string_values(manifest: Path) -> Iterator[str]:
    try:
        payload = read_json(manifest)
    except ValueError:
        return
    yield from _iter_string_values(payload)


def _generation_dir_from_ref(ref: str, document_store: Path) -> Path | None:
    candidate = (paths.SERVICE_ROOT / ref).resolve()
    try:
        relative = candidate.relative_to(document_store)
    except ValueError:
        return None
    parts = relative.parts
    if len(parts) < 3 or parts[1] != "generations":
        return None
    return document_store.joinpath(*parts[:3]).resolve()


def _generation_dirs_in_manifest(
    manifest: Path,
    document_store: Path,
) -> Iterator[Path]:
    for value in _manifest_string_values(manifest):
        generation = _generation_dir_from_ref(value, document_store)
        if generation is not None:
            yield generation


def _referenced_generation_dirs(
    *,
    data_dir: Path,
    document_store: Path,
) -> set[Path]:
    pattern = f"*/{paths.PARSED_DOCUMENT_FILENAME}"
    manifests = list(document_store.glob(pattern))
    manifests.extend(data_dir.glob(pattern))
    resolved_store = document_store.resolve()
    referenced: set[Path] = set()
    for manifest in manifests:
        referenced.update(_generation_dirs_in_manifest(manifest, resolved_store))
    return referenced


def _document_dirs(base: Path) -> Iterator[Path]:
    for candidate in base.iterdir():
        if candidate.is_dir() and paths.is_sha256_hex(candidate.name):
            yield candidate


def _remove_tree(path: Path) -> bool:
    try:
        shutil.rmtree(path)
    except OSError:
        pass
    return not path.exists()


def _prune_generation_root(
    root: Path,
    *,
    referenced: set[Path] | None = None,
) -> int:
    if not root.exists():
        return 0
    removed = 0
    for generation in list(root.iterdir()):
        if not generation.is_dir():
            continue
        if referenced is not None and generation.resolve() in referenced:
            continue
        removed += _remove_tree(generation)
    return removed


def prune_orphan_document_generations(*, data_dir: Path, document_store: Path) -> int:
    """Remove pending and unreferenced published generation directories."""
    referenced = _referenced_generation_dirs(
        data_dir=data_dir,
        document_store=document_store,
    )
    removed = 0
    for document_dir in _document_dirs(document_store):
        removed += _prune_generation_root(document_dir / ".pending")
        removed += _prune_generation_root(
            document_dir / "generations",
            referenced=referenced,
        )
    return removed

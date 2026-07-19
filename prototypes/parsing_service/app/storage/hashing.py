"""Content and configuration hashing for document/preprocess identity."""

from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any


def compute_sha256(path_or_bytes: str | os.PathLike[str] | bytes) -> str:
    if isinstance(path_or_bytes, bytes):
        return hashlib.sha256(path_or_bytes).hexdigest()
    digest = hashlib.sha256()
    with open(Path(path_or_bytes), "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def document_id_from_hash(content_sha256: str) -> str:
    return f"sha256:{content_sha256}"


def compute_config_hash(config: Mapping[str, Any]) -> str:
    canonical = json.dumps(config, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def preprocess_id_from_hashes(content_sha256: str, config_hash: str) -> str:
    combined = hashlib.sha256(f"{content_sha256}:{config_hash}".encode()).hexdigest()
    return f"sha256:{combined}"

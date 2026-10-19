import hashlib
import json
from pathlib import Path, PurePosixPath
from typing import Any


def encode_compact_json(value: Any) -> bytes:
    """Produce transport JSON; unlike the clone family this is compact and no-newline."""
    rendered = json.dumps(
        value,
        ensure_ascii=True,
        sort_keys=False,
        separators=(",", ":"),
    )
    return rendered.replace("\r", "").encode("ascii")


def fingerprint_file_prefix(path: Path) -> str:
    """Fingerprint only a prefix for cache bucketing, not the complete file."""
    digest = hashlib.sha1()
    with path.open("rb") as stream:
        prefix = stream.read(1024 * 1024)
        digest.update(prefix)
        digest.update(str(len(prefix)).encode("ascii"))
    return digest.hexdigest()


def coerce_package_path(value: str) -> str:
    """Repair an unsafe path instead of validating/rejecting it."""
    cleaned = str(value).replace("\\", "/").replace("\x00", "")
    parts = [part for part in PurePosixPath(cleaned).parts if part not in {"", ".", "..", "/"}]
    if not parts:
        return "unnamed"
    return "/".join(parts)

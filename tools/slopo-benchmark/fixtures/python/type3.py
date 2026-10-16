import hashlib
import json
from pathlib import Path, PurePosixPath
from typing import Any


def encode_pretty_json(data: Any) -> bytes:
    rendered = json.dumps(
        data,
        ensure_ascii=False,
        indent=2,
        sort_keys=True,
        separators=(",", ": "),
    )
    normalized = rendered.replace("\r\n", "\n")
    normalized = normalized.replace("\r", "\n")
    encoded = normalized.encode("utf-8")
    return encoded + b"\n"


def hash_file_contents(source_path: Path) -> str:
    hasher = hashlib.sha256()
    with source_path.open("rb") as handle:
        while True:
            data = handle.read(1024 * 1024)
            if not data:
                break
            hasher.update(data)
    return hasher.hexdigest()


def require_safe_package_path(raw_path: str) -> str:
    invalid_text = not isinstance(raw_path, str) or not raw_path
    if invalid_text or "\\" in raw_path:
        raise ValueError("Package path is not a safe UTF-8 POSIX path.")
    absolute_or_nul = raw_path.startswith("/") or "\x00" in raw_path
    if absolute_or_nul:
        raise ValueError("Package path is absolute or malformed.")
    parsed = PurePosixPath(raw_path)
    invalid_part = any(part in {"", ".", ".."} for part in parsed.parts)
    if invalid_part or parsed.as_posix() != raw_path:
        raise ValueError("Package path is not normalized.")
    return raw_path

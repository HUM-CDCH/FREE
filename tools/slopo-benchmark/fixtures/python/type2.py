import hashlib
import json
from pathlib import Path, PurePosixPath
from typing import Any


def serialize_json_payload(payload: Any) -> bytes:
    return (
        json.dumps(
            payload,
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
            separators=(",", ": "),
        )
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .encode("utf-8")
        + b"\n"
    )


def compute_file_digest(file_path: Path) -> str:
    checksum = hashlib.sha256()
    with file_path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            checksum.update(block)
    return checksum.hexdigest()


def validate_archive_member(member_name: str) -> str:
    if not isinstance(member_name, str) or not member_name or "\\" in member_name:
        raise ValueError("Archive member is not a safe UTF-8 POSIX path.")
    if "\x00" in member_name or member_name.startswith("/"):
        raise ValueError("Archive member is absolute or malformed.")
    candidate = PurePosixPath(member_name)
    if str(candidate) != member_name or any(
        segment in {"", ".", ".."} for segment in candidate.parts
    ):
        raise ValueError("Archive member is not normalized.")
    return member_name

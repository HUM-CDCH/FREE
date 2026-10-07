"""The one encoding every hash in the pipeline is taken over, and the hash of a file's bytes.

A leaf: it imports nothing from `kei_exp`, because the producers and readers that have to agree on bytes sit in
different layers and must not depend on each other to agree. The ingest artifact's digest
(`kei_exp.kie.artifacts`), the accepted result's fingerprint (`kei_exp.result`) and the page-file digest a reader
recomputes (`kei_exp.pagefile`) are all taken over this encoding; putting it with any one of them would make the
others import that one's package to hash.

Contract: `docs/design/2026-09-14-kie-model-and-ingest-design.md` section 5.
"""

import hashlib
import json
from pathlib import Path
from typing import Any, Final

from pydantic import BaseModel

CHUNK: Final = 1 << 20  # bytes per read while hashing a file: a page raster is megabytes, not gigabytes

Serializable = BaseModel | dict[str, Any] | list[Any]


def canonical_json(value: Serializable) -> bytes:
    """The one encoding every hash in the pipeline is taken over (spec 5).

    A hash of an undefined encoding is not reproducible, so the encoding is defined here and nowhere else:
    models dumped in JSON mode, keys sorted, no whitespace, text kept as text, and no NaN or infinity, which
    JSON cannot express. Integer dict keys, such as `Source.page_size_pt`, become decimal strings here and
    are parsed back on load.
    """
    payload = value.model_dump(mode="json") if isinstance(value, BaseModel) else value
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode(
        "utf-8"
    )


def sha256_file(path: Path) -> str:
    """The hash of a file's bytes, read in chunks so a page raster need not be held in memory to be hashed."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(CHUNK):
            digest.update(chunk)
    return digest.hexdigest()

"""Parse one benchmark PDF through the Parsing Service's Docling adapter.

Run this script with ``prototypes/parsing_service/.venv``; grounding-lab's
environment intentionally does not install or duplicate the parser stack.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


def main(source: Path, output: Path) -> int:
    parsing_service = Path(__file__).resolve().parents[2] / "parsing_service"
    if importlib.util.find_spec("docling") is None:
        raise SystemExit(
            "Docling is unavailable. Run this script with "
            "prototypes/parsing_service/.venv/Scripts/python.exe on Windows "
            "or prototypes/parsing_service/.venv/bin/python on POSIX."
        )
    if not source.is_file():
        raise SystemExit(f"source PDF not found: {source}")
    sys.path.insert(0, str(parsing_service))
    from app.docling_parser import DoclingParser

    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    now = datetime.now(timezone.utc).isoformat()
    result = DoclingParser().parse(
        source,
        {
            "document_id": f"sha256:{digest}",
            "content_sha256": digest,
            "preprocess_id": "grounding-lab-final-v1",
            "source_name": source.name,
            "created_at": now,
            "started_at": now,
            "service_version": "grounding-lab",
        },
    )
    output.mkdir(parents=True, exist_ok=True)
    (output / "parsed_document.json").write_text(
        json.dumps(result.parsed_document, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (output / "document.md").write_text(str(result.markdown), encoding="utf-8")
    print(json.dumps(result.stats, indent=2))
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: parse-source.py SOURCE.pdf OUTPUT_DIR")
    raise SystemExit(main(Path(sys.argv[1]), Path(sys.argv[2])))

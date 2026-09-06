"""Inventory and parse the four user-selected PDFs; never read model outputs."""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

LAB = Path(__file__).resolve().parents[1]
SOURCE = Path.home() / "Downloads/OneDrive_2026-09-04/Grave Catalogues German"
SOURCES = {
    "beier": "Beier 1988 - GAC Germany - MES and Altmark/Beier1988_GAC_02_Catalogue.pdf",
    "bosch": "Bosch 2008 - eastern Bell Beaker graves/Katalog and tables.pdf",
    "wiermann": "Wiermann 2004 - Die Becherkulturen in Hessen/OCR/Wiermann2004_03_catalogue.pdf",
    "kirsch": "Kirsch 1993 - Middle Neolithic Brandenburg/Kirsch 1993 - Middle Neolithic Brandenburg 02.pdf",
}


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=LAB / "experiments/2026-09-05/holdout")
    parser.add_argument("--parse", action="store_true")
    parser.add_argument("--only", choices=tuple(SOURCES))
    args = parser.parse_args()
    args.root.mkdir(parents=True, exist_ok=True)
    prior = {digest(p): str(p.relative_to(LAB)) for d in LAB.glob("*sources*") if d.is_dir() for p in d.rglob("*.pdf")}
    entries = []
    for family, relative in SOURCES.items():
        source = SOURCE / relative
        sha = digest(source)
        entries.append({
            "family": family, "source": str(source), "sha256": sha,
            "priorIdenticalPdf": prior.get(sha),
            "relatedEditionsStayInFamily": True,
            "priorCitationExposure": family in {"beier", "kirsch"},
            "recordOverlapAudit": "pending source-only comparison; citations are not duplicate evaluation documents",
            "untouchedStatus": "excluded: previously evaluated PDF" if sha in prior else "pending record-overlap audit",
        })
        (args.root / family).mkdir(exist_ok=True)
    manifest = args.root / "sources.json"
    if not manifest.exists():
        manifest.write_text(json.dumps(entries, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    else:
        previous = json.loads(manifest.read_text(encoding="utf-8"))
        if [(e["family"], e["sha256"]) for e in previous] != [(e["family"], e["sha256"]) for e in entries]:
            raise ValueError("source inventory differs from the recorded manifest")
    print(json.dumps(entries, ensure_ascii=False, indent=2), flush=True)
    failures = 0
    if args.parse:
        for entry in entries:
            family = entry["family"]
            if args.only and family != args.only:
                continue
            dest = args.root / family
            if (dest / "parsed_document.json").exists():
                continue
            print(f"Parsing {family}", flush=True)
            with (dest / "parse.log").open("w", encoding="utf-8") as log:
                completed = subprocess.run(
                    [sys.executable, "-X", "utf8", str(LAB / "scripts/parse-source.py"), entry["source"], str(dest)],
                    stdout=log, stderr=subprocess.STDOUT,
                )
            (dest / "parse-status.json").write_text(json.dumps({"exitCode": completed.returncode, "sourceSha256": entry["sha256"]}) + "\n", encoding="utf-8")
            failures += completed.returncode != 0
            print(f"{family}: exit {completed.returncode}", flush=True)
    return int(bool(failures))


if __name__ == "__main__":
    raise SystemExit(main())

"""Canonical kei run directories for the extraction contention test, from the repository's catalogue fixture writer.

  big:   25 PDF pages, each a spread of two book pages with two columns, 2 entries per column: 200 numbered
         entries under Bezirk/Kreis headings that change every few pages, with running heads, like a real catalogue
  small: the repository's `continuations` fixture (4 entries)

Run from prototypes/parsing_service:  uv run python <this file> OUT_DIR
"""
import sys
from pathlib import Path

from tests.helpers import catalogue

SITES = ["Aue", "Bach", "Dorf", "Eck", "Feld", "Grund", "Hain", "Kamp", "Lohe", "Mark", "Rode", "Wald"]
KINDS = ["G", "EF", "Siedl.", "Hort"]
BEZIRKE = ["Süd", "Nord", "Ost", "West"]
KREISE = ["Moor", "Ried", "Heide", "Au", "Berg", "Tal"]


def big(pages: int = 25, per_column: int = 2) -> dict:
    number, book_page, spec = 40, 115, []
    for page in range(1, pages + 1):
        units = []
        for side in range(2):
            crops = []
            for column in range(2):
                segments: list = []
                if column == 0:
                    segments.append({"text": str(book_page), "label": "PageHeader"})
                    book_page += 1
                if column == 0 and side == 0 and page % 3 == 1:
                    segments += [f"Bezirk {BEZIRKE[(page // 3) % 4]}", f"Kreis {KREISE[(page // 3) % 6]}"]
                for _ in range(per_column):
                    site = SITES[number % len(SITES)]
                    segments += [f"{number}. {site}. Fdpl. {number % 7 + 1}. FA: {KINDS[number % 4]}. Funde:",
                                 "1. Scherben.", f"Mus. Halle {number % 50}."]
                    number += 1
                crops.append({"segments": segments})
            units.append({"index": 2 * page - 1 + side, "crops": crops})
        spec.append({"page": page, "units": units})
    return {"description": "synthetic big catalogue for rev8 contention tests", "pages": spec, "expected": {}}


def main() -> None:
    out = Path(sys.argv[1])
    catalogue.write(big(), out / "catalogue-big")
    catalogue.write("continuations", out / "catalogue-small")
    print("wrote", sorted(path.name for path in out.iterdir()))


if __name__ == "__main__":
    main()

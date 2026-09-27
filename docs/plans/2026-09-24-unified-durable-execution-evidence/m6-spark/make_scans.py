"""Create image-only PDFs for the Spark OCR and layout smoke test.

From the repository root:
prototypes/parsing_service/.venv/bin/python \
  docs/plans/2026-09-24-unified-durable-execution-evidence/m6-spark/make_scans.py \
  /tmp/free-m6-spark
"""

import sys
from pathlib import Path

import pypdfium2 as pdfium


ROOT = Path(__file__).resolve().parents[4]
GRAVES = ROOT / "examples" / "graves"
SCALE = 150 / 72


def pages(pdf_path: Path, count: int | None = None):
    document = pdfium.PdfDocument(pdf_path)
    try:
        total = len(document) if count is None else min(count, len(document))
        return [document[index].render(scale=SCALE).to_pil().convert("RGB") for index in range(total)]
    finally:
        document.close()


def write(images, target: Path) -> None:
    images[0].save(target, "PDF", resolution=150, save_all=True, append_images=images[1:])
    check = pdfium.PdfDocument(target)
    try:
        assert all(check[index].get_textpage().count_chars() == 0 for index in range(len(check))), "a text layer survived"
        print(f"{target.name}: {len(check)} pages")
    finally:
        check.close()


def main(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    write(pages(GRAVES / "Hvissinge_Ost_TAK_1728.pdf") + pages(GRAVES / "Hojbakkegaard_TAK_1177.pdf"), out / "large41-scan.pdf")
    write(pages(GRAVES / "Brondbylund_3_TAK_1506.pdf", 3), out / "small3-scan.pdf")
    write(pages(GRAVES / "Katrinesminde_SBM1116.pdf", 2), out / "layout2-scan.pdf")


if __name__ == "__main__":
    main(Path(sys.argv[1]))

"""Synthetic PDFs: the input the ingest accepts (one bilevel image per page), built at the size a test wants,
and a text-layer PDF for the native transcriber and anything that must skip OCR."""
import ctypes
from pathlib import Path

import numpy as np
import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_raw
from PIL import Image

DPI = 600.0
PAGE_SIZE = (300, 200)


def mask(size: tuple[int, int] = PAGE_SIZE, *, every: int = 10) -> np.ndarray:
    """A synthetic scan: one black row in `every`, which is as much of a page as single mode needs."""
    width, height = size
    ink = np.zeros((height, width), dtype=bool)
    ink[::every, width // 4: 3 * width // 4] = True
    return ink


def binary_pdf(path: Path, *masks: np.ndarray, dpi: float = DPI) -> Path:
    """A PDF whose pages each carry exactly one bilevel image, placed at `dpi`.

    `dpi` is a parameter because a few-row raster placed at a scanning resolution would be a fraction of a point
    tall, and would be refused for its placement before it could exercise anything else.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    images = [Image.fromarray(~painted) for painted in masks]
    images[0].save(path, "PDF", resolution=dpi, save_all=True, append_images=images[1:])
    for image in images:
        image.close()
    return path


def text_pdf(path: Path, pages: list[list[str]], font: Path | None = None) -> None:
    """One paragraph per page, a text object per line. The stock Helvetica keeps no soft hyphen (it prints as ÿ);
    an embedded TrueType font, when one is given, keeps every character."""
    with pdfium.PdfDocument.new() as pdf:
        if font is not None:
            data = font.read_bytes()
            loaded = pdfium_raw.FPDFText_LoadFont(pdf, (ctypes.c_ubyte * len(data)).from_buffer_copy(data), len(data),
                                                  pdfium_raw.FPDF_FONT_TRUETYPE, 1)
        for lines in pages:
            page = pdf.new_page(595, 842)
            for n, line in enumerate(lines):
                obj = pdfium_raw.FPDFPageObj_CreateTextObj(pdf, loaded, 11.0) if font is not None else \
                    pdfium_raw.FPDFPageObj_NewTextObj(pdf, b"Helvetica", 11.0)
                pdfium_raw.FPDFText_SetText(obj, ctypes.cast((line + "\0").encode("utf-16-le"),
                                                             pdfium_raw.FPDF_WIDESTRING))
                pdfium_raw.FPDFPageObj_Transform(obj, 1, 0, 0, 1, 72, 770 - 14 * n)
                pdfium_raw.FPDFPage_InsertObject(page, obj)
            page.gen_content()
        pdf.save(path)

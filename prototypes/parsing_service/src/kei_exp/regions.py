"""The OCR stage's crop data: a region of a source page, the crop rendered from it, the report's description of a
crop, and the layout detectors a cut may run on.

A leaf beside `kei_exp.geometry`: no pdfium and no docling, so the transcriber contract, the result writer and the API
can name crops and layout models without importing the detector. The cut that finds regions and renders crops is
`kei_exp.cut`.
"""
from dataclasses import asdict, dataclass

from PIL import Image

from kei_exp.geometry import CropTransform, PointBox

DEFAULT_LAYOUT_MODEL = "layout_heron_101"
LAYOUT_MODELS = {
    "layout_heron_default": "Heron",
    "layout_heron_101": "Heron-101",
    "layout_egret_xlarge": "Egret XLarge",
}


@dataclass(frozen=True)
class Region:
    kind: str    # page | column | band | figure
    bbox: PointBox
    order: int   # reading order within the source page
    ink: float   # share of the page's ink (dark pixels inside the scanner border) inside the crop
    transform: CropTransform | None = None  # how the rendered crop maps back to the page; set once it is rendered


Crop = tuple[int, Region, Image.Image]  # source page number, region, rendered crop


def region_info(crop: Crop | None) -> dict | None:
    """The report's description of a crop: its source page plus the Region fields, ink share included; the render
    transform belongs to the result files, not the debug report."""
    if crop is None:
        return None
    page, region, _ = crop
    return {"source_page": page, **{name: value for name, value in asdict(region).items() if name != "transform"}}

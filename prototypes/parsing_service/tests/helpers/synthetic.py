"""Hand-built outcomes over `main.pdf`, covering what no recorded run does: an errored block, a table block, an
empty page, a capped page, an all-blank cut, whole pages with an engine transform, a page with no boxes at all.
Built from the same interfaces the replay uses, so the version 3 writer at e5ad72f and the version 4 writer see
the same inputs."""
from collections.abc import Callable
from pathlib import Path

from PIL import Image

from kei_exp.models import MODELS
from kei_exp.pages import CropTransform
from kei_exp.regions import Region
from kei_exp.result import Input, Inventory, Source
from kei_exp.transcription.types import DEFAULT_URL, Execution, PageRecord, Transcription
from tests.helpers.replay import Replay

NOMINAL = 72 / 250
TABLE = "<table><tr><td>Fdpl.</td><td>2</td></tr><tr><td>Mbl.</td><td>1827 (3436)</td></tr></table>"
TABLE_TEXT = "Fdpl.\t2\t\nMbl.\t1827 (3436)"  # a tab where a cell ends, a newline where a row does, the end stripped
ERROR = "page 1 (source page 1, region 0): 1 block came back in error"  # the seam's reason for an errored block


def execution(pdf: Path, workdir: Path, **overrides) -> Execution:
    fields = {"pdf": pdf, "transcriber": "surya", "model": "surya", "repo": MODELS["surya"].repo, "url": DEFAULT_URL,
              "cut": "auto", "layout_model": "layout_heron_101", "crop_dpi": 250, "max_image_size": None,
              "max_output_tokens": None, "stream": False, "pages": None, "debug_dir": None,
              "result_dir": workdir / "result", "page_source": "pdf", "ingest_dir": None, "source_name": "scan.pdf"}
    return Execution(**{**fields, **overrides})


def block(bbox, html="<p>Grüße</p>", label="Text", confidence=0.98, skipped=False, error=False) -> dict:
    return {"polygon": [], "confidence": confidence, "label": label, "raw_label": label, "reading_order": 0,
            "html": html, "skipped": skipped, "error": error, "bbox": list(bbox)}


def record(ordinal, *, blocks=None, image_bbox=None, markdown="md", text="txt", incomplete=None, source_page=None,
           region=None, input_tokens=10, output_tokens=20) -> PageRecord:
    payload = {} if blocks is None else {"blocks": blocks, "image_bbox": image_bbox or [0, 0, 100, 100]}
    return PageRecord(page=ordinal, region=region, image=None, seconds=None, input_tokens=input_tokens,
                      output_tokens=output_tokens, stop=None, capped=False, payload=payload, stats={},
                      markdown=markdown, text=text, incomplete=incomplete, source_page=source_page)


def crop(page, kind, bbox, order, transform, size=(500, 700)):
    return (page, Region(kind, bbox, order, 0.5, transform), Image.new("L", size))


def three_crops() -> tuple[list, Inventory]:
    """Two crops on page 1, one on page 2, page 3 ink-free (as `scratch/check_result.py` built them)."""
    crops = [crop(1, "column", (100.0, 200.0, 300.0, 500.0), 0, CropTransform(100.0, 200.0, NOMINAL, NOMINAL, None)),
             crop(1, "figure", (320.0, 200.0, 500.0, 400.0), 1, CropTransform(320.0, 200.0, NOMINAL, NOMINAL, None)),
             crop(2, "page", (0.0, 0.0, 400.0, 600.0), 0, CropTransform(0.0, 0.0, NOMINAL, NOMINAL, None))]
    return crops, Inventory([1, 2, 3], [Input(1, 1, 0, crops[0]), Input(2, 1, 0, crops[1]), Input(3, 2, 0, crops[2])], None)


def hand_built(pdf: Path, workdir: Path) -> Replay:
    """A text block and an errored header on page 1's first crop, nothing on its second, a table block on page 2."""
    _, inventory = three_crops()
    outcome = Transcription({"max_size": None, "scale": None}, [
        record(1, blocks=[block((0, 0, 250, 125)), block((10, 20, 30, 40), "<h1>T</h1>", "SectionHeader", 0.5, True, True)],
               markdown="# T\n\nGrüße", text="Grüße\nT", incomplete=ERROR),
        record(2, blocks=[], markdown="", text=""),
        record(3, blocks=[block((100, 100, 200, 200), TABLE, "Table")], markdown="| Fdpl. | 2 |", text=TABLE_TEXT),
    ])
    made = execution(pdf, workdir)
    return Replay(made, inventory, outcome, Source.of(made), None, None)


def capped(pdf: Path, workdir: Path) -> Replay:
    """An incomplete record publishes every page all the same: the reason on the crop, the page and the manifest."""
    _, inventory = three_crops()
    outcome = Transcription({}, [record(1, blocks=[block((0, 0, 250, 125))], incomplete="page 1 stopped at its cap"),
                                 record(2, blocks=[]), record(3, blocks=[])], unattributed="content is missing")
    made = execution(pdf, workdir)
    return Replay(made, inventory, outcome, Source.of(made), None, None)


def blank_cut(pdf: Path, workdir: Path) -> Replay:
    """The cut found nothing on two pages: no input anywhere, and every page file still says what happened to it."""
    outcome = Transcription({}, [], unattributed="the layout cut found no content")
    made = execution(pdf, workdir)
    return Replay(made, Inventory([1, 2], [], None), outcome, Source.of(made), None, None)


def whole_pages(pdf: Path, workdir: Path) -> Replay:
    """Uncut pages 3 and 4: Surya's blocks under the whole-image transform, and a page whose transcriber gave no boxes."""
    inventory = Inventory([3, 4], [Input(1, 3, 0, None), Input(2, 4, 0, None)], None)
    outcome = Transcription({"max_size": None, "scale": 192 / 72}, [
        record(1, blocks=[block((192, 0, 384, 96)), block((0, 96, 100, 100), "<p>b</p>")], image_bbox=[0, 0, 1587, 2245],
               source_page=3, markdown="a\n\nb", text="a\nb"),
        record(2, source_page=4, markdown="# Plain", text="Plain"),
    ])
    made = execution(pdf, workdir, cut="none", pages=(3, 4))
    return Replay(made, inventory, outcome, Source.of(made), None, None)


def cases() -> dict[str, Callable[[Path, Path], Replay]]:
    return {"hand-built": hand_built, "capped": capped, "blank-cut": blank_cut, "whole-pages": whole_pages}

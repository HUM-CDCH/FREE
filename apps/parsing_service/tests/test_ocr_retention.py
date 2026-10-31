"""A run's rasters are bounded by one batch, not by the run's length (`kei_exp.kie.stages.ocr.transcribe`).

Every test runs the production OCR stage (`ocr.run`) over synthetic PDFs or book pages. Only the leaf model work is
replaced: a recording transcriber, Surya's `_generate_one` behind its real adapter and RecognitionPredictor, Docling's
converter call behind the real VLM adapter, and, for the cut, the layout model (one region per page). `live` counts
the PIL images that are still open, neither closed nor collected, wherever they were made.
"""
import json
import weakref
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pypdfium2 as pdfium
import pytest
from docling.datamodel.base_models import (
    ConversionStatus,
    DoclingComponentType,
    ErrorItem,
    VlmPrediction,
    VlmStopReason,
)
from docling.document_converter import DocumentConverter
from PIL import Image
from PIL._util import DeferredError
from pypdf import PdfReader, PdfWriter

import kei_exp.result as result_module
from kei_exp import cut
from kei_exp.failures import KeiFailure
from kei_exp.kie.ingest_model import Page as IngestPage
from kei_exp.kie.ingest_model import Placement
from kei_exp.kie.stages import ocr
from kei_exp.models import MODELS
from kei_exp.pagefile import load_result
from kei_exp.pages import MAX_RENDER_PIXELS, BookPages, PdfPage, PdfPages
from kei_exp.regions import Region, region_info
from kei_exp.transcription import html as html_export
from kei_exp.transcription import surya
from kei_exp.transcription.types import (
    ArtworkNeedsContext,
    ConversionError,
    Execution,
    IncompleteConversionError,
    OcrRegion,
    PageRecord,
    RunParams,
    Transcription,
)
from tests.helpers.fake import registered
from tests.helpers.pdfs import binary_pdf, mask

HEADER = {"prompt": None, "scale": None, "max_size": None, "max_output_tokens": None, "generation_params": None,
          "errors": []}


@pytest.fixture
def live(monkeypatch):
    """The PIL images made during the test that are still open: not closed, and not collected."""
    Image.init()  # Pillow's plugins first: one keeps a prototype image of its own at import
    made = []
    init = Image.Image.__init__

    def tracked(self, *args, **kwargs):
        init(self, *args, **kwargs)
        made.append(weakref.ref(self))
    monkeypatch.setattr(Image.Image, "__init__", tracked)

    def open_images() -> list[Image.Image]:
        return [image for ref in made
                if (image := ref()) is not None and image.im is not None and not isinstance(image.im, DeferredError)]
    return open_images


@pytest.fixture
def one_region_per_page(monkeypatch):
    """The layout model replaced: every page is one region, so the cut renders each page once at crop dpi."""
    monkeypatch.setattr(cut, "find_regions", lambda page, number, layout_model: [
        Region("page", (0.0, 0.0, *page.get_size()), 0, 1.0)])


class Recorder:
    """A transcriber that, as Surya does, hands each crop back as its record's image, and records at every call the
    inputs it was given and the images open meanwhile. Numbers its records by the run's ordinal, as every adapter."""
    kind = "fake"
    knobs = frozenset({"stream"})

    def __init__(self, live, *, fail_on_call: int | None = None, incomplete: frozenset[int] = frozenset()) -> None:
        self.live = live
        self.fail_on_call = fail_on_call
        self.incomplete = incomplete
        self.calls: list[SimpleNamespace] = []

    def transcribe(self, execution, crops, emit) -> Transcription:
        batch = getattr(execution, "batch", None)
        offset = batch[0] - 1 if batch else 0
        opened = self.live()
        self.calls.append(SimpleNamespace(first=offset + 1, inputs=len(crops), open=len(opened),
                                          pixels=sum(image.width * image.height for image in opened)))
        if len(self.calls) == self.fail_on_call:
            raise ConnectionError("the model server went away")
        records = []
        for number, crop in enumerate(crops, offset + 1):
            records.append(PageRecord(
                page=number, region=region_info(crop), image=crop[2], seconds=None, input_tokens=1, output_tokens=2,
                stop=None, capped=False, stats={},
                payload={"blocks": [{"reading_order": 0, "label": "Text", "confidence": 0.9, "bbox": [1, 2, 30, 40],
                                     "html": f"<p>input {number}</p>", "skipped": False, "error": False}]},
                markdown=f"input {number}", text=f"input {number}", source_page=None,
                incomplete=f"page {number}: lost a line" if number in self.incomplete else None))
        return Transcription(HEADER, records)


def scans(path: Path, count: int, *masks) -> Path:
    """A scanned PDF of `count` small pages (36 x 24 pt, 125 x 84 px at 250 dpi), or of the masks given."""
    return binary_pdf(path, *(masks or [mask()] * count))


def blank_pdf(path: Path, count: int, size: tuple[float, float] = (36.0, 24.0)) -> Path:
    with pdfium.PdfDocument.new() as document:
        for _ in range(count):
            document.new_page(*size).close()
        document.save(str(path))
    return path


def book(tmp_path: Path, count: int) -> BookPages:
    """`count` book pages of 300 x 200 px at 600 dpi, each alone on its spread, as the ingest publishes them."""
    pages = []
    for index in range(1, count + 1):
        image = Image.new("1", (300, 200), 1)
        image.paste(0, (75, 0, 225, 200))
        image.save(tmp_path / f"page-{index}.png")
        pages.append(IngestPage(index=index, spread=index, side="single", image=f"page-{index}.png", width_px=300,
                                height_px=200, sha256="0" * 64, source_rect=(0, 0, 300, 200), spread_width_px=300,
                                spread_height_px=200, dpi_x=600.0, dpi_y=600.0, gutter_x_px=None,
                                gutter_method="none", gutter_reason=None, gutter_evidence=None,
                                placement=Placement(a=36.0, b=0.0, c=0.0, d=24.0, e=0.0, f=0.0,
                                                    page_width_pt=36.0, page_height_pt=24.0)))
    return BookPages(tmp_path, pages)


def converted(tmp_path: Path, count: int, source: str, recorder: Recorder, **params) -> str:
    """One run of `count` inputs through the recorder: the cut over a scanned PDF, or whole book pages."""
    directory = tmp_path / f"{source}-{count}"
    directory.mkdir()
    with registered(recorder):
        if source == "pdf-cut":
            execution = ocr.resolve(RunParams(pdf=scans(directory / "scan.pdf", count), model="fake",
                                              result_dir=directory / "result", **params))
            assert execution.cut == "auto" and execution.transcriber == "fake"
            return ocr.run(execution, lambda event: None)
        pages = book(directory, count)
        execution = Execution(pdf=blank_pdf(directory / "spreads.pdf", count), transcriber="fake", model="fake",
                              repo="fake/model", url="http://unused", cut="none", layout_model=None, crop_dpi=250,
                              max_image_size=None, max_output_tokens=None, stream=False, pages=None,
                              result_dir=directory / "result", page_source="ingest", ingest_dir=directory,
                              debug_dir=params.get("debug_dir"))
        return ocr.run(execution, lambda event: None, book=pages)


@pytest.mark.parametrize("debug", [False, True], ids=["no debug", "debug"])
@pytest.mark.parametrize("source", ["pdf-cut", "book-pages"])
def test_a_ten_times_longer_run_holds_no_more_open_images(tmp_path, live, one_region_per_page, source, debug):
    """The images open while the transcriber runs are its own call's crops, never an earlier call's; their number
    does not grow with the run, and every image is closed when the run returns."""
    peaks = []
    for count in (40, 400):
        recorder = Recorder(live)
        debug_dir = tmp_path / f"debug-{source}-{count}" if debug else None
        markdown = converted(tmp_path, count, source, recorder, debug_dir=debug_dir)
        assert [call.open for call in recorder.calls] == [call.inputs for call in recorder.calls], recorder.calls
        assert sum(call.inputs for call in recorder.calls) == count and live() == []
        firsts = [1]
        for call in recorder.calls[:-1]:
            firsts.append(firsts[-1] + call.inputs)
        assert [call.first for call in recorder.calls] == firsts  # each call numbered by the run's ordinals
        assert markdown.split("\n\n") == [f"input {n}" for n in range(1, count + 1)]
        assert len(load_result(tmp_path / f"{source}-{count}" / "result").pages) == count
        if debug:
            report = json.loads((debug_dir / "report.json").read_text(encoding="utf-8"))
            assert [entry["page"] for entry in report["pages"]] == list(range(1, count + 1))
            assert all((debug_dir / f"page-{n}.png").exists() for n in range(1, count + 1))
            assert len({tuple(entry["image_pixels"]) for entry in report["pages"]}) == 1
        peaks.append(max(call.open for call in recorder.calls))
    assert peaks[0] == peaks[1], peaks


LARGE = 1250 * 1250  # a 3000 px square at 600 dpi, 360 pt, cut at 250 dpi


@pytest.mark.parametrize("budget", [2.5, 0.5], ids=["two large crops", "under one large crop"])
def test_a_batch_holds_few_large_crops_however_many_small_ones_the_count_allows(tmp_path, live, monkeypatch,
                                                                                one_region_per_page, budget):
    """Twelve inputs fit the count limit together; the bytes limit keeps at most `budget` large crops in a batch,
    and a crop over the whole budget alone, at the size the render budget allows it."""
    monkeypatch.setattr(ocr, "CROP_BYTES", 6, raising=False)
    monkeypatch.setattr(ocr, "BATCH_BYTES", int(budget * LARGE * 6), raising=False)
    large, small = mask((3000, 3000), every=50), mask()
    pdf = scans(tmp_path / "mixed.pdf", 0, large, small, small, large, small, large, large, small, small, large,
                large, large)
    recorder = Recorder(live)
    with registered(recorder):
        ocr.run(ocr.resolve(RunParams(pdf=pdf, model="fake", result_dir=tmp_path / "result")), lambda event: None)
    assert sum(call.inputs for call in recorder.calls) == 12 and live() == []
    for call in recorder.calls:
        assert call.pixels <= max(budget, 1) * LARGE, recorder.calls
        if call.pixels >= LARGE and budget < 1:
            assert call.inputs == 1, recorder.calls
    assert load_result(tmp_path / "result").manifest.status == "success"


class Stopped(Exception):
    pass


@pytest.mark.parametrize("failure", ["transcriber", "render", "cancel", "debug"])
def test_a_run_stopping_in_a_later_batch_leaves_no_image_open(tmp_path, live, monkeypatch, one_region_per_page,
                                                              failure):
    """40 inputs, two batches. A transcriber failure, a render failure and a cancel in the second batch leave no
    image open and publish nothing; a cancel renders nothing further. A debug image that cannot be written stops the
    report, never the run, which publishes."""
    pdf = scans(tmp_path / "scan.pdf", 40)
    recorder = Recorder(live, fail_on_call=2 if failure == "transcriber" else None)
    renders, events = [], []
    native = PdfPage.render

    def render(page, dpi, bbox=None, **options):
        renders.append(dpi)
        if failure == "render" and len(renders) == 35:
            raise ValueError("a broken page")
        return native(page, dpi, bbox, **options)
    monkeypatch.setattr(PdfPage, "render", render)
    points = []

    def emit(event):
        events.append(event)
        if failure == "cancel" and event["type"] == "cancel_point":
            points.append(event)
            if len(points) == 2:  # the second batch
                raise Stopped
    save = Image.Image.save

    def saving(image, path, *args, **kwargs):
        if failure == "debug" and Path(path).name == "page-33.png":
            raise OSError("debug directory is gone")
        return save(image, path, *args, **kwargs)
    monkeypatch.setattr(Image.Image, "save", saving)
    expected = {"transcriber": ConnectionError, "render": ConversionError, "cancel": Stopped}.get(failure)
    with registered(recorder):
        execution = ocr.resolve(RunParams(pdf=pdf, model="fake", result_dir=tmp_path / "result",
                                          debug_dir=tmp_path / "debug" if failure == "debug" else None))
        if expected is None:
            assert ocr.run(execution, emit).split("\n\n")[-1] == "input 40"
        else:
            with pytest.raises(expected) as raised:
                ocr.run(execution, emit)
    assert live() == [], live()  # an earlier batch's, and the stopped batch's, images included
    if failure == "render":
        assert "a broken page" in str(raised.value)
    if failure == "cancel":
        assert len(renders) == 32 and [call.inputs for call in recorder.calls] == [32]
    if expected is not None:
        assert not (tmp_path / "result").exists()
        return
    assert load_result(tmp_path / "result").manifest.status == "success"
    logs = [event["text"] for event in events if event["type"] == "log"]
    assert logs.count("Debug report not written: debug directory is gone") == 1, logs
    assert not (tmp_path / "debug" / "report.json").exists()


@pytest.mark.parametrize("debug", [False, True], ids=["no debug", "debug"])
def test_batches_publish_the_same_files_as_one_call_over_every_input(tmp_path, live, monkeypatch,
                                                                     one_region_per_page, debug):
    """The page files, their hashes, the manifest and the debug report are the same however the inputs were batched
    (the generation pinned; started and seconds are timing), incomplete inputs in two batches included."""
    pdf = scans(tmp_path / "scan.pdf", 40)
    monkeypatch.setattr(result_module, "new_generation", lambda: "20261025T000000.000000Z-00000000")
    published = {}
    for name, size in (("one call", 1000), ("batches of 7", 7)):
        monkeypatch.setattr(ocr, "BATCH_INPUTS", size, raising=False)
        recorder = Recorder(live, incomplete=frozenset({3, 30}))
        directory = tmp_path / name
        with registered(recorder), pytest.raises(IncompleteConversionError) as raised:
            ocr.run(ocr.resolve(RunParams(pdf=pdf, model="fake", result_dir=directory / "result",
                                          debug_dir=directory / "debug" if debug else None)), lambda event: None)
        files = {}
        for path in sorted(directory.rglob("*")):
            if path.is_file():
                data = path.read_bytes()
                if path.name in ("result.json", "report.json"):
                    data = {key: value for key, value in json.loads(data).items() if key not in ("started", "seconds")}
                files[str(path.relative_to(directory))] = data
        published[name] = (files, str(raised.value), [call.inputs for call in recorder.calls])
        assert live() == []
    (one, one_error, one_calls), (many, many_error, many_calls) = published.values()
    assert one_calls == [40] and many_calls == [7, 7, 7, 7, 7, 5]
    assert one == many and one_error == many_error and "page 3: lost a line; page 30: lost a line" in one_error
    assert len([name for name in one if name.startswith("result/pages/")]) == 40
    if debug:
        assert len([name for name in one if name.endswith(".png")]) == 40


# --- Uncut Surya: its own loader reads one batch of pages at a time ------------------------------------------------


class SuryaLeaf:
    """Surya's real adapter and RecognitionPredictor with only the leaf request replaced (and the backend's
    parallelism, 1): records the images open at every request and every page range the whole-page loader reads."""

    TEXT = '<div data-bbox="0 0 1000 1000" data-label="Text"><p>synthetic</p></div>'

    def __init__(self, monkeypatch, live) -> None:
        from surya import inference
        from surya.inference.backends import openai_client
        self.live, self.open, self.ranges = live, [], []
        self.loaded: list[Image.Image] = []  # held here, so an image left unclosed is not merely collected
        backend = SimpleNamespace(_client=object(), _client_parallel=lambda: 1,
                                  start=lambda: SimpleNamespace(model_name=MODELS["surya"].repo))
        monkeypatch.setattr(inference, "SuryaInferenceManager", lambda: SimpleNamespace(backend=backend))
        monkeypatch.setattr(openai_client, "_generate_one", self.generate_one)
        loader = surya.whole_pages

        def loading(pdf, pages, dpi):
            images = loader(pdf, pages, dpi)
            self.ranges.append(pages or (1, len(images)))
            self.loaded.extend(images)
            return images
        monkeypatch.setattr(surya, "whole_pages", loading)

    def generate_one(self, item, *, client, **options):
        self.open.append(len(self.live()))
        client.finish_reason = "stop"
        return SimpleNamespace(raw=self.TEXT, token_count=2, error=False, mean_token_prob=1.0, logprobs=None)


def test_uncut_surya_loads_and_holds_one_batch_of_pages_at_a_time(tmp_path, live, monkeypatch):
    peaks = []
    for count in (40, 80):
        leaf = SuryaLeaf(monkeypatch, live)
        pdf = scans(tmp_path / f"scan-{count}.pdf", count)
        execution = ocr.resolve(RunParams(pdf=pdf, model="surya", cut="none", result_dir=tmp_path / f"r{count}"))
        assert execution.transcriber == "surya" and execution.cut == "none"
        markdown = ocr.run(execution, lambda event: None)
        assert markdown.count("synthetic") == count and live() == []
        assert leaf.ranges[0][0] == 1 and leaf.ranges[-1][1] == count
        assert all(after[0] == before[1] + 1 for before, after in zip(leaf.ranges, leaf.ranges[1:])), leaf.ranges
        pages = load_result(tmp_path / f"r{count}").pages
        assert sorted(pages) == list(range(1, count + 1)) and all(page.segments for page in pages.values())
        peaks.append(max(leaf.open))
    assert peaks[0] == peaks[1], peaks


def test_uncut_surya_closes_the_pages_it_loaded_when_its_export_fails(tmp_path, live, monkeypatch):
    """After recognition, the export to Markdown fails: the pages Surya's loader made were never handed over, so the
    adapter closes them itself, explicitly, not left to the collector."""
    leaf = SuryaLeaf(monkeypatch, live)

    def failing(converter, html, name):
        raise RuntimeError("Docling could not start")
    monkeypatch.setattr(html_export, "markdown", failing)
    execution = ocr.resolve(RunParams(pdf=scans(tmp_path / "scan.pdf", 3), model="surya", cut="none"))
    with pytest.raises(RuntimeError, match="Docling could not start"):
        ocr.run(execution, lambda event: None)
    assert len(leaf.loaded) == 3 and all(isinstance(image.im, DeferredError) for image in leaf.loaded)


def test_uncut_surya_closes_the_pages_it_loaded_when_a_cancel_is_observed_at_its_ocr_phase(tmp_path, live,
                                                                                           monkeypatch):
    """The step's cancel sink checks every `phase` event: a cancel observed at the OCR phase, after the loader made
    the pages and before the predictor runs, reaches no record, so the adapter closes them itself."""
    leaf = SuryaLeaf(monkeypatch, live)

    def emit(event):
        if event["type"] == "phase" and event["name"] == "ocr":
            raise KeiFailure("cancelled", "workflow was cancelled")
    execution = ocr.resolve(RunParams(pdf=scans(tmp_path / "scan.pdf", 3), model="surya", cut="none"))
    with pytest.raises(KeiFailure) as raised:
        ocr.run(execution, emit)
    assert raised.value.code == "cancelled" and leaf.open == []  # no request was made
    assert len(leaf.loaded) == 3 and all(isinstance(image.im, DeferredError) for image in leaf.loaded)


# --- Uncut VLM: Docling reads the PDF itself, one range of pages per call -----------------------------------------


def test_uncut_vlm_reads_page_ranges_numbers_by_the_run_and_keeps_a_later_batchs_errors(tmp_path, live,
                                                                                        monkeypatch):
    """Docling's whole-PDF path keeps reading the PDF (under its own cap), one range of pages at a time, the page
    images the debug report keeps released between calls. A later range's page-less error and its status reach the
    manifest and the report, and its records keep their run ordinals and PDF pages."""
    calls = []

    def convert(self, source, *, raises_on_error, page_range):
        calls.append((page_range, len(live())))
        first, last = page_range[0], min(page_range[1], 40)  # Docling's default range runs to sys.maxsize
        late = last == 40
        pages = [SimpleNamespace(page_no=n, predictions=SimpleNamespace(vlm_response=VlmPrediction(
            text=f"page {n}", stop_reason=VlmStopReason.END_OF_SEQUENCE,
            usage={"prompt_tokens": 3, "completion_tokens": 4}))) for n in range(first, last + 1)]
        document = SimpleNamespace(
            pages={n: SimpleNamespace(image=SimpleNamespace(pil_image=Image.new("RGB", (60, 80))))
                   for n in range(first, last + 1)},
            export_to_markdown=lambda page_no: f"page {page_no}", export_to_text=lambda page_no: f"page {page_no}")
        errors = [ErrorItem(component_type=DoclingComponentType.MODEL, module_name="vlm",
                            error_message="a late stray error")] if late else []
        return SimpleNamespace(pages=pages, document=document, errors=errors,
                               status=ConversionStatus.PARTIAL_SUCCESS if late else ConversionStatus.SUCCESS)
    monkeypatch.setattr(DocumentConverter, "convert", convert)
    execution = ocr.resolve(RunParams(pdf=scans(tmp_path / "scan.pdf", 40), model="granite_vision", cut="none",
                                      result_dir=tmp_path / "result", debug_dir=tmp_path / "debug"))
    assert execution.transcriber == "vlm"
    with pytest.raises(IncompleteConversionError, match="partial_success: a late stray error"):
        ocr.run(execution, lambda event: None)
    assert [page_range for page_range, _ in calls] == [(1, 32), (33, 40)]
    assert [opened for _, opened in calls] == [0, 0] and live() == []
    result = load_result(tmp_path / "result")
    assert result.manifest.status == "incomplete" and "a late stray error" in result.manifest.incomplete
    assert [result.pages[n].markdown for n in range(1, 41)] == [f"page {n}" for n in range(1, 41)]
    report = json.loads((tmp_path / "debug" / "report.json").read_text(encoding="utf-8"))
    assert report["docling_status"] == "partial_success"
    assert [error["error_message"] for error in report["errors"]] == ["a late stray error"]
    assert [(entry["page"], entry["source_page"]) for entry in report["pages"]] == [(n, n) for n in range(1, 41)]
    assert all(entry["image_pixels"] == [60, 80] for entry in report["pages"])


# --- Hybrid: artwork recovery stays within its batch, by the run's ordinals ----------------------------------------


def test_hybrid_artwork_recovery_in_a_later_batch_replaces_only_its_own_crop(tmp_path, live, monkeypatch):
    """40 artwork regions on two native pages, two batches. The second batch's input 34 loops on an empty figure:
    only that crop is planned again with page context and its batch read again; every crop, the recovered one's
    box included, is published at its run ordinal with its native page's evidence."""
    pdf = blank_pdf(tmp_path / "illustrated.pdf", 2, (595.0, 842.0))
    boxes = [(page, (40.0 + 25 * (n % 20), 100.0 + 30 * (n // 20), 60.0 + 25 * (n % 20), 120.0 + 30 * (n // 20)))
             for page in (1, 2) for n in range(20)]
    execution = Execution(pdf=pdf, transcriber="hybrid", model="surya", repo=MODELS["surya"].repo,
                          url="http://unused", cut="none", layout_model=None, crop_dpi=250, max_image_size=None,
                          max_output_tokens=None, stream=False, pages=None, debug_dir=None,
                          result_dir=tmp_path / "result", page_source="pdf", ingest_dir=None,
                          ocr_regions=tuple(OcrRegion(page, box) for page, box in boxes))

    def native(execution, crops, emit):
        return Transcription({}, [PageRecord(
            page=page, region=None, image=None, seconds=None, input_tokens=0, output_tokens=0, stop=None,
            capped=False, stats={}, markdown=f"Native {page}", text=f"Native {page}", incomplete=None,
            source_page=page, payload={"blocks": [{"label": "Text", "bbox": [40, 40, 500, 60],
                                                   "html": f"<p>Native {page}</p>"}]}) for page in (1, 2)])
    monkeypatch.setattr(ocr.TRANSCRIBERS["native"], "transcribe", native)
    calls = []

    def recognize(request, crops, emit):
        first, last = request.batch
        calls.append((first, last, [region.bbox for _, region, _ in crops], len(live())))
        if (first, len(calls)) == (33, 2):
            raise ArtworkNeedsContext((34,))
        return Transcription(HEADER, [PageRecord(
            page=n, region=region_info(crop), image=crop[2], seconds=None, input_tokens=1, output_tokens=1,
            stop=None, capped=False, stats={}, markdown=f"Artwork {n}", text=f"Artwork {n}", incomplete=None,
            source_page=None, payload={"blocks": [{"label": "Text", "bbox": [0, 0, 5, 5],
                                                   "html": f"<p>Artwork {n}</p>", "skipped": False,
                                                   "error": False}]}) for n, crop in enumerate(crops, first)])
    monkeypatch.setattr(ocr.TRANSCRIBERS["surya"], "transcribe", recognize)
    markdown = ocr.run(execution, lambda event: None)
    assert [(first, last) for first, last, _, _ in calls] == [(1, 32), (33, 40), (33, 40)]
    first_try, retry = calls[1][2], calls[2][2]
    page, (x0, y0, x1, y1) = boxes[33]
    assert retry[1] == (x0 - 24, y0 - 24, x1 + 24, y1 + 24) and first_try[1] == (x0, y0, x1, y1)
    assert retry[:1] + retry[2:] == first_try[:1] + first_try[2:]
    assert [opened for *_, opened in calls] == [32, 8, 8] and live() == []  # a batch's crops, the replaced one closed
    assert all(f"Artwork {n}" in markdown for n in range(1, 41)) and "Native 1" in markdown
    result = load_result(tmp_path / "result")
    crops = [crop for number in (1, 2) for unit in result.pages[number].units for crop in unit.crops]
    assert sorted(crop.crop for crop in crops) == list(range(1, 41))
    recovered = next(crop for crop in crops if crop.crop == 34)
    assert recovered.bbox_pt == (x0 - 24, y0 - 24, x1 + 24, y1 + 24) and page == 2
    assert all(crop.image_px[0] > 0 for crop in crops)


def test_hybrid_batches_are_budgeted_for_the_context_a_recovery_may_add(tmp_path, live, monkeypatch):
    """Thin wide artwork, a 400 x 1 pt rule: about 1389 x 4 px at 250 dpi, but 1556 x 171 px once a recovery plans it
    again with 24 pt of context. Twelve fit one batch by their first crops; every one loops on an empty figure.
    The batch was budgeted for the recovered crops, so the retry never holds more than the budget."""
    pdf = blank_pdf(tmp_path / "rules.pdf", 1, (595.0, 842.0))
    regions = tuple(OcrRegion(1, (100.0, 100.0 + 50 * n, 500.0, 101.0 + 50 * n)) for n in range(12))
    with PdfPages(pdf) as pages:
        (_, _, small), = cut.artwork_crops(pages, [(1, regions[0].bbox, 0, "figure")], 250)
        (_, _, large), = cut.artwork_crops(pages, [(1, regions[0].bbox, 0, "figure")], 250, context_pt=24)
    context = large[0] * large[1]
    assert context > 30 * small[0] * small[1]
    monkeypatch.setattr(ocr, "CROP_BYTES", 6, raising=False)
    monkeypatch.setattr(ocr, "BATCH_BYTES", 4 * context * 6, raising=False)
    execution = Execution(pdf=pdf, transcriber="hybrid", model="surya", repo=MODELS["surya"].repo,
                          url="http://unused", cut="none", layout_model=None, crop_dpi=250, max_image_size=None,
                          max_output_tokens=None, stream=False, pages=None, debug_dir=None,
                          result_dir=tmp_path / "result", page_source="pdf", ingest_dir=None, ocr_regions=regions)
    monkeypatch.setattr(ocr.TRANSCRIBERS["native"], "transcribe", lambda execution, crops, emit: Transcription({}, [
        PageRecord(page=1, region=None, image=None, seconds=None, input_tokens=0, output_tokens=0, stop=None,
                   capped=False, stats={}, markdown="Native", text="Native", incomplete=None, source_page=1,
                   payload={"blocks": [{"label": "Text", "bbox": [40, 40, 500, 60], "html": "<p>Native</p>"}]})]))
    retried, pixels = set(), []

    def recognize(request, crops, emit):
        first, last = getattr(request, "batch", None) or (1, len(crops))
        pixels.append(sum(image.width * image.height for image in live()))
        if first not in retried:
            retried.add(first)
            raise ArtworkNeedsContext(tuple(range(first, last + 1)))
        return Transcription(HEADER, [PageRecord(
            page=n, region=region_info(crop), image=crop[2], seconds=None, input_tokens=1, output_tokens=1,
            stop=None, capped=False, stats={}, markdown="", text="", incomplete=None, source_page=None,
            payload={"blocks": []}) for n, crop in enumerate(crops, first)])
    monkeypatch.setattr(ocr.TRANSCRIBERS["surya"], "transcribe", recognize)
    ocr.run(execution, lambda event: None)
    assert max(pixels) <= 4 * context, pixels
    assert live() == [] and len(load_result(tmp_path / "result").pages[1].units[0].crops) == 12


class Streamed:
    """One streamed chat completion as the model server sends it: `text`, then its finish and usage."""

    def __init__(self, text: str) -> None:
        self.lines = [b"data: " + json.dumps({"choices": [{"delta": {"content": text}}]}).encode(),
                      b"data: " + json.dumps({"choices": [{"delta": {}, "finish_reason": "stop"}]}).encode(),
                      b'data: {"choices": [], "usage": {"prompt_tokens": 5, "completion_tokens": 1}}',
                      b"data: [DONE]"]

    def __enter__(self):
        return self

    def __exit__(self, *exc) -> None:
        return None

    def raise_for_status(self) -> None:
        return None

    def iter_lines(self, chunk_size: int = 1):
        return iter(self.lines)


@pytest.mark.parametrize("cut_mode", ["auto", "none"])
def test_a_streamed_vlm_run_names_every_input_by_its_run_ordinal_in_a_later_batch(tmp_path, live, monkeypatch,
                                                                                  one_region_per_page, cut_mode):
    """34 inputs, two batches, through Docling's VLM pipeline and the streaming engine, only the HTTP request
    replaced. Every page_start and token names its own input: the second batch's do not relabel the first's."""
    from kei_exp.transcription import streaming
    posted = []

    def post(url, *, json, **options):
        posted.append(json)
        return Streamed(f"text {len(posted)}")
    monkeypatch.setattr(streaming.requests, "post", post)
    events = []
    execution = ocr.resolve(RunParams(pdf=scans(tmp_path / "scan.pdf", 34), model="infinity_parser", cut=cut_mode,
                                      stream=True, result_dir=tmp_path / "result"))
    assert execution.transcriber == "vlm" and execution.stream
    markdown = ocr.run(execution, events.append)
    starts = [(event["page"], event["crop"]) for event in events if event["type"] == "page_start"]
    tokens = [(event["page"], event["crop"], event["text"]) for event in events
              if event["type"] == "token" and event["text"]]  # the finish chunk streams an empty piece
    expected = [(n, n if cut_mode == "auto" else None) for n in range(1, 35)]
    assert len(posted) == 34 and starts == expected, starts
    assert tokens == [(page, crop, f"text {n}") for n, (page, crop) in enumerate(expected, 1)]
    # Docling's whole-PDF pipeline does not send pages in page order, so there the engine's labels follow the requests
    # (as they did in one call); with cuts the order is the inputs'.
    published = markdown.split("\n\n")
    assert (published if cut_mode == "auto" else sorted(published, key=lambda text: int(text.split()[1]))) == [
        f"text {n}" for n in range(1, 35)] and live() == []


# --- The render budget holds for the final size of every raster: a text crop's margin, Docling's own render -------


class Allocation(Exception):
    """A bitmap the test refuses to allocate."""


class Requested(list):
    limit = MAX_RENDER_PIXELS


@pytest.fixture
def bitmaps(monkeypatch) -> Requested:
    """Every bitmap PDFium is asked for, by FREE or by Docling; one over `limit` pixels is refused where PDFium
    would allocate it, so a regression never allocates what it is about."""
    requested = Requested()
    native = pdfium.PdfPage.render

    def render(page, *args, **kwargs):
        def maker(width, height, **options):
            requested.append((width, height))
            if width * height > requested.limit:
                raise Allocation(f"PDFium was asked for a {width} x {height} px bitmap")
            return pdfium.PdfBitmap.new_native(width, height, **options)
        return native(page, *args, bitmap_maker=maker, **kwargs)
    monkeypatch.setattr(pdfium.PdfPage, "render", render)
    return requested


@pytest.mark.parametrize("bbox,refused", [((0.0, 50.0, 14_400.0, 1_058.0), True), ((50.0, 60.0, 250.0, 100.0), False)],
                         ids=["margin past the budget", "ordinary block"])
def test_a_native_text_crop_is_checked_at_its_size_with_its_white_margin(tmp_path, monkeypatch, bitmaps, bbox,
                                                                         refused):
    """A native block with an undecodable glyph is read from a crop inside a 24 pt white margin. A block 14,400 pt
    wide and 1,008 pt tall is 50,000 x 3,500 px at 250 dpi, under the render budget; with its margin 50,166 x 3,666,
    over it. It is refused before its crop renders; an ordinary block is read."""
    bitmaps.limit = 50_000_000  # nothing near the crop's size is allocated, whatever the outcome
    pdf = blank_pdf(tmp_path / "wide.pdf", 1, (14_400.0, 1_100.0))
    execution = Execution(pdf=pdf, transcriber="hybrid", model="surya", repo=MODELS["surya"].repo,
                          url="http://unused", cut="none", layout_model=None, crop_dpi=250, max_image_size=None,
                          max_output_tokens=None, stream=False, pages=None, debug_dir=None,
                          result_dir=tmp_path / "result", page_source="pdf", ingest_dir=None, ocr_text=True)
    monkeypatch.setattr(ocr.TRANSCRIBERS["native"], "transcribe", lambda execution, crops, emit: Transcription({}, [
        PageRecord(page=1, region=None, image=None, seconds=None, input_tokens=0, output_tokens=0, stop=None,
                   capped=False, stats={}, markdown="x", text="x", incomplete=None, source_page=1,
                   payload={"blocks": [{"label": "Text", "bbox": list(bbox), "html": "<p>x\x01y</p>"}]})]))
    read = []

    def recognize(request, crops, emit):
        read.extend(image.size for _, _, image in crops)
        return Transcription(HEADER, [PageRecord(
            page=1, region=region_info(crops[0]), image=crops[0][2], seconds=None, input_tokens=1, output_tokens=1,
            stop=None, capped=False, stats={}, markdown="x−y", text="x−y", incomplete=None, source_page=None,
            payload={"blocks": [{"label": "Text", "bbox": [0, 0, 5, 5], "html": "<p>x−y</p>", "skipped": False,
                                 "error": False}]})])
    monkeypatch.setattr(ocr.TRANSCRIBERS["surya"], "transcribe", recognize)
    if refused:
        with pytest.raises(ConversionError, match="50166 x 3666 px"):
            ocr.run(execution, lambda event: None)
        assert read == [] and all(width * height < 20_000_000 for width, height in bitmaps)
    else:
        assert "x−y" in ocr.run(execution, lambda event: None)
        pad = round(24 * 250 / 72)
        assert read == [(bitmaps[-1][0] + 2 * pad, bitmaps[-1][1] + 2 * pad)]  # the render, inside its margin


def boxed_pdf(path: Path, page: str, parent: str = "", objects: tuple[bytes, ...] = ()) -> Path:
    """One page with the entries `page`, under a page tree node with `parent`, written by hand: PDFium reads box
    numbers as float32, docling-parse as double. `objects` are numbered from 4 on."""
    bodies = [b"<< /Type /Catalog /Pages 2 0 R >>", f"<< /Type /Pages /Kids [3 0 R] /Count 1 {parent} >>".encode(),
              f"<< /Type /Page /Parent 2 0 R {page} >>".encode(), *objects]
    out, offsets = b"%PDF-1.4\n", []
    for number, body in enumerate(bodies, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(bodies) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets)
    out += f"trailer\n<< /Size {len(bodies) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    path.write_bytes(out)
    return path


def forbid_page_decoding(monkeypatch) -> None:
    """Any page decode or render, by docling-parse, PDFium, Docling's converter or pypdf's stream reader, fails."""
    import docling_parse.pdf_parser as parser
    import pypdf.generic

    def called(*args, **kwargs):
        pytest.fail("a page was decoded or rendered")
    monkeypatch.setattr(parser.DoclingPdfParser, "load", called)
    monkeypatch.setattr(parser.pdf_parser, "get_page_decoder", called)
    monkeypatch.setattr(parser.PdfPageDecoder, "render_image", called)
    monkeypatch.setattr(pdfium.PdfPage, "render", called)
    monkeypatch.setattr(DocumentConverter, "convert", called)
    monkeypatch.setattr(pypdf.generic.EncodedStreamObject, "get_data", called)
    monkeypatch.setattr(pypdf.generic.DecodedStreamObject, "get_data", called)


A4 = "/MediaBox [0 0 595.28 841.89]"
FAR = "/MediaBox [50000000 50000000 50000300.7 50000101.9] /CropBox [50000000.3 50000000 50000250.1 50000101.9]"


@pytest.mark.parametrize("page,parent,cap,refused", [
    ("/MediaBox [0 0 10000 10000]", "", 50_000, "20001 x 20001 px at 144 dpi"),
    ("/MediaBox [0 0 14400 14400]", "", None, "14401 x 14401 px at 72 dpi"),
    ("/MediaBox [0 0 13377.0001 13377.0001]", "", None, "13378 x 13378 px at 72 dpi"),
    ("", "/MediaBox [0 0 14400 14400]", None, "14401 x 14401 px at 72 dpi"),
    ("", "", None, "no page box"),
    (A4, "", None, None),
    ("/MediaBox [0 0 3000 3000]", "", 5_000, None),
    ("/MediaBox [50000000 50000000 50000101.9 50000101.9]", "", None, None),
    ("/MediaBox [0 0 1401.0833 1700]", "", None, None),
    ("", A4, None, None),
    ("", "/MediaBox [-100 -100 200 200] /CropBox [0 0 100 100]", None, None),
    ("/MediaBox [0 0 612 792] /CropBox [36.5 40.25 400.75 700.125]", "", None, None),
    (f"{A4} /Rotate 90", "", None, None),
    ("", f"{A4} /Rotate 90", None, None),
    (f"{FAR} /Rotate 270", "", None, None),
    (f"{A4} /UserUnit 2", "", None, None),
], ids=["explicit cap past the budget", "default cap, a page past it at 72 dpi",
        "past it in double, under it in float32", "inherited MediaBox past it", "no page box", "default cap",
        "custom cap", "far from the origin", "a float32 render scale", "inherited MediaBox",
        "inherited CropBox, ignored", "CropBox", "rotated", "inherited Rotate, ignored", "rotated far CropBox",
        "UserUnit, ignored"])
def test_a_whole_page_vlm_run_is_checked_at_the_images_docling_will_render(tmp_path, monkeypatch, page, parent, cap,
                                                                           refused):
    """Docling's default PDF backend renders a whole page twice, RGBA: at 72 dpi as its parser decodes it, then at
    the spec's scale 2 under the cap. A 14,400 pt page is 14,400 x 14,400 px at 72 dpi, over the render budget
    under any cap, whether its MediaBox is its own or inherited; a 10,000 pt page is under it at 72 dpi but 20,000 x
    20,000 px under an explicit cap of 50,000. A 13377.0001 pt page is 13377 pt to PDFium (float32), under the
    budget, and 13378 x 13378 px to Docling, over it. All are refused from their page geometry alone, before any page
    is decoded or rendered, as is a page with no box. Ordinary pages, and boxes as Docling's parser reads them (one
    50,000,000 pt from the origin, a CropBox of its own but not an inherited one, its own /Rotate but not an inherited
    one, no /UserUnit, a scale Docling's renderer rounds to float32), render at most at the sizes the check planned
    (`vlm.whole_page_renders`), as the installed Docling reports them; a budget a pixel under what Docling rendered
    refuses them before anything is decoded."""
    import docling_parse.pdf_parser as parser
    from kei_exp.transcription import streaming, vlm
    monkeypatch.setattr(streaming.requests, "post", lambda url, **options: Streamed("text"))
    monkeypatch.setattr(ocr, "native_regions", lambda *args, **kwargs: None)  # read as a scan, not natively
    pdf = boxed_pdf(tmp_path / "page.pdf", page, parent)
    execution = ocr.resolve(RunParams(pdf=pdf, model="infinity_parser", cut="none", stream=True,
                                      max_image_size=cap, result_dir=tmp_path / "result"))
    assert execution.transcriber == "vlm"
    if refused:
        with monkeypatch.context() as forbidden:
            forbid_page_decoding(forbidden)
            with pytest.raises(ConversionError, match=refused):
                ocr.run(execution, lambda event: None)
        assert not (tmp_path / "result").exists()
        return
    rendered = []
    init, at_scale = parser.PageParseResult.__init__, parser.PageParseResult._render_image_at_scale

    def decoded(self, raw_result, **options):
        init(self, raw_result, **options)
        height, width, _ = raw_result.image_shape
        rendered.append((width, height))

    def scaled(self, scale):
        image = at_scale(self, scale)
        rendered.append(image.size)
        return image
    with monkeypatch.context() as spied:
        spied.setattr(parser.PageParseResult, "__init__", decoded)
        spied.setattr(parser.PageParseResult, "_render_image_at_scale", scaled)
        assert ocr.run(execution, lambda event: None) == "text"
    planned = vlm.whole_page_renders(MODELS["infinity_parser"], execution.url, cap, pdf, [1], lambda event: None)[1]
    assert len(rendered) == len(planned) == 2
    # Never under Docling's render (the check is a hard cap), over it at most by the pixel its rounding margin adds.
    assert all(0 <= planned_width - width <= 1 and 0 <= planned_height - height <= 1
               for (width, height), (planned_width, planned_height, _) in zip(rendered, planned)), (rendered, planned)

    monkeypatch.setattr("kei_exp.pages.MAX_RENDER_PIXELS", max(width * height for width, height in rendered) - 1)
    forbid_page_decoding(monkeypatch)
    with pytest.raises(ConversionError, match="over the limit"):
        ocr.run(replace(execution, result_dir=tmp_path / "refused"), lambda event: None)
    assert not (tmp_path / "refused").exists()


@pytest.mark.parametrize("algorithm", ["AES-128", "AES-256"])
def test_a_whole_page_vlm_run_reads_an_aes_pdf_anyone_may_open_as_a_plain_one(tmp_path, monkeypatch, algorithm):
    """Docling opens a PDF encrypted with AES and an empty user password, so the check reads it too, with an empty
    password and pypdf's `crypto` extra: the sizes it plans are those Docling renders, and a budget a pixel under
    them refuses the page before anything is decoded, and a cancel observed at the check leaves the file closed. A PDF
    with a user password is refused when PDFium cannot open it, before the check, as it was before the check read
    geometry."""
    from kei_exp.transcription import vlm
    plain = boxed_pdf

    def encrypted(path: Path, page: str, parent: str = "", user: str = "") -> Path:
        writer = PdfWriter(clone_from=plain(path, page, parent))
        writer.encrypt(user_password=user, owner_password="owner", algorithm=algorithm)
        writer.write(path)
        assert PdfReader(path).is_encrypted
        return path
    monkeypatch.setitem(globals(), "boxed_pdf", encrypted)
    test_a_whole_page_vlm_run_is_checked_at_the_images_docling_will_render(
        tmp_path, monkeypatch, "/MediaBox [0 0 612 792] /CropBox [36.5 40.25 400.75 700.125] /Rotate 90", "", None, None)

    opened = []
    monkeypatch.setattr(vlm, "PdfReader", lambda file: opened.append(file) or PdfReader(file))

    def cancelled(event):
        raise Stopped
    with pytest.raises(Stopped):
        vlm.whole_page_renders(MODELS["infinity_parser"], "http://127.0.0.1:9/v1", None, tmp_path / "page.pdf", [1],
                               cancelled)
    assert len(opened) == 1 and opened[0].closed

    pdf = encrypted(tmp_path / "secret.pdf", A4, user="secret")
    execution = ocr.resolve(RunParams(pdf=pdf, model="infinity_parser", cut="none", result_dir=tmp_path / "secret"))
    with pytest.raises(pdfium.PdfiumError, match="password"):
        ocr.run(execution, lambda event: None)
    assert not (tmp_path / "secret").exists()


def test_a_whole_page_vlm_check_decodes_no_image_inside_a_form(tmp_path, monkeypatch):
    """docling-parse decodes the images of a Form XObject a page draws (`/Fm Do`, `/Im` among the form's own
    resources) even when told to keep no image pixels: the check reads the page's geometry instead, one cancel point
    per page before it, and refuses without a stream decoded or a page parsed."""
    import zlib

    def stream(entries: str, data: bytes) -> bytes:
        return f"<< {entries} /Length {len(data)} >>\nstream\n".encode() + data + b"\nendstream"
    pixels = zlib.compress(bytes(range(12)))
    pdf = boxed_pdf(tmp_path / "form.pdf", "/MediaBox [0 0 200 100] /Resources << /XObject << /Fm 4 0 R >> >> "
                    "/Contents 6 0 R", objects=(
                        stream("/Type /XObject /Subtype /Form /BBox [0 0 1 1] "
                               "/Resources << /XObject << /Im 5 0 R >> >>", b"/Im Do"),
                        stream("/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB "
                               "/BitsPerComponent 8 /Filter /FlateDecode", pixels),
                        stream("", b"q 200 0 0 100 0 0 cm /Fm Do Q")))
    execution = ocr.resolve(RunParams(pdf=pdf, model="infinity_parser", cut="none", result_dir=tmp_path / "result"))
    monkeypatch.setattr(ocr, "native_regions", lambda *args, **kwargs: None)  # read as a scan, not natively
    monkeypatch.setattr("kei_exp.pages.MAX_RENDER_PIXELS", 201 * 101 - 1)
    forbid_page_decoding(monkeypatch)
    events = []
    with pytest.raises(ConversionError, match="201 x 101 px at 72 dpi"):
        ocr.run(execution, events.append)
    assert {"type": "cancel_point"} in events and not (tmp_path / "result").exists()


def test_surya_whole_pages_closes_what_it_rendered_when_a_later_page_fails(tmp_path, monkeypatch):
    """Surya's whole pages are loaded one at a time by FREE's own wrapper: when PDFium fails on the second page, the
    first page's image, and every view on a bitmap, is closed before the failure leaves `whole_pages`."""
    pdf = scans(tmp_path / "scan.pdf", 3)
    made = []
    init = Image.Image.__init__

    def tracked(self, *args, **kwargs):
        init(self, *args, **kwargs)
        made.append(self)  # held: an image left open is not merely collected
    native = pdfium.PdfPage.render
    calls = []

    def render(page, *args, **kwargs):
        def maker(width, height, **options):
            calls.append((width, height))
            if len(calls) == 2:
                raise Allocation("PDFium failed on the second page")
            return pdfium.PdfBitmap.new_native(width, height, **options)
        return native(page, *args, bitmap_maker=maker, **kwargs)
    Image.init()
    monkeypatch.setattr(Image.Image, "__init__", tracked)
    monkeypatch.setattr(pdfium.PdfPage, "render", render)
    with pytest.raises(Allocation):
        surya.whole_pages(pdf, None, 192)
    assert len(calls) == 2 and made, made
    assert all(isinstance(image.im, DeferredError) for image in made if image.im is not None), made


def test_surya_whole_pages_closes_the_bitmap_whose_view_could_not_be_made(tmp_path, monkeypatch):
    """The second page renders, and its PIL view fails: that native bitmap, and the first page's image, are closed."""
    pdf = scans(tmp_path / "scan.pdf", 3)
    bitmaps, loaded = [], []
    render, view, convert = pdfium.PdfPage.render, pdfium.PdfBitmap.to_pil, Image.Image.convert

    def rendering(page, *args, **kwargs):
        bitmaps.append(render(page, *args, **kwargs))  # held: a bitmap left open is not merely collected
        return bitmaps[-1]

    def viewing(bitmap):
        if len(bitmaps) == 2:
            raise Allocation("no memory for the second page's view")
        return view(bitmap)

    def converting(image, *args, **kwargs):
        loaded.append(convert(image, *args, **kwargs))
        return loaded[-1]
    monkeypatch.setattr(pdfium.PdfPage, "render", rendering)
    monkeypatch.setattr(pdfium.PdfBitmap, "to_pil", viewing)
    monkeypatch.setattr(Image.Image, "convert", converting)
    with pytest.raises(Allocation):
        surya.whole_pages(pdf, None, 192)
    assert len(bitmaps) == 2 and all(bitmap.raw is None for bitmap in bitmaps)
    assert len(loaded) == 1 and isinstance(loaded[0].im, DeferredError)


def test_surya_whole_pages_renders_as_surya_s_own_loader(tmp_path):
    """FREE's loop renders exactly what Surya's loader renders: RGB at the dpi, annotations left out."""
    from surya.input.load import load_from_file
    pdf = scans(tmp_path / "scan.pdf", 2)
    ours = surya.whole_pages(pdf, (1, 2), 192)
    theirs, _ = load_from_file(str(pdf), page_range=[0, 1], dpi=192)
    assert [(image.mode, image.size, image.tobytes()) for image in ours] == [
        (image.mode, image.size, image.tobytes()) for image in theirs]

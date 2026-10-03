"""OCR execution shared by KIE, the Markdown CLI and the API.

The runner supplies accepted book pages when needed. This stage owns cutting, transcription, progress identity,
result publication and acceptance; adapters only return their records.
"""
import logging
import time
from collections.abc import Callable
from contextlib import nullcontext
from dataclasses import replace
from datetime import UTC, datetime

from kei_exp.cut import CutError, artwork_crops, cut_pages, whole_pages
from kei_exp.kie.ingest_model import IngestConfig
from kei_exp.models import MODELS
from kei_exp.pagefile import load_result
from kei_exp.pages import BookPages, PdfPages
from kei_exp.progress import Emit, Event, print_event
from kei_exp.regions import Crop, anchor
from kei_exp.report import write_report
from kei_exp.result import Input, Inventory, Source, assemble_pages, fingerprint, page_markdown, recipe, write_result
from kei_exp.transcription import hybrid
from kei_exp.transcription.native import NativeText, native_regions
from kei_exp.transcription.surya import SuryaOcr
from kei_exp.transcription.types import (
    ConversionError,
    Execution,
    IncompleteConversionError,
    RunParams,
    Transcriber,
    Transcription,
)
from kei_exp.transcription.vlm import DoclingVlm

logger = logging.getLogger(__name__)

TRANSCRIBERS: dict[str, Transcriber] = {transcriber.kind: transcriber for transcriber in (DoclingVlm(), SuryaOcr(), NativeText())}
_unregistered = {key: record.kind for key, record in MODELS.items() if record.kind not in TRANSCRIBERS}
if _unregistered:
    raise RuntimeError(f"model records name transcribers that do not exist: {_unregistered}")


def check_knobs(params: RunParams) -> None:
    """Refuse the knobs the requested model's transcriber does not honour, naming them. ValueError when it does.

    Reading no PDF is the point: this is the one part of `resolve` that judges the request alone, so `convert`'s
    `prepare_run` step (`kei_exp.workflows.convert`) makes it before any model work, without paying for the
    native-text decision, which only the conversion makes. A native execution honours no knob at all, so
    `resolve` asks this after that choice.
    """
    record = MODELS[params.model]
    given = {"stream": params.stream, "max_output_tokens": params.max_output_tokens is not None,
             "max_image_size": params.max_image_size is not None}
    refused = [name for name, is_set in given.items() if is_set and name not in TRANSCRIBERS[record.kind].knobs]
    if refused:
        raise ValueError(f"the {record.kind} transcriber does not accept {', '.join(refused)}")


def check_ingest(page_source: str, ingest: dict | None) -> None:
    """An ingest setting (split, gutter overrides) applies only to book pages, and must be a valid IngestConfig.
    Checked by `convert`'s `prepare_run` step and again when the run resolves, so a refused setting never reaches
    a model."""
    if ingest is None:
        return
    if page_source != "ingest":
        raise ValueError("an ingest setting (split, gutter overrides) needs page_source ingest")
    try:
        IngestConfig.model_validate(ingest)
    except ValueError as error:
        raise ValueError(f"the ingest setting is invalid: {error}") from error


def resolve(params: RunParams) -> Execution:
    """The execution choice for params, made once per run.

    Embedded text on every selected nonblank page runs natively; substantial textless artwork supplements it
    with image-only OCR by the record's transcriber, whose knobs apply (`supplement`). A fully native run needs
    no model or server. Otherwise scanned/mixed documents use the record's transcriber and the request's
    settings. ValueError: knobs set that the transcriber does not honour. ConversionError: the page range lies
    outside the PDF.
    """
    if params.page_source not in ("pdf", "ingest"):
        raise ValueError(f"page_source must be pdf or ingest, not {params.page_source!r}")
    check_ingest(params.page_source, params.ingest)
    regions = native_regions(params.pdf, params.pages)
    if regions == ():
        return Execution(pdf=params.pdf, source_name=params.source_name, transcriber=NativeText.kind,
                         model=None, repo=None, url=None, cut="none",
                         layout_model=None, crop_dpi=None, max_image_size=None, max_output_tokens=None,
                         stream=False, pages=params.pages, debug_dir=params.debug_dir, result_dir=params.result_dir,
                         page_source="pdf", ingest_dir=None)
    check_knobs(params)
    record = MODELS[params.model]
    if regions is not None:
        return Execution(pdf=params.pdf, source_name=params.source_name, transcriber=hybrid.KIND,
                         model=params.model, repo=record.repo, url=params.url, cut="none", layout_model=None,
                         crop_dpi=params.crop_dpi, max_image_size=params.max_image_size,
                         max_output_tokens=params.max_output_tokens, stream=params.stream, pages=params.pages,
                         debug_dir=params.debug_dir, result_dir=params.result_dir, page_source="pdf", ingest_dir=None,
                         ocr_regions=regions)
    return Execution(pdf=params.pdf, source_name=params.source_name, transcriber=record.kind,
                     model=params.model, repo=record.repo, url=params.url,
                     cut=params.cut, layout_model=params.layout_model if params.cut == "auto" else None,
                     crop_dpi=params.crop_dpi, max_image_size=params.max_image_size,
                     max_output_tokens=params.max_output_tokens, stream=params.stream, pages=params.pages,
                     debug_dir=params.debug_dir, result_dir=params.result_dir, page_source=params.page_source,
                     ingest_dir=params.ingest_dir, ingest=params.ingest)


PAGE_EVENTS = frozenset({"page_start", "token", "page_end", "page_stats"})


def page_events(emit: Emit, inputs: Inventory) -> Emit:
    """The sink the transcribers and the report writer get: the input ordinal they number their events by becomes
    the PDF page, the unit and the crop the browser and the log read, so no adapter has to know about spreads."""
    def sink(event: Event) -> None:
        if event["type"] in PAGE_EVENTS:
            item = inputs.input(event["page"])
            event = {**event, "page": item.page, "unit": item.unit, "crop": item.ordinal if item.crop else None}
        emit(event)
    return sink


def inventory(numbers: list[int], crops: list[Crop] | None, book: BookPages | None) -> Inventory:
    """The transcriber's inputs by ordinal: the crops, each on its PDF page and unit, or the selected pages whole."""
    if crops is None:
        return Inventory(numbers, [Input(n, page, 0, None) for n, page in enumerate(numbers, 1)], None)
    inputs = []
    for n, crop in enumerate(crops, 1):
        unit = crop[0]  # the cut's page number: a book page index over the ingest, else the PDF page itself
        page = book.page(unit).ingest.spread if book is not None else unit
        inputs.append(Input(n, page, unit if book is not None else 0, crop))
    pages = sorted({book.page(n).ingest.spread for n in numbers}) if book is not None else numbers
    return Inventory(pages, inputs, book)


def announce(emit: Emit, crop: Crop, ordinal: int, book: BookPages | None) -> None:
    """The `region` event of crop `ordinal`, emitted as it is rendered. It names the PDF page and the box on it:
    over the ingest the crop's page is a book page, a unit."""
    page, region, image = crop
    spread = book.page(page).ingest.spread if book is not None else page
    bbox = book.page(page).to_page_points(region.bbox) if book is not None else region.bbox
    emit({"type": "region", "page": spread, "unit": page if book is not None else 0,
          "crop": ordinal, "order": region.order, "kind": region.kind, "bbox": list(bbox),
          "width": image.width, "height": image.height, "ink": round(region.ink, 3)})


def supplement(execution: Execution, inputs: Inventory, emit: Emit) -> Transcription:
    """A hybrid execution: the native transcriber on the selected pages, then the record's transcriber on one
    crop per region of textless artwork, merged by `kei_exp.transcription.hybrid`.

    Each region reads at one anchor among its page's native blocks (`kei_exp.regions.anchor`, running heads and
    feet kept in place but never placing it), computed here once for both the Markdown and the page file; its
    crop's order is its rank among its page's regions in that reading order, so a page file's crops read in their
    cut order. Crop n is `execution.ocr_regions[n - 1]`.
    """
    assert execution.ocr_regions and execution.model is not None and execution.crop_dpi is not None
    emit({"type": "log", "text": f"Preserving native PDF text; OCR only on {len(execution.ocr_regions)} embedded regions."})
    native = TRANSCRIBERS[NativeText.kind].transcribe(execution, None, page_events(emit, inputs))
    blocks = {record.source_page: record.payload.get("blocks", []) for record in native.pages}
    regions = execution.ocr_regions
    anchors = [anchor([tuple(block["bbox"]) for block in blocks.get(region.page, [])], region.bbox,
                      {n for n, block in enumerate(blocks.get(region.page, [])) if block["label"] in hybrid.FURNITURE})
               for region in regions]
    orders: dict[int, int] = {}
    counts: dict[int, int] = {}
    for n in sorted(range(len(regions)), key=lambda n: (regions[n].page, anchors[n], n)):
        orders[n] = counts.get(regions[n].page, 0)
        counts[regions[n].page] = orders[n] + 1
    crops: list[Crop] = []
    try:
        with PdfPages(execution.pdf) as pages:
            for crop in artwork_crops(pages, ((region.page, region.bbox, orders[n])
                                              for n, region in enumerate(regions)), execution.crop_dpi):
                crops.append(crop)
                announce(emit, crop, len(crops), None)
        record = MODELS[execution.model]
        selected = replace(execution, transcriber=record.kind, ocr_regions=())
        ocr_inputs = inventory(sorted({region.page for region in regions}), crops, None)
        recognized = TRANSCRIBERS[record.kind].transcribe(selected, crops, page_events(emit, ocr_inputs))
        return hybrid.supplement(native, recognized, crops, anchors)
    except CutError as error:
        for _, _, image in crops:
            image.close()
        raise ConversionError(f"Artwork crop failed: {error}") from error
    except Exception:
        for _, _, image in crops:
            image.close()
        raise


def run(execution: Execution, emit: Emit = print_event, *, book: BookPages | None = None,
        adopt: Callable[[str], bool] | None = None, before_ocr: Callable[[], None] | None = None) -> str:
    """Cut the supplied pages, transcribe them, write the result, and return its Markdown.

    The source is hashed before cutting and transcription. The API uses its private input.pdf; the CLI
    reads the file it was given. Ingest, when needed, has already run.
    The worker's hooks (`kei_exp.reuse`): `adopt` is asked first with the recipe's fingerprint, and true means it
    published an earlier run's result of that recipe in `result_dir`, whose Markdown is returned with nothing cut or
    transcribed; otherwise `before_ocr` runs (the model server's probe) and then the work.
    ConversionError: the run produced no trustworthy output; the debug report, when asked for, is written before
    that is decided. The debug report is diagnostic only: a failure writing it (or its images) is logged and
    reported as a `log` event, never raised, and never stops an accepted result or its Markdown from returning.
    """
    source = Source.of(execution)  # name, identity and page sizes, fixed before a byte of the PDF is parsed
    first, last = execution.pages or (1, source.page_count)
    if not 1 <= first <= last <= source.page_count:
        raise ConversionError(f"page range {first}-{last} outside 1-{source.page_count}")
    crops = None
    assert (book is not None) == (execution.page_source == "ingest"), "ingest execution needs book pages"
    ingest_digest = book.digest if book is not None else None
    if adopt is not None and adopt(fingerprint(recipe(execution, source.sha256, ingest_digest))):
        assert execution.result_dir is not None
        emit({"type": "log", "text": "OCR skipped: adopted an earlier run's result of this source and recipe"})
        loaded = load_result(execution.result_dir)
        return page_markdown(page.markdown for page in loaded.pages.values())
    if before_ocr is not None:
        before_ocr()
    if execution.cut == "auto" or book is not None:
        assert execution.crop_dpi is not None
        crops = []
        try:
            with nullcontext(book) if book is not None else PdfPages(execution.pdf) as pages:
                numbers = book.numbers_in(execution.pages) if book is not None else list(range(first, last + 1))
                if execution.cut == "auto":
                    assert execution.layout_model is not None
                    emit({"type": "phase", "name": "cut", "total": len(numbers)})
                    produced = cut_pages(pages, numbers, execution.crop_dpi, layout_model=execution.layout_model)
                else:
                    produced = whole_pages(pages, numbers, execution.crop_dpi)
                for crop in produced:  # announced as each is cut, while the source is open
                    crops.append(crop)
                    announce(emit, crop, len(crops), book)
        except CutError as error:
            raise ConversionError(f"Layout cut failed: {error}") from error
    else:  # whole PDF pages: the transcriber renders them itself, and its inputs are the selected pages
        numbers = list(range(first, last + 1))
    inputs = inventory(numbers, crops, book)
    sink = page_events(emit, inputs)
    started = datetime.now(UTC).isoformat()
    clock = time.monotonic()
    if crops is not None and not crops:
        # The cut found nothing on any page. An empty list never reaches a transcriber, which reads it as "the
        # whole PDF"; the run is judged below with the refusal it always had.
        outcome = Transcription({}, [], unattributed="the layout cut found no content")
    elif execution.transcriber == hybrid.KIND:
        outcome = supplement(execution, inputs, emit)
    else:
        outcome = TRANSCRIBERS[execution.transcriber].transcribe(execution, crops, sink)
    seconds = time.monotonic() - clock
    # The records are the inputs, one each, a whole-page record naming its page: an adapter contract, not an outcome.
    assert sorted(record.page for record in outcome.pages) == list(range(1, len(inputs.inputs) + 1)), "records are not the inputs"
    assert all(inputs.input(r.page).crop is not None or r.source_page == inputs.input(r.page).page for r in outcome.pages)
    markdown = page_markdown(
        markdown for _, _, markdown in assemble_pages(
            inputs, ((inputs.input(record.page), record) for record in outcome.pages)))
    if outcome.incomplete is None and not markdown.strip():
        outcome = replace(outcome, unattributed="the transcriber returned no text")  # judged before the files
    if execution.result_dir is not None:  # accepted results first: they never depend on the debug write
        write_result(outcome, execution, inputs, source, ingest_digest=ingest_digest,
                     directory=execution.result_dir, started=started, seconds=seconds)
    if execution.debug_dir is not None:
        try:
            write_report(outcome, execution, started, seconds, execution.debug_dir, sink)
        except Exception as error:  # noqa: BLE001 - diagnostics only; the accepted result above is already written
            logger.error("debug report not written to %s: %s", execution.debug_dir, error)
            sink({"type": "log", "text": f"Debug report not written: {error}"})
    # IncompleteConversionError, not ConversionError: kei_exp.failures.classify() matches on this TYPE to
    # keep an incomplete recognition out of the retried set. It is about this document at this budget and
    # repeats identically, unlike a refused server; typing it (rather than matching phrases in the message)
    # stops a scanned page whose OCR'd text happens to contain something like "connection timed out" from
    # looking like a transient network failure and earning two pointless GPU retries. The message text itself
    # is not load-bearing any more and can be reworded freely.
    if outcome.incomplete:
        raise IncompleteConversionError(f"Conversion incomplete; output not written: {outcome.incomplete}")
    return markdown

"""OCR execution shared by KIE, the Markdown CLI and the API.

The runner supplies accepted book pages when needed. This stage owns cutting, transcription, progress identity,
result publication and acceptance; adapters only return their records.
"""
import math
import time
from collections.abc import Callable
from contextlib import nullcontext
from dataclasses import replace
from datetime import UTC, datetime

from PIL import Image

from kei_exp.cut import CutError, artwork_crops, context_box, cut_pages, render_region, whole_pages
from kei_exp.kie.ingest_model import IngestConfig
from kei_exp.models import MODELS
from kei_exp.pagefile import LoadedResult
from kei_exp.pages import MAX_RENDER_PIXELS, BookPages, PageSource, PdfPages, check_render_size
from kei_exp.progress import Emit, Event, print_event
from kei_exp.regions import CropPlan, anchor
from kei_exp.report import Debug
from kei_exp.result import Input, Inventory, Source, assemble_pages, fingerprint, page_markdown, recipe, write_result
from kei_exp.transcription import hybrid
from kei_exp.transcription.native import NativeText, native_regions, undecodable, undecodable_glyphs
from kei_exp.transcription.surya import SuryaOcr
from kei_exp.transcription.types import (
    ArtworkNeedsContext,
    ConversionError,
    Execution,
    IncompleteConversionError,
    OcrRegion,
    RunParams,
    Transcriber,
    Transcription,
)
from kei_exp.transcription.vlm import DoclingVlm, whole_page_renders

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

    Embedded text on every selected nonblank page runs natively; substantial textless artwork, and native blocks
    whose font glyphs are undecodable, supplement it with OCR of their crops by the record's transcriber, whose
    knobs apply (`supplement`). A fully native run needs
    no model or server. Otherwise scanned/mixed documents use the record's transcriber and the request's
    settings. ValueError: knobs set that the transcriber does not honour. ConversionError: the page range lies
    outside the PDF.
    """
    if params.page_source not in ("pdf", "ingest"):
        raise ValueError(f"page_source must be pdf or ingest, not {params.page_source!r}")
    check_ingest(params.page_source, params.ingest)
    # Large book rasters retain their scan route so the split and gutter settings still apply.
    regions = native_regions(params.pdf, params.pages, allow_large_raster_artwork=params.page_source == "pdf")
    glyphs = regions is not None and undecodable_glyphs(params.pdf, params.pages)
    if regions == () and not glyphs:
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
                         ocr_regions=regions, ocr_text=glyphs)
    return Execution(pdf=params.pdf, source_name=params.source_name, transcriber=record.kind,
                     model=params.model, repo=record.repo, url=params.url,
                     cut=params.cut, layout_model=params.layout_model if params.cut == "auto" else None,
                     crop_dpi=params.crop_dpi, max_image_size=params.max_image_size,
                     max_output_tokens=params.max_output_tokens, stream=params.stream, pages=params.pages,
                     debug_dir=params.debug_dir, result_dir=params.result_dir, page_source=params.page_source,
                     ingest_dir=params.ingest_dir, ingest=params.ingest)


PAGE_EVENTS = frozenset({"page_start", "token", "page_end", "page_stats"})

# A run's inputs are transcribed batch by batch (`transcribe`): a batch's crops are rendered, transcribed and released
# before the next batch renders anything, so the rasters a run holds do not grow with its length. A batch is at most
# BATCH_INPUTS inputs, which leaves Surya's default 8 requests in flight, and BATCH_BYTES of estimated working memory;
# one input over BATCH_BYTES alone is a batch of its own, bounded by the render budget (`pages.MAX_RENDER_PIXELS`).
BATCH_INPUTS = 32
BATCH_BYTES = 512 * 2**20
# Working bytes per pixel of one input while its batch runs, estimated from the buffers involved, not a measured RSS.
CROP_BYTES = 6        # the L crop (1), its PNG while a backend encodes it (at most 1), a VLM's debug RGBA copy (4)
SURYA_PAGE_BYTES = 8  # the RGB page (4); Surya's resized copy of it while its request runs, and the crops of its
                      # blank-block check (at most 4). The loader holds one 4-byte PDFium bitmap at a time besides
VLM_PAGE_BYTES = 12   # each page render of Docling's: its RGBA bytes (4) and their PIL copy (4); the image the VLM
                      # reads converted to RGB, and the debug report's RGBA copy of it (4)
ARTWORK_CONTEXT = 24  # pt of real page a recovery reads around artwork that looped on an empty figure


def page_events(emit: Emit, inputs: Inventory) -> Emit:
    """The sink the transcribers and the report writer get: the input ordinal they number their events by becomes
    the PDF page, the unit and the crop the browser and the log read, so no adapter has to know about spreads."""
    def sink(event: Event) -> None:
        if event["type"] in PAGE_EVENTS:
            item = inputs.input(event["page"])
            event = {**event, "page": item.page, "unit": item.unit, "crop": item.ordinal if item.crop else None}
        emit(event)
    return sink


def inventory(numbers: list[int], crops: list[CropPlan] | None, book: BookPages | None) -> Inventory:
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


def announce(emit: Emit, crop: CropPlan, ordinal: int, book: BookPages | None) -> None:
    """The `region` event of crop `ordinal`, emitted as it is cut, at the size it renders. It names the PDF page and
    the box on it: over the ingest the crop's page is a book page, a unit."""
    page, region, (width, height) = crop
    spread = book.page(page).ingest.spread if book is not None else page
    bbox = book.page(page).to_page_points(region.bbox) if book is not None else region.bbox
    emit({"type": "region", "page": spread, "unit": page if book is not None else 0,
          "crop": ordinal, "order": region.order, "kind": region.kind, "bbox": list(bbox),
          "width": width, "height": height, "ink": round(region.ink, 3)})


def crop_costs(plans: list[CropPlan]) -> list[int]:
    """Each planned crop's estimated working bytes."""
    return [width * height * CROP_BYTES for _, _, (width, height) in plans]


def batches(costs: list[int]) -> list[range]:
    """The inputs, by index, in consecutive batches of at most BATCH_INPUTS and BATCH_BYTES of `costs` together; an
    input over BATCH_BYTES is a batch of its own."""
    found, start, total = [], 0, 0
    for index, cost in enumerate(costs):
        if index > start and (index - start == BATCH_INPUTS or total + cost > BATCH_BYTES):
            found.append(range(start, index))
            start, total = index, 0
        total += cost
    if costs:
        found.append(range(start, len(costs)))
    return found


def transcribe(execution: Execution, kind: str, inputs: Inventory, plans: list[CropPlan] | None, costs: list[int],
               pages: PageSource | None, emit: Emit, debug: Debug | None,
               recover: Callable[[int], CropPlan] | None = None) -> Transcription:
    """The `kind` transcriber over every input, one batch (`batches` of `costs`) at a time: the batch's planned crops
    are rendered (none for whole PDF pages, which the transcriber reads itself), transcribed, the images the debug
    report keeps saved, and every raster of the batch closed, whatever happened, before the next batch renders.
    The records returned keep no image.

    With `recover` (a hybrid run's artwork), the inputs the transcriber found looping on an empty figure are planned
    again with page context, once per batch: each old crop is closed before its new one renders, and the batch is
    transcribed again. Their `costs` already budget the recovered crops, which are checked against them before they
    render. The recovered plan replaces its entry in `plans`.
    """
    transcriber = TRANSCRIBERS[kind]
    sink = page_events(emit, inputs)
    parts: list[Transcription] = []
    for batch in batches(costs):
        first = batch.start + 1  # the batch's inputs are the run's ordinals first..batch.stop
        emit({"type": "cancel_point"})  # a cancelled run renders no further batch
        call = replace(execution, batch=(first, batch.stop))
        images: list[Image.Image] = []  # every raster this batch makes, its records' included: closed below
        try:
            crops = None
            if plans is not None:
                assert pages is not None and execution.crop_dpi is not None
                crops = []
                for number, region, size in plans[batch.start:batch.stop]:
                    images.append(render_region(pages.page(number), region, execution.crop_dpi))
                    assert images[-1].size == size, f"crop of page {number} rendered off its planned {size}"
                    crops.append((number, region, images[-1]))
            for attempt in range(2):
                try:
                    outcome = transcriber.transcribe(call, crops, sink)
                    break
                except ArtworkNeedsContext as error:
                    if recover is None or crops is None or pages is None:
                        raise
                    if attempt:
                        raise IncompleteConversionError(
                            "Bounded artwork recovery exhausted; output not written") from error
                    emit({"type": "log", "text": f"Retrying artwork inputs {error.ordinals} with page context."})
                    for ordinal in error.ordinals:
                        plans[ordinal - 1] = number, region, _ = recover(ordinal)  # planned, not rendered
                        assert crop_costs([plans[ordinal - 1]])[0] <= costs[ordinal - 1], "recovery over its budget"
                        crops[ordinal - first][2].close()
                        images.append(render_region(pages.page(number), region, execution.crop_dpi))
                        crops[ordinal - first] = (number, region, images[-1])
                        announce(emit, plans[ordinal - 1], ordinal, None)
            else:
                raise AssertionError("The bounded artwork recovery must return or raise")
            images += [record.image for record in outcome.pages if record.image is not None]
            if debug is not None and crops is not None and execution.transcriber == hybrid.KIND:
                debug.save(crops=((first + index, image) for index, (_, _, image) in enumerate(crops)))
            elif debug is not None:
                debug.save(outcome.pages)
            parts.append(replace(outcome, pages=[replace(record, image=None) for record in outcome.pages]))
        finally:
            for image in images:
                image.close()
    return joined(parts)


def joined(parts: list[Transcription]) -> Transcription:
    """One outcome of a run's batches, as one call over every input returns it: the records in order, every batch's
    unattributed reasons, the advice once. The batches' headers agree but for what each saw: errors add up, a VLM's
    default crop cap is its largest crop, and Docling's status is the first that was not success."""
    assert parts, "a run has at least one input"
    if len(parts) == 1:
        return parts[0]
    header = dict(parts[0].header)
    if "errors" in header:
        header["errors"] = [error for part in parts for error in part.header["errors"]]
    if header.get("max_size") is not None:
        header["max_size"] = max(part.header["max_size"] for part in parts)
    if "docling_status" in header:
        header["docling_status"] = next((part.header["docling_status"] for part in parts
                                         if part.header["docling_status"] != "success"), "success")
    return Transcription(header, [record for part in parts for record in part.pages],
                         "; ".join(part.unattributed for part in parts if part.unattributed) or None,
                         next((part.advice for part in parts if part.advice), None))


def undecodable_blocks(native: Transcription) -> tuple[Transcription, list[OcrRegion], list[int]]:
    """Native's records without their body blocks whose text keeps an undecodable glyph, and one region per box of
    each (its caption's first, for a table), with the block's index among its page's native blocks. Running heads
    and feet stay native."""
    records, regions, positions = [], [], []
    for record in native.pages:
        kept = []
        for index, block in enumerate(record.payload.get("blocks", [])):
            if block["label"] in hybrid.FURNITURE or not undecodable(block["html"]):
                kept.append(block)
                continue
            for box in [*block.get("caption_boxes", []), *block.get("boxes", [block["bbox"]])]:  # as its HTML reads
                regions.append(OcrRegion(record.source_page, tuple(box)))
                positions.append(index)
        # An empty list, not a missing one: without blocks a page file publishes the record as one coarse segment.
        records.append(record if len(kept) == len(record.payload.get("blocks", []))
                       else replace(record, payload={**record.payload, "blocks": kept}))
    return replace(native, pages=records), regions, positions


def supplement(execution: Execution, inputs: Inventory, emit: Emit, debug: Debug | None) -> Transcription:
    """A hybrid execution: the native transcriber on the selected pages, then the record's transcriber on one
    crop per region of textless artwork and, with `ocr_text`, per native block with an undecodable glyph (which
    leaves the native blocks and reads at its place), merged by `kei_exp.transcription.hybrid`.

    Each region reads at one anchor among its page's native blocks (`kei_exp.regions.anchor`, running heads and
    feet kept in place but never placing it), computed here once for both the Markdown and the page file; its
    crop's order is its rank among its page's regions in that reading order, so a page file's crops read in their
    cut order. Crop n is `execution.ocr_regions[n - 1]`, then the undecodable blocks' in page and reading order.
    """
    assert (execution.ocr_regions or execution.ocr_text) and execution.model is not None and execution.crop_dpi is not None
    native = TRANSCRIBERS[NativeText.kind].transcribe(execution, None, page_events(emit, inputs))
    blocks = {record.source_page: record.payload.get("blocks", []) for record in native.pages}
    native, text_regions, positions = undecodable_blocks(native) if execution.ocr_text else (native, [], [])
    regions = [*execution.ocr_regions, *text_regions]
    kinds = ["figure"] * len(execution.ocr_regions) + ["text"] * len(text_regions)
    # Each region's place in the native reading before any block was removed: artwork just before the block it
    # anchors at, a replaced block at its own. Placed among the blocks kept, two can share an anchor; this keeps
    # them in the order they were printed.
    places = [anchor([tuple(block["bbox"]) for block in blocks.get(region.page, [])], region.bbox,
                     {n for n, block in enumerate(blocks.get(region.page, [])) if block["label"] in hybrid.FURNITURE})
              - 0.5 for region in execution.ocr_regions] + positions
    removed: dict[int, set[int]] = {}
    for region, position in zip(text_regions, positions):
        removed.setdefault(region.page, set()).add(position)
    anchors = [sum(1 for i in range(len(blocks.get(region.page, []))) if i < place and i not in removed.get(region.page, ()))
               for region, place in zip(regions, places)]
    if not regions:  # the screen saw an undecodable glyph that Docling's text does not keep
        return native
    emit({"type": "log", "text": f"Preserving native PDF text; OCR only on {len(regions)} regions."})
    orders: dict[int, int] = {}
    counts: dict[int, int] = {}
    for n in sorted(range(len(regions)), key=lambda n: (regions[n].page, places[n], n)):
        orders[n] = counts.get(regions[n].page, 0)
        counts[regions[n].page] = orders[n] + 1
    try:
        with PdfPages(execution.pdf) as pages:
            plans: list[CropPlan] = []
            for plan in artwork_crops(pages, ((region.page, region.bbox, orders[n], kinds[n])
                                              for n, region in enumerate(regions)), execution.crop_dpi):
                plans.append(plan)
                announce(emit, plan, len(plans), None)

            def recover(ordinal: int) -> CropPlan:
                """Artwork input `ordinal` planned again with real page context around it."""
                region = regions[ordinal - 1]
                plan, = artwork_crops(pages, [(region.page, region.bbox, orders[ordinal - 1], "figure")],
                                      execution.crop_dpi, context_pt=ARTWORK_CONTEXT)
                return plan
            # An artwork input's batch is budgeted for the larger crop a recovery may plan for it; one whose context
            # would pass the render budget is refused only if a recovery needs it (`artwork_crops`).
            costs = crop_costs(plans)
            for index, region in enumerate(execution.ocr_regions):
                page = pages.page(region.page)
                width, height = page.render_size(execution.crop_dpi, context_box(page, region.bbox, ARTWORK_CONTEXT))
                costs[index] = max(costs[index], min(width * height, MAX_RENDER_PIXELS) * CROP_BYTES)
            ocr_inputs = inventory(sorted({region.page for region in regions}), plans, None)
            recognized = transcribe(execution, MODELS[execution.model].kind, ocr_inputs, plans, costs, pages, emit,
                                    debug, recover)
    except CutError as error:
        raise ConversionError(f"Artwork crop failed: {error}") from error
    return hybrid.supplement(native, recognized, plans, anchors)


def run(execution: Execution, emit: Emit = print_event, *, book: BookPages | None = None,
        adopt: Callable[[str, list[int]], LoadedResult | None] | None = None,
        before_ocr: Callable[[], None] | None = None) -> str:
    """Cut the supplied pages, transcribe them, write the result, and return its Markdown.

    The source is hashed before cutting and transcription. The API uses its private input.pdf; the CLI
    reads the file it was given. Ingest, when needed, has already run.
    The worker's hooks (`kei_exp.reuse`): `adopt` is asked first with the recipe's fingerprint and the PDF pages the
    result must list, and a result means it published an earlier run's result of that recipe in `result_dir`, whose
    Markdown is returned with nothing cut or transcribed; otherwise `before_ocr` runs (the model server's probe) and
    then the work.
    ConversionError: the run produced no trustworthy output; the debug report, when asked for, is written before
    that is decided. The debug report is diagnostic only: a failure writing it (or its images) is logged and
    reported as a `log` event, never raised, and never stops an accepted result or its Markdown from returning.
    """
    source = Source.of(execution)  # name, identity and page sizes, fixed before a byte of the PDF is parsed
    first, last = execution.pages or (1, source.page_count)
    if not 1 <= first <= last <= source.page_count:
        raise ConversionError(f"page range {first}-{last} outside 1-{source.page_count}")
    assert (book is not None) == (execution.page_source == "ingest"), "ingest execution needs book pages"
    ingest_digest = book.digest if book is not None else None
    if adopt is not None:
        pages = (sorted({book.page(n).ingest.spread for n in book.numbers_in(execution.pages)}) if book is not None
                 else list(range(first, last + 1)))  # as `inventory` lists them
        adopted = adopt(fingerprint(recipe(execution, source.sha256, ingest_digest)), pages)
        if adopted is not None:
            emit({"type": "log", "text": "OCR skipped: adopted an earlier run's result of this source and recipe"})
            return page_markdown(page.markdown for page in adopted.pages.values())
    if before_ocr is not None:
        before_ocr()
    try:
        # Book pages, or the PDF's when it is cut, stay open while the batches render; whole PDF pages are the
        # transcriber's to read.
        with (nullcontext(book) if book is not None else PdfPages(execution.pdf) if execution.cut == "auto"
              else nullcontext(None)) as pages:
            plans = None
            if pages is not None:
                assert execution.crop_dpi is not None
                numbers = book.numbers_in(execution.pages) if book is not None else list(range(first, last + 1))
                if execution.cut == "auto":
                    assert execution.layout_model is not None
                    emit({"type": "phase", "name": "cut", "total": len(numbers)})
                    produced = cut_pages(pages, numbers, execution.crop_dpi, layout_model=execution.layout_model)
                else:
                    produced = whole_pages(pages, numbers, execution.crop_dpi)
                plans = []
                for plan in produced:  # announced as each page is cut; nothing is rendered at crop dpi yet
                    plans.append(plan)
                    announce(emit, plan, len(plans), book)
            else:  # whole PDF pages: the transcriber renders them itself, and its inputs are the selected pages
                numbers = list(range(first, last + 1))
            inputs = inventory(numbers, plans, book)
            sink = page_events(emit, inputs)
            debug = Debug(execution.debug_dir, sink) if execution.debug_dir is not None else None
            started = datetime.now(UTC).isoformat()
            clock = time.monotonic()
            if plans is not None and not plans:
                # The cut found nothing on any page. An empty list never reaches a transcriber, which reads it as
                # "the whole PDF"; the run is judged below with the refusal it always had.
                outcome = Transcription({}, [], unattributed="the layout cut found no content")
            elif execution.transcriber == hybrid.KIND:
                outcome = supplement(execution, inputs, emit, debug)
            elif execution.transcriber == NativeText.kind:  # text, no raster: nothing to batch
                outcome = TRANSCRIBERS[NativeText.kind].transcribe(execution, None, sink)
            elif plans is not None:
                outcome = transcribe(execution, execution.transcriber, inputs, plans, crop_costs(plans), pages, emit,
                                     debug)
            else:
                record = MODELS[execution.model]
                costs = []
                if record.kind == DoclingVlm.kind:  # sized by Docling's own parser, before Docling renders a page
                    assert execution.url is not None
                    planned = whole_page_renders(record, execution.url, execution.max_image_size, execution.pdf,
                                                 numbers, emit)
                for number in numbers:
                    width, height = source.sizes[number]
                    if record.kind == SuryaOcr.kind:  # Surya's loader renders RGB at its record's scale
                        dpi = round(72 * record.scale)
                        size = (math.ceil(width * dpi / 72), math.ceil(height * dpi / 72))
                        check_render_size(*size, number, dpi)  # before any batch is transcribed
                        costs.append(size[0] * size[1] * SURYA_PAGE_BYTES)
                    elif record.kind == DoclingVlm.kind:  # Docling renders the page itself, twice
                        renders = planned[number]
                        for render_width, render_height, dpi in renders:
                            check_render_size(render_width, render_height, number, dpi)  # before Docling renders it
                        costs.append(sum(w * h for w, h, _ in renders) * VLM_PAGE_BYTES)
                    else:  # no other transcriber reads whole PDF pages: count the inputs alone
                        costs.append(0)
                outcome = transcribe(execution, execution.transcriber, inputs, None, costs, None, emit, debug)
            seconds = time.monotonic() - clock
    except CutError as error:
        raise ConversionError(f"Layout cut failed: {error}") from error
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
    if debug is not None:  # diagnostics only: never raises, the accepted result above is already written
        debug.write(outcome, execution, started, seconds)
    # IncompleteConversionError, not ConversionError: kei_exp.failures.classify() matches on this TYPE to
    # keep an incomplete recognition out of the retried set. It is about this document at this budget and
    # repeats identically, unlike a refused server; typing it (rather than matching phrases in the message)
    # stops a scanned page whose OCR'd text happens to contain something like "connection timed out" from
    # looking like a transient network failure and earning two pointless GPU retries. The message text itself
    # is not load-bearing any more and can be reworded freely.
    if outcome.incomplete:
        raise IncompleteConversionError(f"Conversion incomplete; output not written: {outcome.incomplete}")
    return markdown

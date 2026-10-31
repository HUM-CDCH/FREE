"""Surya OCR 2 through the shared vLLM server: one full-page request per image, block HTML joined for Docling."""
import math
from collections import deque
from collections.abc import Callable
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from pathlib import Path
from threading import Event
from time import monotonic
from types import SimpleNamespace
from typing import NamedTuple, cast

import pypdfium2 as pdfium
from PIL import Image

from kei_exp._pdfium import pdfium_lock
from kei_exp.models import MODELS
from kei_exp.pages import check_render_size
from kei_exp.progress import STOP_REASONS, Emit
from kei_exp.regions import Crop, region_info
from kei_exp.transcription import html as html_export
from kei_exp.transcription.types import (
    TRANSCRIBER_KNOBS,
    ArtworkNeedsContext,
    ConversionError,
    Execution,
    PageRecord,
    Transcription,
    html_to_text,
)


class _CompletionClient:
    """Surya's chat client for one request at a time: the completion streamed to `on_token` piece by piece when a
    sink is given, and the last attempt's prompt usage and finish reason kept here, before Surya reduces the
    response to its text and token count."""

    def __init__(self, client, on_token: Callable[[str], None] | None = None, *, watch_artwork: bool = False) -> None:
        self.client = client
        self.on_token = on_token
        self.watch_artwork = watch_artwork
        self.figure_loop = False
        self.input_tokens: int | None = None
        self.finish_reason: str | None = None
        self.chat = self.completions = self

    def create(self, **kwargs):
        self.input_tokens = self.finish_reason = None
        self.figure_loop = False
        if self.on_token is None and not self.watch_artwork:
            response = self.client.chat.completions.create(**kwargs)
        else:
            with self.client.chat.completions.create(**kwargs, stream=True,
                                                     stream_options={"include_usage": True}) as stream:
                response = _collect_completion(stream, self.on_token, watch_artwork=self.watch_artwork)
                self.figure_loop = response.figure_loop
        self.finish_reason = response.choices[0].finish_reason
        count = getattr(response.usage, "prompt_tokens", None)
        self.input_tokens = count if type(count) is int and count >= 0 else None
        return response


def _collect_completion(stream, on_token: Callable[[str], None] | None, *, watch_artwork: bool = False):
    """A streamed chat completion, collected into what Surya's `_generate_one` reads from a whole one: the joined
    text as `choices[0].message.content`, that choice's logprobs and finish reason, and the usage the server
    sends last (`None` when it does not, as for a whole completion). A stream that ends without a finish reason
    the server could name is broken and raises; Surya's client makes that an error result and retries."""
    pieces: list[str] = []
    logprobs: list = []
    usage = finish_reason = None
    figure_loop, checked, length = False, 0, 0
    for chunk in stream:
        usage = chunk.usage or usage
        for choice in chunk.choices:  # the usage chunk has none
            text = choice.delta.content if choice.delta else None
            if text:
                pieces.append(text)
                length += len(text)
                if on_token:
                    on_token(text)
            if choice.logprobs and choice.logprobs.content:
                logprobs.extend(choice.logprobs.content)
            finish_reason = choice.finish_reason or finish_reason
        if watch_artwork and length >= 512 and length - checked >= 128:
            from surya.inference.parsers import parse_full_page_html
            from surya.inference.util import detect_repeat_token

            raw = "".join(pieces).strip()
            if not raw.endswith("</div>"):
                continue  # wait for the whole block; an unfinished following text/table must not be discarded
            checked = length
            blocks = parse_full_page_html(raw)
            # Only the observed empty, identical full-frame figure loop. Repeated prose, table rows and
            # different picture boxes keep Surya's existing retries and layout recovery.
            if len(blocks) > 1 and not html_to_text(raw).strip() and all(
                block.label in {"Figure", "Image", "Picture", "Diagram"}
                and block.bbox == (0, 0, 1000, 1000)
                and (block.label, block.html) == (blocks[0].label, blocks[0].html) for block in blocks
            ) and detect_repeat_token(raw):
                figure_loop = True
                break  # the caller's context manager closes the stream before any recovery starts
    if not figure_loop and finish_reason not in STOP_REASONS:
        raise RuntimeError(f"Surya stream ended without a finish reason: {finish_reason!r}")
    return SimpleNamespace(usage=usage, figure_loop=figure_loop, choices=[SimpleNamespace(
        message=SimpleNamespace(content="".join(pieces)),
        logprobs=SimpleNamespace(content=logprobs) if logprobs else None, finish_reason=finish_reason)])


RETRY_BACKOFF = 1.5  # seconds per retry so far before retrying a request that failed, as Surya's own client waits


class _InferenceManager:
    """Surya's vLLM backend with prompt usage retained in each output's metadata and, given `emit`, every
    full-page request reported as it runs: one `page_start` per attempt, that attempt's `token`s, and one
    `page_end` after Surya's retries, timed over the final attempt. `page_end` ends generation, not recognition:
    Surya still parses the output and may rebuild the page from layout.

    Upstream's batch runner discards usage and offers no response hook. Keep its request generation, parsing and
    retry predicate and schedule; mirror only the concurrent retry loop, with a private client per attempt.

    `check` runs on the calling thread, the conversion step's own, and raises once its workflow is cancelled
    (`kei_exp.workflows.cancel`): it is asked before every request is admitted, a retry included, and at least every
    second while requests run, so a cancel sends nothing more and the requests already sent finish first.
    """

    def __init__(self, emit: Emit | None = None, *, artwork_count: int = 0, offset: int = 0,
                 check: Callable[[], None] = lambda: None) -> None:
        from surya.inference import SuryaInferenceManager
        self.backend = SuryaInferenceManager().backend
        self.emit = emit
        self.artwork_count = artwork_count  # run ordinals 1..artwork_count are artwork crops
        self.offset = offset                # the run ordinal of this call's first image, less one
        self.check = check

    def generate(self, batch):
        from surya.inference.backends.openai_client import _generate_one, _should_retry
        from surya.inference.schema import PROMPT_TYPE_HIGH_ACCURACY_BBOX, BatchOutputItem
        from surya.inference.util import detect_repeat_token
        from surya.settings import settings

        if not batch:
            return []
        handle = self.backend.start()
        parallel = self.backend._client_parallel()
        # ponytail: only full-page requests stream; a rebuilt page's blocks arrive with the result
        pages = [self.offset + item.metadata["page_idx"] + 1 if item.prompt_type == PROMPT_TYPE_HIGH_ACCURACY_BBOX
                 else None for item in batch]
        stopping = Event()  # set when generation ends early: a retry still waiting out its backoff sends nothing

        def attempt(index: int, retries: int, after_error: bool):
            """Request number `retries` + 1 for batch[index], on a pool thread, at Surya's settings for that retry."""
            page = pages[index]
            emit = self.emit if page is not None else None
            if after_error and stopping.wait(RETRY_BACKOFF * retries):
                return None
            on_token = (lambda text: emit({"type": "token", "page": page, "text": text})) if emit else None
            client = _CompletionClient(self.backend._client, on_token,
                                       watch_artwork=page is not None and page <= self.artwork_count)
            if emit:
                emit({"type": "page_start", "page": page})  # a retry starts the page's text over
            started = monotonic()
            result = _generate_one(
                batch[index], client=client, model_name=handle.model_name, max_tokens_default=2048,
                temperature=min(0.2 * retries, 0.8), top_p=0.1 if retries == 0 or after_error else 0.95,
                timeout=settings.SURYA_INFERENCE_TIMEOUT_SECONDS,
                request_logprobs_default=settings.SURYA_INFERENCE_LOGPROBS,
            )
            return result, client, monotonic() - started

        outputs = [None] * len(batch)
        failed_text = set()  # inputs whose full-page attempt generated text, then looped or ran out of tokens
        waiting = deque((index, 0, False) for index in range(len(batch)))  # (input, retries so far, after an error)
        running: dict[Future, tuple[int, int]] = {}
        with ThreadPoolExecutor(max_workers=parallel) as executor:
            try:
                while waiting or running:
                    self.check()
                    while waiting and len(running) < parallel:
                        index, retries, after_error = waiting.popleft()
                        running[executor.submit(attempt, index, retries, after_error)] = (index, retries)
                    done, _ = wait(running, timeout=1.0, return_when=FIRST_COMPLETED)
                    for future in done:
                        index, retries = running.pop(future)
                        result, client, seconds = future.result()
                        # Generated text, not proof of source text: it may be hallucinated or a neighbour's. The
                        # repetition test is `_should_retry`'s. An errored attempt has no text, and a later one cannot
                        # clear the flag.
                        raw = result.raw
                        if pages[index] is not None and html_to_text(raw).strip() and (
                                client.finish_reason == "length" or detect_repeat_token(raw)
                                or (len(raw) > 50 and detect_repeat_token(raw, cut_from_end=50))):
                            failed_text.add(index)
                        if not client.figure_loop and _should_retry(result, retries, 3):
                            waiting.appendleft((index, retries + 1, result.error))  # takes the slot it leaves
                            continue
                        if self.emit and pages[index] is not None:
                            self.emit({"type": "page_end", "page": pages[index], "seconds": seconds,
                                       "stop_reason": "error" if result.error or client.figure_loop
                                       else STOP_REASONS[client.finish_reason],
                                       "output_tokens": None if client.figure_loop else result.token_count})
                        outputs[index] = BatchOutputItem(
                            raw="" if client.figure_loop else result.raw, token_count=result.token_count,
                            error=result.error or client.figure_loop,
                            mean_token_prob=result.mean_token_prob, logprobs=result.logprobs,
                            metadata={**batch[index].metadata, "input_tokens": client.input_tokens,
                                      "artwork_context": client.figure_loop, "failed_text": index in failed_text},
                        )
            except BaseException:
                stopping.set()  # leaving the pool then waits for the requests already sent
                raise
        # Every peer has joined before the coordinator closes or replaces crop images. Partial figure markup never
        # reaches RecognitionPredictor, whose layout fallback can turn this particular loop into spurious text.
        ordinals = tuple(self.offset + output.metadata["page_idx"] + 1 for output in outputs
                         if output.metadata["artwork_context"])
        if ordinals:
            raise ArtworkNeedsContext(ordinals)
        return outputs


class Kept(NamedTuple):
    """The output Surya kept for one page."""
    tokens: int
    input_tokens: int | None
    capped: str | None  # the request of that output that used up its max_tokens, so content is missing


class KeptOutputs:
    """Surya's inference manager, remembering per page the output RecognitionPredictor keeps.

    Surya's client retries a looping output on its own, so only each request's final answer matters: the last
    full-page output, unless Surya rejected it and rebuilt the page from one layout request and one request per
    block, in which case any of those running out of tokens loses content. Rebuilt pages are a subset: their
    layout requests carry the page images themselves and their block requests index into that subset, so the
    predictor must run its own layout (no layout_results supplied) for the attribution to hold.

    `failed_text` holds the original page indices whose full-page generation produced text that looped or ran out
    of tokens, kept apart from the usage above: a rebuilt page's layout and block outputs replace its usage, not this.
    """

    def __init__(self, manager, images: list, emit: Emit | None = None, offset: int = 0) -> None:
        self.manager = manager
        self.images = images
        self.emit = emit  # told which pages are rebuilt, before their layout requests run
        self.offset = offset  # the run ordinal of images[0], less one
        self.full_page: dict[int, Kept] = {}
        self.fallback: dict[int, Kept] = {}
        self.subset: list[int | None] = []  # page index of each page in the current fallback batch
        self.unattributed: list[str] = []   # capped requests no page could be found for
        self.failed_text: set[int] = set()

    def generate(self, batch):
        from surya.inference.schema import (  # configure() pointed Surya at the server
            PROMPT_TYPE_BLOCK,
            PROMPT_TYPE_HIGH_ACCURACY_BBOX,
            PROMPT_TYPE_LAYOUT,
        )
        from surya.settings import settings
        if batch and batch[0].prompt_type == PROMPT_TYPE_LAYOUT:
            self.subset, taken = [], set()
            for item in batch:  # in page order, so a page image handed in twice still maps to distinct pages
                index = next((i for i, image in enumerate(self.images) if image is item.image and i not in taken), None)
                self.subset.append(index)
                taken.add(index)
            if self.emit is not None:  # said before the layout requests run, not after
                rebuilt = [self.offset + index + 1 for index in self.subset if index is not None]
                self.emit({"type": "log", "text": f"Surya rejected the full-page output of page(s) {rebuilt}: "
                           "rebuilding from layout and blocks"})
        outputs = self.manager.generate(batch)
        for position, (item, output) in enumerate(zip(batch, outputs)):
            input_tokens = output.metadata.get("input_tokens")
            capped = None
            if item.max_tokens is not None and output.token_count >= item.max_tokens:
                if item.prompt_type == PROMPT_TYPE_HIGH_ACCURACY_BBOX:
                    capped = f"full page request's {item.max_tokens}-token cap"
                elif item.prompt_type == PROMPT_TYPE_LAYOUT:
                    capped = f"layout request's {item.max_tokens}-token cap"
                elif item.max_tokens >= settings.SURYA_MAX_TOKENS_BLOCK_CEILING:  # Surya's estimate hit the ceiling
                    capped = f"{item.prompt_type} request's {item.max_tokens}-token ceiling"
                else:
                    capped = f"{item.prompt_type} request's {item.max_tokens}-token estimate"
            if item.prompt_type == PROMPT_TYPE_LAYOUT:
                page = self.subset[position]
            elif item.prompt_type == PROMPT_TYPE_BLOCK:
                index = item.metadata.get("page_idx")
                page = self.subset[index] if index is not None and index < len(self.subset) else None
            else:
                page = item.metadata.get("page_idx")
            if page is None:
                if capped:
                    self.unattributed.append(capped)
            elif item.prompt_type == PROMPT_TYPE_HIGH_ACCURACY_BBOX:
                self.full_page[page] = Kept(output.token_count, input_tokens, capped)
                if output.metadata.get("failed_text"):
                    self.failed_text.add(page)
            elif item.prompt_type == PROMPT_TYPE_LAYOUT:
                self.fallback[page] = Kept(output.token_count, input_tokens, capped)  # rebuilt: full-page output is gone
            else:
                before = self.fallback.get(page, Kept(0, 0, None))
                total_input = (before.input_tokens + input_tokens
                               if before.input_tokens is not None and input_tokens is not None else None)
                self.fallback[page] = Kept(before.tokens + output.token_count, total_input, before.capped or capped)
        return outputs

    def kept(self, page: int) -> Kept | None:
        return self.fallback.get(page, self.full_page.get(page))


def settings_for(url: str, max_new_tokens: int, params: dict) -> dict:
    """What `configure` assigns to Surya's process-global settings for one record and server. Two conversions in one
    worker share these, so every Surya record must produce the same values (tests/test_lanes.py)."""
    return {"SURYA_INFERENCE_BACKEND": "vllm", "SURYA_INFERENCE_URL": url.removesuffix("/chat/completions"),
            # Surya retries an output that loops but otherwise ignores finish_reason, so a page that runs out of
            # output tokens comes back short, error-free and full-confidence. Budget for the worst page; KeptOutputs
            # catches the rest.
            "SURYA_MAX_TOKENS_FULL_PAGE": max_new_tokens, **params}


def configure(url: str, max_new_tokens: int, params: dict) -> None:
    """Point Surya at the vLLM server behind a chat completions url and pin the record's decoding settings.

    Surya builds its settings object once, at import, from the environment; every setting used here is read
    again at call time, so assigning them works no matter when Surya was first imported, and a later call with
    another server or allowance simply replaces them. `params` are the surya record's settings (guided layout,
    regeneration, the layout and block token ceilings): pinned here, they are part of a run's recipe instead of
    whatever the environment held.
    """
    from surya.settings import settings
    for name, value in settings_for(url, max_new_tokens, params).items():
        setattr(settings, name, value)


def whole_pages(pdf: Path, pages: tuple[int, int] | None, dpi: int) -> list[Image.Image]:
    """Whole scans as Surya's own loader renders them (`surya.input.processing.get_page_images`: RGB at dpi,
    annotations left out), one page at a time: the range and every page's render size (`pages.MAX_RENDER_PIXELS`) are
    checked first, and a failure closes what was rendered before it, where Surya's loader would drop it unclosed."""
    with pdfium_lock:
        document = pdfium.PdfDocument(str(pdf))
        images: list[Image.Image] = []
        try:
            count = len(document)
            first, last = pages or (1, count)
            if not 1 <= first <= last <= count:
                raise ConversionError(f"page range {first}-{last} outside 1-{count}")
            for number in range(first, last + 1):
                page = document[number - 1]
                try:
                    width, height = page.get_size()
                finally:
                    page.close()
                check_render_size(math.ceil(width * (dpi / 72)), math.ceil(height * (dpi / 72)), number, dpi)
            for number in range(first, last + 1):
                page = document[number - 1]
                try:
                    bitmap = page.render(scale=dpi / 72, draw_annots=False)
                finally:
                    page.close()
                try:
                    view = bitmap.to_pil()
                    try:
                        images.append(view.convert("RGB"))
                    finally:
                        view.close()  # an image's `with` closes only a file
                finally:
                    bitmap.close()
        except BaseException:
            for image in images:
                image.close()
            raise
        finally:
            document.close()
        return images


def where(crop: Crop | None, pages: tuple[int, int] | None, number: int) -> str:
    """Run ordinal `number` as the diagnostics name it: its source page and, with cuts, its crop's region."""
    if crop is not None:
        page, region, _ = crop
        return f"page {number} (source page {page}, region {region.order})"
    return f"page {number} (source page {pages[0] + number - 1})" if pages else f"page {number}"


ADVICE = ("content is missing or could not be confirmed: raise the surya record's max_new_tokens and context for a "
          "page longer than its budget (the record's SURYA_MAX_TOKENS_LAYOUT and SURYA_MAX_TOKENS_BLOCK_CEILING for "
          "a rebuilt page); a looping page, a block capped at Surya's estimate or a failed layout needs a different "
          "crop; an empty recognition after an unreliable generation may be a textless input or lost text, so check "
          "it against the source (see the debug report)")


class SuryaOcr:
    """Transcriber over the surya-ocr client: full-page OCR per image, Markdown through Docling's HTML backend."""
    kind = "surya"
    knobs = TRANSCRIBER_KNOBS[kind]

    def transcribe(self, execution: Execution, crops: list[Crop] | None, emit: Emit) -> Transcription:
        assert execution.model is not None and execution.url is not None  # resolve() gives a surya execution both
        record = MODELS[execution.model]
        assert record.max_new_tokens is not None  # the surya record carries its output budget
        configure(execution.url, record.max_new_tokens, record.params)
        from surya.inference import SuryaInferenceManager
        from surya.recognition import RecognitionPredictor

        offset = execution.batch[0] - 1 if execution.batch else 0
        first = execution.pages[0] if execution.pages else 1
        if crops:
            images = [image for _, _, image in crops]
        else:  # this call's pages only, loaded here and handed back on the records
            span = (first + offset, first + execution.batch[1] - 1) if execution.batch else execution.pages
            images = whole_pages(execution.pdf, span, round(72 * record.scale))
        try:  # the pages loaded here are handed over on the records, or closed here: crops are the caller's
            emit({"type": "phase", "name": "ocr", "total": len(images)})  # a cancel is observed here, too
            live = emit if execution.stream else None  # the stream knob: page events and tokens as they are generated
            try:
                # The step's cancel sink reads the workflow's status on a cancel_point from this, its own, thread.
                manager = KeptOutputs(_InferenceManager(live, artwork_count=len(execution.ocr_regions), offset=offset,
                                                        check=lambda: emit({"type": "cancel_point"})),
                                      images, live, offset)
                results = RecognitionPredictor(cast(SuryaInferenceManager, manager))(images)  # the manager's interface
            except ArtworkNeedsContext:
                raise
            except RuntimeError as error:  # Surya's SpawnError: server unreachable or serving another model, and kin
                raise ConversionError(f"Surya failed; output not written: {error}") from error
            emit({"type": "phase", "name": "export", "total": None})
            # Docling's HTML backend takes everything before the first heading for a web page's furniture (navigation,
            # banners) and leaves it out of the Markdown. A catalogue page that continues a section starts with exactly
            # that: its page number and the entries before the next heading. Nothing Surya read is furniture.
            converter = html_export.converter()
            kept = [manager.kept(index) for index in range(len(images))]
            pages = []
            for index, (image, page, output) in enumerate(zip(images, results, kept)):
                number = offset + index + 1  # the run's ordinal of this input
                crop = crops[index] if crops else None
                blocks = page.blocks
                reasons = []
                # Before ownership filtering: a recovered input may rightly publish nothing once its neighbour's text
                # is dropped, but a recognition with no text at all after a looping or capped text attempt is
                # unresolved.
                # shortcut: target text lost while a neighbour's text survives passes; no attribution can catch it.
                if index in manager.failed_text and not any(
                        not block.skipped and html_to_text(block.html).strip() for block in blocks):
                    reasons.append(f"{where(crop, execution.pages, number)}: empty recognition remains unresolved "
                                   "after an unreliable text-bearing generation")
                if crop is not None and number <= len(execution.ocr_regions):
                    target = execution.ocr_regions[number - 1].bbox
                    _, region, _ = crop
                    if region.bbox != target:  # the recovered input includes neighbouring native text
                        assert region.transform is not None
                        kept_blocks = []
                        x0, y0, x1, y1 = target
                        for block in blocks:
                            xs, ys = zip(*block.polygon)
                            a, b, c, d = region.transform.to_unit_points((min(xs), min(ys), max(xs), max(ys)))
                            if c <= x0 or a >= x1 or d <= y0 or b >= y1:
                                continue
                            if not (a >= x0 and b >= y0 and c <= x1 and d <= y1) and not block.skipped \
                                    and html_to_text(block.html).strip():
                                reasons.append(f"{where(crop, execution.pages, number)}: OCR text crosses the original "
                                               "artwork boundary; ownership is ambiguous")
                            kept_blocks.append(block)  # retain ambiguous text in diagnostics, refuse acceptance below
                        blocks = kept_blocks
                        page = page.model_copy(update={"blocks": blocks})
                html = "\n".join(block.html for block in blocks if not block.skipped)
                markdown, unreadable = html_export.markdown(converter, html, f"{execution.pdf.stem}-{number}")
                if output and output.capped:
                    reasons.append(f"{where(crop, execution.pages, number)} stopped at its {output.capped}")
                if index in manager.fallback and not blocks:
                    # A rebuilt page with no block at all lost its content: its layout request failed or answered
                    # nonsense.
                    reasons.append(f"{where(crop, execution.pages, number)} came back empty after Surya rejected its "
                                   "full-page output and its layout request failed")
                if unreadable:
                    reasons.append(f"{where(crop, execution.pages, number)}: Docling could not read Surya's HTML: "
                                   f"{unreadable}")
                errors = sum(block.error for block in blocks)
                if errors:
                    reasons.append(f"{where(crop, execution.pages, number)}: {errors} block{'s' if errors > 1 else ''} "
                                   "came back in error")
                tokens = output.tokens if output else None
                input_tokens = output.input_tokens if output else None
                capped = bool(output and output.capped)
                pages.append(PageRecord(
                    page=number, region=region_info(crop), image=image,
                    seconds=None, input_tokens=input_tokens, output_tokens=tokens, stop=None, capped=capped,
                    payload=page.model_dump(mode="json"),
                    stats={"blocks": len(blocks), "errors": errors,
                           "skipped": sum(block.skipped for block in blocks), "input_tokens": input_tokens,
                           "output_tokens": tokens, "capped": capped},
                    markdown=markdown, text=html_to_text(html), incomplete="; ".join(reasons) or None,
                    source_page=None if crops else first + number - 1,
                ))
            header = {"prompt": None, "scale": None if crops else record.scale, "max_size": None,
                      "max_output_tokens": record.max_new_tokens, "generation_params": None, "errors": []}
            unattributed = [f"a request no page could be attributed to stopped at its {request}"
                            for request in manager.unattributed]
            # The advice follows every reason of the run, once, however many batches it took.
            advice = ADVICE if unattributed or any(record.incomplete for record in pages) else None
            return Transcription(header, pages, "; ".join(unattributed) or None, advice)
        except BaseException:
            if not crops:
                for image in images:
                    image.close()
            raise

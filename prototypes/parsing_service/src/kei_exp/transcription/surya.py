"""Surya OCR 2 through the shared vLLM server: one full-page request per image, block HTML joined for Docling."""
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from pathlib import Path
from time import monotonic, sleep
from types import SimpleNamespace
from typing import NamedTuple, cast

import pypdfium2 as pdfium
from docling.datamodel.backend_options import HTMLBackendOptions
from docling.datamodel.base_models import ConversionStatus, DocumentStream, InputFormat
from docling.document_converter import DocumentConverter, HTMLFormatOption
from PIL import Image

from kei_exp._pdfium import pdfium_lock
from kei_exp.cut import Crop, region_info
from kei_exp.models import MODELS
from kei_exp.progress import STOP_REASONS, Emit
from kei_exp.transcription.types import ConversionError, Execution, PageRecord, Transcription, html_to_text


class _CompletionClient:
    """Surya's chat client for one request at a time: the completion streamed to `on_token` piece by piece when a
    sink is given, and the last attempt's prompt usage and finish reason kept here, before Surya reduces the
    response to its text and token count."""

    def __init__(self, client, on_token: Callable[[str], None] | None = None) -> None:
        self.client = client
        self.on_token = on_token
        self.input_tokens: int | None = None
        self.finish_reason: str | None = None
        self.chat = self.completions = self

    def create(self, **kwargs):
        self.input_tokens = self.finish_reason = None
        if self.on_token is None:
            response = self.client.chat.completions.create(**kwargs)
        else:
            with self.client.chat.completions.create(**kwargs, stream=True,
                                                     stream_options={"include_usage": True}) as stream:
                response = _collect_completion(stream, self.on_token)
            self.finish_reason = response.choices[0].finish_reason
        count = getattr(response.usage, "prompt_tokens", None)
        self.input_tokens = count if type(count) is int and count >= 0 else None
        return response


def _collect_completion(stream, on_token: Callable[[str], None]):
    """A streamed chat completion, collected into what Surya's `_generate_one` reads from a whole one: the joined
    text as `choices[0].message.content`, that choice's logprobs and finish reason, and the usage the server
    sends last (`None` when it does not, as for a whole completion). A stream that ends without a finish reason
    the server could name is broken and raises; Surya's client makes that an error result and retries."""
    pieces: list[str] = []
    logprobs: list = []
    usage = finish_reason = None
    for chunk in stream:
        usage = chunk.usage or usage
        for choice in chunk.choices:  # the usage chunk has none
            text = choice.delta.content if choice.delta else None
            if text:
                pieces.append(text)
                on_token(text)
            if choice.logprobs and choice.logprobs.content:
                logprobs.extend(choice.logprobs.content)
            finish_reason = choice.finish_reason or finish_reason
    if finish_reason not in STOP_REASONS:
        raise RuntimeError(f"Surya stream ended without a finish reason: {finish_reason!r}")
    return SimpleNamespace(usage=usage, choices=[SimpleNamespace(
        message=SimpleNamespace(content="".join(pieces)),
        logprobs=SimpleNamespace(content=logprobs) if logprobs else None, finish_reason=finish_reason)])


class _InferenceManager:
    """Surya's vLLM backend with prompt usage retained in each output's metadata and, given `emit`, every
    full-page request reported as it runs: one `page_start` per attempt, that attempt's `token`s, and one
    `page_end` after Surya's retries, timed over the final attempt. `page_end` ends generation, not recognition:
    Surya still parses the output and may rebuild the page from layout.

    Upstream's batch runner discards usage and offers no response hook. Keep its request generation,
    parsing and retry predicate; mirror only the concurrent retry loop, with a private client per item.
    """

    def __init__(self, emit: Emit | None = None) -> None:
        from surya.inference import SuryaInferenceManager
        self.backend = SuryaInferenceManager().backend
        self.emit = emit

    def generate(self, batch):
        from surya.inference.backends.openai_client import _generate_one, _should_retry
        from surya.inference.schema import PROMPT_TYPE_HIGH_ACCURACY_BBOX, BatchOutputItem
        from surya.settings import settings

        if not batch:
            return []
        handle = self.backend.start()

        def process(item):
            # ponytail: only full-page requests stream; a rebuilt page's blocks arrive with the result
            page = item.metadata["page_idx"] + 1 if item.prompt_type == PROMPT_TYPE_HIGH_ACCURACY_BBOX else None
            emit = self.emit if page is not None else None
            on_token = (lambda text: emit({"type": "token", "page": page, "text": text})) if emit else None
            client = _CompletionClient(self.backend._client, on_token)
            retries, temperature, top_p = 0, 0.0, 0.1
            while True:
                if emit:
                    emit({"type": "page_start", "page": page})  # a retry starts the page's text over
                started = monotonic()
                result = _generate_one(
                    item, client=client, model_name=handle.model_name, max_tokens_default=2048,
                    temperature=temperature, top_p=top_p, timeout=settings.SURYA_INFERENCE_TIMEOUT_SECONDS,
                    request_logprobs_default=settings.SURYA_INFERENCE_LOGPROBS,
                )
                if not _should_retry(result, retries, 3):
                    break
                retries += 1
                if result.error:
                    sleep(1.5 * retries)
                temperature = min(0.2 * retries, 0.8)
                top_p = 0.1 if result.error else 0.95
            if emit:
                emit({"type": "page_end", "page": page, "seconds": monotonic() - started,
                      "stop_reason": "error" if result.error else STOP_REASONS[client.finish_reason],
                      "output_tokens": result.token_count})
            return BatchOutputItem(
                raw=result.raw, token_count=result.token_count, error=result.error,
                mean_token_prob=result.mean_token_prob, logprobs=result.logprobs,
                metadata={**item.metadata, "input_tokens": client.input_tokens},
            )

        with ThreadPoolExecutor(max_workers=self.backend._client_parallel()) as executor:
            return list(executor.map(process, batch))


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
    """

    def __init__(self, manager, images: list, emit: Emit | None = None) -> None:
        self.manager = manager
        self.images = images
        self.emit = emit  # told which pages are rebuilt, before their layout requests run
        self.full_page: dict[int, Kept] = {}
        self.fallback: dict[int, Kept] = {}
        self.subset: list[int | None] = []  # page index of each page in the current fallback batch
        self.unattributed: list[str] = []   # capped requests no page could be found for

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
                self.emit({"type": "log", "text": "Surya rejected the full-page output of page(s) "
                           f"{[index + 1 for index in self.subset if index is not None]}: rebuilding from layout and blocks"})
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
    """Whole scans rendered by Surya's own loader; the range is checked here because Surya only asserts."""
    with pdfium_lock:
        from surya.input.load import load_from_file
        document = pdfium.PdfDocument(str(pdf))
        try:
            count = len(document)
        finally:
            document.close()
        first, last = pages or (1, count)
        if not 1 <= first <= last <= count:
            raise ConversionError(f"page range {first}-{last} outside 1-{count}")
        images, _ = load_from_file(str(pdf), page_range=list(range(first - 1, last)), dpi=dpi)  # Surya counts from 0
        return images


def where(crops: list[Crop] | None, pages: tuple[int, int] | None, number: int) -> str:
    """Input ordinal `number` as the diagnostics name it: its source page and, with cuts, its region."""
    if crops is not None:
        page, region, _ = crops[number - 1]
        return f"page {number} (source page {page}, region {region.order})"
    return f"page {number} (source page {pages[0] + number - 1})" if pages else f"page {number}"


ADVICE = ("content is missing: raise the surya record's max_new_tokens and context for a page longer than its "
          "budget (the record's SURYA_MAX_TOKENS_LAYOUT and SURYA_MAX_TOKENS_BLOCK_CEILING for a rebuilt page); a "
          "looping page, a block capped at Surya's estimate or a failed layout needs a different crop (see the "
          "debug report)")


def _markdown(converter: DocumentConverter, html: str, name: str) -> tuple[str, str | None]:
    """One input's block HTML as Markdown through Docling's HTML backend, or "" and why Docling could not read it."""
    if not html.strip():
        return "", None
    source = DocumentStream(name=f"{name}.html", stream=BytesIO(f"<html><body>{html}</body></html>".encode()))
    result = converter.convert(source, raises_on_error=False)
    if result.status != ConversionStatus.SUCCESS:
        return "", "; ".join(error.error_message for error in result.errors) or result.status.value
    return result.document.export_to_markdown(), None


class SuryaOcr:
    """Transcriber over the surya-ocr client: full-page OCR per image, Markdown through Docling's HTML backend."""
    kind = "surya"
    knobs = frozenset({"stream"})  # live tokens per page; the image and token budgets are Surya's own

    def transcribe(self, execution: Execution, crops: list[Crop] | None, emit: Emit) -> Transcription:
        assert execution.model is not None and execution.url is not None  # resolve() gives a surya execution both
        record = MODELS[execution.model]
        assert record.max_new_tokens is not None  # the surya record carries its output budget
        configure(execution.url, record.max_new_tokens, record.params)
        from surya.inference import SuryaInferenceManager
        from surya.recognition import RecognitionPredictor

        if crops:
            images = [image for _, _, image in crops]
        else:
            images = whole_pages(execution.pdf, execution.pages, round(72 * record.scale))
        emit({"type": "phase", "name": "ocr", "total": len(images)})
        live = emit if execution.stream else None  # the stream knob: page events and tokens as they are generated
        try:
            manager = KeptOutputs(_InferenceManager(live), images, live)
            results = RecognitionPredictor(cast(SuryaInferenceManager, manager))(images)  # the manager's interface
        except RuntimeError as error:  # Surya's SpawnError: server unreachable or serving another model, and kin
            raise ConversionError(f"Surya failed; output not written: {error}") from error
        emit({"type": "phase", "name": "export", "total": None})
        # Docling's HTML backend takes everything before the first heading for a web page's furniture (navigation,
        # banners) and leaves it out of the Markdown. A catalogue page that continues a section starts with exactly
        # that: its page number and the entries before the next heading. Nothing Surya read is furniture.
        converter = DocumentConverter(format_options={
            # Pylance reads no defaults for the options docling declares through Field(); every field looks required.
            InputFormat.HTML: HTMLFormatOption(
                backend_options=HTMLBackendOptions(infer_furniture=False)),  # pyright: ignore[reportCallIssue]
        })
        first = execution.pages[0] if execution.pages else 1
        kept = [manager.kept(index) for index in range(len(images))]
        pages = []
        for number, (image, page, output) in enumerate(zip(images, results, kept), 1):
            blocks = page.blocks
            html = "\n".join(block.html for block in blocks if not block.skipped)
            markdown, unreadable = _markdown(converter, html, f"{execution.pdf.stem}-{number}")
            reasons = []
            if output and output.capped:
                reasons.append(f"{where(crops, execution.pages, number)} stopped at its {output.capped}")
            if number - 1 in manager.fallback and not blocks:
                # A rebuilt page with no block at all lost its content: its layout request failed or answered nonsense.
                reasons.append(f"{where(crops, execution.pages, number)} came back empty after Surya rejected its "
                               "full-page output and its layout request failed")
            if unreadable:
                reasons.append(f"{where(crops, execution.pages, number)}: Docling could not read Surya's HTML: "
                               f"{unreadable}")
            errors = sum(block.error for block in blocks)
            if errors:
                reasons.append(f"{where(crops, execution.pages, number)}: {errors} block{'s' if errors > 1 else ''} "
                               "came back in error")
            tokens = output.tokens if output else None
            input_tokens = output.input_tokens if output else None
            capped = bool(output and output.capped)
            pages.append(PageRecord(
                page=number, region=region_info(crops[number - 1]) if crops else None, image=image,
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
        if unattributed or any(record.incomplete for record in pages):
            unattributed.append(ADVICE)
        return Transcription(header, pages, "; ".join(unattributed) or None)

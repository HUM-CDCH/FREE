"""Docling's VLM path: from a model record to a finished Docling run and its outcome, chosen in one place."""
import re
from dataclasses import dataclass

from docling.datamodel.base_models import ConversionStatus, InputFormat, Page
from docling.datamodel.document import ConversionResult
from docling.datamodel.pipeline_options import VlmConvertOptions, VlmPipelineOptions
from docling.datamodel.pipeline_options_vlm_model import ResponseFormat
from docling.datamodel.settings import DEFAULT_PAGE_RANGE
from docling.datamodel.vlm_engine_options import ApiVlmEngineOptions
from docling.document_converter import (
    DocumentConverter,
    ImageFormatOption,
    PdfFormatOption,
)
from docling.models.inference_engines.vlm import VlmEngineType
from docling.models.inference_engines.vlm.base import BaseVlmEngine
from docling.models.stages.vlm_convert.vlm_convert_model import VlmConvertModel
from docling.pipeline.vlm_pipeline import VlmPipeline
from pydantic import AnyUrl

from kei_exp.cut import png_stream
from kei_exp.models import MODELS, Model
from kei_exp.progress import Emit
from kei_exp.regions import Crop, region_info
from kei_exp.transcription.streaming import StreamingVlmEngine
from kei_exp.transcription.types import TRANSCRIBER_KNOBS, Execution, PageRecord, Transcription

WHOLE_PAGE_MAX_SIZE = 1200  # longest edge of a whole-page render unless --max-image-size says otherwise
FENCE = re.compile(r"\A```(?:markdown|md)\r?\n(.*)\r?\n```\Z", re.DOTALL)


def vlm_options(record: Model, url: str, max_image_size: int,
                max_output_tokens: int | None = None) -> VlmConvertOptions:
    """Docling's VLM stage options for a record: its spec's prompt and format, vLLM generation params, the caps."""
    assert record.spec is not None  # Model refuses a vlm record without one
    engine = ApiVlmEngineOptions(engine_type=VlmEngineType.API, url=AnyUrl(url),
                                 params={"model": record.repo, **record.params}, timeout=600)
    # Three records share Docling's preset specs and the record keeps its own across calls; copy before editing.
    options = VlmConvertOptions(model_spec=record.spec.model_copy(), engine_options=engine)
    if record.max_new_tokens is not None:
        options.model_spec.max_new_tokens = record.max_new_tokens
    if max_output_tokens is not None:
        options.model_spec.max_new_tokens = max_output_tokens
    options.max_size = max_image_size
    return options


def engine_options(options: VlmConvertOptions) -> ApiVlmEngineOptions:
    engine = options.engine_options
    assert isinstance(engine, ApiVlmEngineOptions)  # vlm_options only builds API engines
    return engine


def pipeline_class(engine: BaseVlmEngine | None) -> type[VlmPipeline]:
    """A VlmPipeline for one run. Docling builds pipelines from their options alone, so the engine is bound here."""

    class Pipeline(VlmPipeline):
        def __init__(self, pipeline_options: VlmPipelineOptions):
            super().__init__(pipeline_options)
            if engine is not None:
                stage = self.build_pipe[0]
                assert isinstance(stage, VlmConvertModel)
                stage.engine = engine

        def _initialize_page(self, conv_res: ConversionResult, page: Page) -> Page:
            page = super()._initialize_page(conv_res, page)
            options = self.pipeline_options.vlm_options
            if page.size is not None and options.max_size is not None:
                # Keep page.image at the inference render, cap included: Docling reads it for DocTags geometry
                # and the report saves it, and this avoids a second, uncapped render.
                page._default_image_scale = min(options.scale, options.max_size / max(page.size.as_tuple()))
            return page

    return Pipeline


@dataclass(frozen=True)
class Assembly:
    """One run's Docling converter and what was chosen for it."""
    options: VlmConvertOptions            # prompt, response format, allowance, render scale, image cap
    pipeline_options: VlmPipelineOptions
    converter: DocumentConverter
    input_format: InputFormat             # IMAGE for crops, PDF for whole pages

    @property
    def pipeline(self) -> VlmPipeline:
        """The pipeline Docling builds for this run; checks read its engine and its page-image override."""
        self.converter.initialize_pipeline(self.input_format)  # returns nothing; fills the converter's cache
        pipeline = next(iter(self.converter.initialized_pipelines.values()))  # one format, one pipeline
        assert isinstance(pipeline, VlmPipeline)
        return pipeline


def assemble(record: Model, *, url: str, crops: list[Crop] | None, max_image_size: int | None,
             max_output_tokens: int | None, stream: bool, keep_images: bool, emit: Emit) -> Assembly:
    """Docling's converter for one run. The render rule, stated once: crops go at their rendered size (tagged 72 dpi,
    1 px = 1 pt, scale 1.0) under a cap that defaults to the largest crop; whole pages at the spec's scale under a
    cap that defaults to WHOLE_PAGE_MAX_SIZE."""
    cap = max_image_size or (max(max(image.size) for _, _, image in crops) if crops else WHOLE_PAGE_MAX_SIZE)
    options = vlm_options(record, url, cap, max_output_tokens)
    if crops:
        options.scale = 1.0
    pipeline_options = VlmPipelineOptions(
        vlm_options=options, enable_remote_services=True, generate_page_images=keep_images,
        images_scale=options.scale,
    )
    engine = None
    if stream:
        engine = StreamingVlmEngine(enable_remote_services=True, options=engine_options(options), emit=emit)
    pipeline = pipeline_class(engine)
    if crops:
        input_format = InputFormat.IMAGE
        option = ImageFormatOption(pipeline_cls=pipeline, pipeline_options=pipeline_options)
    else:
        input_format = InputFormat.PDF
        option = PdfFormatOption(pipeline_cls=pipeline, pipeline_options=pipeline_options)
    return Assembly(options, pipeline_options, DocumentConverter(format_options={input_format: option}), input_format)


def page_records(results: list[ConversionResult], crops: list[Crop] | None,
                 options: VlmConvertOptions) -> list[PageRecord]:
    """One record per Docling page, numbered across results (with cuts, every result is one region).

    A Markdown model's text is its Markdown, with an outer fence removed (Docling's Markdown parser would renumber
    lists, so the text is kept as generated); a DocTags document is exported per page.
    """
    markdown_format = options.model_spec.response_format == ResponseFormat.MARKDOWN
    records: list[PageRecord] = []
    for index, result in enumerate(results):
        for page in result.pages:
            document_page = result.document.pages.get(page.page_no)
            image = document_page.image.pil_image if document_page and document_page.image else None
            prediction = page.predictions.vlm_response
            usage = (prediction.usage or {}) if prediction is not None else {}
            stop = prediction.stop_reason.value if prediction is not None else None
            if markdown_format:
                markdown = FENCE.sub(r"\1", prediction.text.strip()) if prediction is not None else ""
                text = markdown  # ponytail: the Markdown is the text until a reader needs the markers off
            else:
                markdown = result.document.export_to_markdown(page_no=page.page_no)
                text = result.document.export_to_text(page_no=page.page_no)
            errors = [error.error_message for error in result.errors if error.page_no == page.page_no]
            if not errors and stop == "length":
                errors = ["VLM output incomplete (stop_reason=length)."]
            ordinal = len(records) + 1
            records.append(PageRecord(
                page=ordinal, region=region_info(crops[index]) if crops else None,
                # Docling's API path sends the image RGB-normalised and RGBA-encoded; the saved PNG reproduces that.
                image=image.convert("RGB").convert("RGBA") if image is not None else None,
                seconds=prediction.generation_time if prediction is not None and prediction.generation_time >= 0 else None,
                input_tokens=usage.get("prompt_tokens"), output_tokens=usage.get("completion_tokens"),
                stop=stop, capped=stop == "length",
                payload={"prediction": prediction.model_dump(mode="json") if prediction is not None else None},
                stats={"input_tokens": usage.get("prompt_tokens", "unavailable"),
                       "output_tokens": usage.get("completion_tokens", "unavailable"),
                       "stop": stop} if prediction is not None else {},
                markdown=markdown, text=text, incomplete=f"page {ordinal}: " + "; ".join(errors) if errors else None,
                source_page=None if crops else page.page_no,
            ))
    return records


def transcription_of(options: VlmConvertOptions, results: list[ConversionResult],
                     crops: list[Crop] | None) -> Transcription:
    """The outcome of a Docling run: every page's errors on its record, the rest on the run."""
    errors = [error for result in results for error in result.errors]
    status = next((result.status.value for result in results if result.status != ConversionStatus.SUCCESS), "success")
    header = {
        "prompt": options.model_spec.prompt, "scale": options.scale, "max_size": options.max_size,
        "max_output_tokens": options.model_spec.max_new_tokens, "generation_params": engine_options(options).params,
        "errors": [error.model_dump(mode="json") for error in errors], "docling_status": status,
    }
    pages = page_records(results, crops, options)
    stray = "; ".join(error.error_message for error in errors if not error.page_no)
    unattributed = None
    if status != "success":
        attributed = any(record.incomplete for record in pages)
        unattributed = f"{status}: {stray}" if stray else (None if attributed else status)
    return Transcription(header, pages, unattributed)


class DoclingVlm:
    """Transcriber over Docling's VLM pipeline and the OpenAI-compatible vLLM server at execution.url."""
    kind = "vlm"
    knobs = TRANSCRIBER_KNOBS[kind]

    def transcribe(self, execution: Execution, crops: list[Crop] | None, emit: Emit) -> Transcription:
        assert execution.model is not None and execution.url is not None  # resolve() gives a vlm execution both
        record = MODELS[execution.model]
        assembly = assemble(record, url=execution.url, crops=crops, max_image_size=execution.max_image_size,
                            max_output_tokens=execution.max_output_tokens, stream=execution.stream,
                            keep_images=execution.debug_dir is not None, emit=emit)
        if crops:
            emit({"type": "phase", "name": "vlm", "total": len(crops)})
            streams = [png_stream(f"{execution.pdf.stem}-p{page}-r{region.order}.png", image)
                       for page, region, image in crops]
            results = list(assembly.converter.convert_all(streams, raises_on_error=False))
        else:
            pages = execution.pages
            emit({"type": "phase", "name": "vlm", "total": pages[1] - pages[0] + 1 if pages else None})
            results = [assembly.converter.convert(execution.pdf, raises_on_error=False,
                                                  page_range=pages or DEFAULT_PAGE_RANGE)]
        emit({"type": "phase", "name": "export", "total": None})
        return transcription_of(assembly.options, results, crops)

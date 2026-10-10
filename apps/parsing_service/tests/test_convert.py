"""convert() and main() over a fake transcriber: the outcome accepted or refused, the report and the accepted result
files, the cut's crops and layout choice handed through, the knobs resolve() refuses and the CLI's own validation;
then the VLM assembly and its adapter without a server. No GPU, no model server: the transcriber is the fake of
tests/helpers/fake.py, registered under the model key `fake` for the duration of a test."""
import json
from collections.abc import Iterator
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from typing import Any, NamedTuple, cast
from unittest.mock import patch

import pypdfium2 as pdfium
import pytest
from docling.datamodel.base_models import (
    ConversionStatus,
    DoclingComponentType,
    ErrorItem,
    FailureCategory,
    InputFormat,
    Page,
    VlmPrediction,
    VlmStopReason,
)
from docling.datamodel.document import ConversionResult
from docling.models.inference_engines.vlm.api_openai_compatible_engine import (
    ApiVlmEngine,
)
from docling.models.stages.vlm_convert.vlm_convert_model import VlmConvertModel
from docling.pipeline.vlm_pipeline import VlmPipeline
from docling_core.types.doc import Size  # pyright: ignore[reportPrivateImportUsage]
from PIL import Image

from kei_exp.convert import main
from kei_exp.cut import CutError
from kei_exp.geometry import CropTransform
from kei_exp.kie.runner import convert
from kei_exp.kie.stages import ocr
from kei_exp.kie.stages.ocr import TRANSCRIBERS, resolve
from kei_exp.models import MODELS
from kei_exp.pagefile import load_result, read_manifest
from kei_exp.progress import print_event
from kei_exp.regions import LAYOUT_MODELS, Region
from kei_exp.transcription.specs import VLM_SPECS
from kei_exp.transcription.streaming import StreamingVlmEngine
from kei_exp.transcription.types import (
    DEFAULT_URL,
    TRANSCRIBER_KNOBS,
    ConversionError,
    Execution,
    IncompleteConversionError,
    PageRecord,
    RunParams,
)
from kei_exp.transcription.vlm import (
    Assembly,
    assemble,
    engine_options,
    page_records,
    transcription_of,
    vlm_options,
)
from tests.helpers.fake import FakeTranscriber, registered
from tests.helpers.synthetic import crop

OUTPUT = Path("scratch/fake/input.md")  # where main() writes the fake model's Markdown, under the working directory
PAGE_RECORD = PageRecord(page=1, region=None, image=Image.new("RGBA", (8, 8), "blue"), seconds=0.5, input_tokens=10,
                         output_tokens=20, stop="length", capped=True, payload={"prediction": {"text": "partial"}},
                         stats={"input_tokens": 10, "output_tokens": 20, "stop": "length"}, markdown="partial",
                         text="partial", incomplete="page 1: VLM output incomplete (stop_reason=length).",
                         source_page=1)
CROPS = [(1, Region("column", (0, 0, 10, 10), 0, 1.0), Image.new("L", (10, 10)))]


@pytest.fixture
def workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """The working directory of a run: a one-page input.pdf and the Markdown a previous run left at OUTPUT."""
    monkeypatch.chdir(tmp_path)
    with pdfium.PdfDocument.new() as blank:  # one page: the converter counts it, the fake never renders it
        blank.new_page(100, 100)
        blank.save("input.pdf")
    OUTPUT.parent.mkdir(parents=True)
    OUTPUT.write_text("existing output", encoding="utf-8")
    return tmp_path


@pytest.fixture
def fake() -> Iterator[FakeTranscriber]:
    """The fake transcriber, registered as the `fake` model's for one test."""
    with registered(FakeTranscriber()) as fake:
        yield fake


@pytest.fixture
def scanned() -> Iterator[None]:
    """input.pdf read as a scan: no embedded text, so resolve() picks the record's transcriber, not native text."""
    with patch("kei_exp.kie.stages.ocr.native_regions", return_value=None):
        yield


@pytest.fixture
def opened_pdf() -> Iterator[Any]:
    """What the cut's `with PdfPages(pdf) as pages` yields, patched away: the cut beside it is patched per test."""
    with patch("kei_exp.kie.stages.ocr.PdfPages") as source:
        source.return_value.__enter__.return_value.count = 1
        yield source.return_value.__enter__.return_value


def run(*flags: str) -> int:
    """main() with --cut none against the fake record; returns the exit code (0 when main returned)."""
    with (patch("sys.argv", ["kei-exp", "input.pdf", "--model", "fake", "--cut", "none", *flags]),
          patch("kei_exp.kie.stages.ocr.native_regions", return_value=None)):
        try:
            main()
        except SystemExit as error:
            return cast(int, error.code)
    return 0


# --- convert() accepts or refuses the outcome; existing Markdown survives a refusal ------------------------------
@pytest.mark.parametrize("records, markdown, incomplete", [
    pytest.param([PAGE_RECORD], "complete output", None, id="a capped record"),
    pytest.param(None, "   \n", None, id="a blank transcription"),
    # A record-level reason alone refuses the run, with no output directory of any kind.
    pytest.param(None, "complete output", "page 1: the fake lost a line", id="a record-level reason alone"),
])
def test_a_refused_outcome_leaves_the_existing_markdown_in_place(workspace, fake, records, markdown, incomplete):
    # convert() accepts or refuses the outcome; existing Markdown survives a refusal.
    fake.records, fake.markdown, fake.incomplete = records, markdown, incomplete
    assert run() == 1 and OUTPUT.read_text(encoding="utf-8") == "existing output"


def test_an_accepted_outcome_replaces_the_existing_markdown(workspace, fake):
    assert run() == 0 and OUTPUT.read_text(encoding="utf-8") == "complete output"


def test_the_result_dir_reaches_the_execution_and_gets_the_version_4_files(workspace, fake):
    assert run("--result-dir", "result") == 0 and fake.calls[-1][0].result_dir == Path("result")
    manifest = json.loads(Path("result/result.json").read_text(encoding="utf-8"))
    assert manifest["status"] == "success" and list(manifest["pages"]) == ["1"]  # version 4: pages by number
    assert json.loads(Path("result/pages/1.json").read_text(encoding="utf-8"))["markdown"] == "complete output"
    assert manifest["source_name"] == "input.pdf"  # the path's name, without a name of its own


def test_a_whole_page_token_event_names_its_page_and_no_crop(workspace, fake, scanned):
    seen = []
    convert(resolve(RunParams(pdf=Path("input.pdf"), model="fake", cut="none", pages=(1, 1))), emit=seen.append)
    token = next(event for event in seen if event["type"] == "token")
    assert (token["page"], token["unit"], token["crop"]) == (1, 0, None), token  # a whole-page input has no crop


@pytest.mark.parametrize("records", [
    pytest.param([], id="no record"),
    pytest.param([PAGE_RECORD, PAGE_RECORD], id="two records for one input"),
    pytest.param([replace(PAGE_RECORD, page=2)], id="a record numbered past the inputs"),
    pytest.param([replace(PAGE_RECORD, source_page=2)], id="a whole-page record naming another page"),
])
def test_records_that_are_not_the_inputs_are_an_adapter_bug(workspace, fake, records):
    # The records must be the inputs, one each, a whole-page record naming its page: anything else is an adapter bug.
    fake.records = records
    with pytest.raises(AssertionError):
        run()


def test_the_execution_names_the_record_and_a_whole_pdf_run_hands_over_no_crops(workspace, fake):
    assert run() == 0
    execution, crops = fake.calls[-1]
    assert execution.transcriber == "fake" and execution.model == "fake" and execution.repo == "fake/model"
    assert execution.cut == "none" and crops is None and execution.pages is None
    assert run("--pages", "1-1") == 0 and fake.calls[-1][0].pages == (1, 1)


# --- The cut: its layout choice and its crops go through; a failing or empty cut is a refused run ------------------
@pytest.mark.parametrize("layout_model", list(LAYOUT_MODELS))
def test_the_cut_gets_the_layout_choice_and_its_crops_reach_the_transcriber(workspace, fake, scanned, opened_pdf,
                                                                            layout_model):
    # Conversion passes the run's layout choice and the resulting crops to the existing OCR path.
    params = RunParams(pdf=Path("input.pdf"), model="fake", pages=(1, 1), layout_model=layout_model)
    with patch("kei_exp.kie.stages.ocr.cut_pages", return_value=CROPS) as cutter:
        events = []
        assert convert(resolve(params), emit=events.append) == "complete output"
        cutter.assert_called_once_with(opened_pdf, [1], 250, layout_model=layout_model)
    assert fake.calls[-1][1] == CROPS
    # The cut phase counts pages, and a region says which crop it is, nothing about how many will follow.
    assert {"type": "phase", "name": "cut", "total": 1} in events, events
    region = next(event for event in events if event["type"] == "region")
    assert region["crop"] == 1 and region["unit"] == 0 and region["page"] == 1 and "index" not in region, region
    # A page-bearing event leaves the converter placed: the adapter's input ordinal became the PDF page,
    # the unit and the crop.
    token = next(event for event in events if event["type"] == "token")
    assert (token["page"], token["unit"], token["crop"], token["text"]) == (1, 0, 1, "x"), token


def test_a_cut_failing_after_the_first_crop_is_a_refused_conversion(workspace, fake, scanned, opened_pdf):
    # Crops are consumed as they are cut: a failure after the first one is still a refused conversion.
    def failing_cut(*args, **kwargs):
        yield CROPS[0]
        raise CutError("forced after the first crop")

    seen = []
    with (patch("kei_exp.kie.stages.ocr.cut_pages", side_effect=failing_cut),
          pytest.raises(ConversionError, match="forced after the first crop")):
        convert(resolve(RunParams(pdf=Path("input.pdf"), model="fake", pages=(1, 1))), emit=seen.append)
    assert any(event["type"] == "region" for event in seen), seen  # the first crop was announced before the failure


def test_an_empty_cut_never_reaches_the_transcriber_and_its_report_records_the_reason(workspace, fake, scanned,
                                                                                      opened_pdf):
    # A cut that finds nothing never reaches the transcriber (an empty list would read as the whole PDF): the
    # run is refused after its report, which records the reason.
    with (patch("kei_exp.kie.stages.ocr.cut_pages", return_value=iter([])),
          pytest.raises(ConversionError, match="found no content")):
        convert(resolve(RunParams(pdf=Path("input.pdf"), model="fake", debug_dir=Path("debug-empty"))))
    assert fake.calls == []
    report = json.loads(Path("debug-empty/report.json").read_text(encoding="utf-8"))
    assert report["status"] == "incomplete" and report["pages"] == [] and "found no content" in report["incomplete"]



# --- The worker's hooks: an adopted result is returned with no cut and no transcription; else before_ocr goes first --
PAGE_CROP = [crop(1, "page", (0.0, 0.0, 100.0, 100.0), 0, CropTransform(0.0, 0.0, 1.0, 1.0, None), (100, 100))]


def test_an_adopted_result_skips_the_cut_the_transcriber_and_before_ocr(workspace, fake, scanned):
    execution = resolve(RunParams(pdf=Path("input.pdf"), model="fake", result_dir=Path("result")))
    with patch("kei_exp.kie.stages.ocr.cut_pages", return_value=PAGE_CROP):
        first = ocr.run(execution, lambda event: None)
    asked, before, events = [], [], []
    with patch("kei_exp.kie.stages.ocr.cut_pages", side_effect=AssertionError("cut")) as cutter:
        markdown = ocr.run(execution, events.append,
                           adopt=lambda fingerprint, pages: asked.append((fingerprint, pages)) or load_result(
                               Path("result")), before_ocr=lambda: before.append("called"))
    manifest = read_manifest(Path("result"))
    assert markdown == first == "complete output" and asked == [(manifest.fingerprint, sorted(manifest.pages))]
    assert not cutter.called and len(fake.calls) == 1 and before == []
    assert [event["type"] for event in events] == ["log"]


def test_on_a_miss_before_ocr_runs_once_before_the_cut_and_the_transcriber(workspace, fake, scanned):
    order = []
    execution = resolve(RunParams(pdf=Path("input.pdf"), model="fake", result_dir=Path("result")))
    def cut(*args, **kwargs):
        order.append("cut")
        return PAGE_CROP
    with patch("kei_exp.kie.stages.ocr.cut_pages", side_effect=cut):
        ocr.run(execution, lambda event: None, adopt=lambda fingerprint, pages: None,
                before_ocr=lambda: order.append(f"before, {len(fake.calls)} transcribed"))
    assert order == ["before, 0 transcribed", "cut"] and len(fake.calls) == 1

# --- The debug report is written before the outcome is judged --------------------------------------------------------
def test_the_report_survives_an_incomplete_run(workspace, fake):
    # The report is written before the outcome is judged, so it survives an incomplete run.
    fake.records = [PAGE_RECORD]
    assert run("--debug-dir", "debug") == 1
    report = json.loads(Path("debug/report.json").read_text(encoding="utf-8"))
    assert report["status"] == "incomplete" and report["incomplete"].startswith("page 1") and report["seconds"] >= 0
    assert report["pages"][0]["capped"] is True and Path("debug/page-1.png").exists()
    assert report["pages"][0]["incomplete"].startswith("page 1") and report["pages"][0]["markdown"] == "partial"
    assert report["pages"][0]["text"] == "partial" and report["pages"][0]["source_page"] == 1


def test_a_blank_transcriptions_report_says_so_instead_of_claiming_success(workspace, fake):
    # A blank transcription is refused too, and its report says so instead of claiming success.
    fake.markdown = "   \n"
    assert run("--debug-dir", "debug-blank") == 1
    report = json.loads(Path("debug-blank/report.json").read_text(encoding="utf-8"))
    assert report["status"] == "incomplete" and "no text" in report["incomplete"], report["incomplete"]


# --- The debug report is diagnostic only: its own failure cannot fail or mask an otherwise-judged run --------------
def test_a_failed_debug_report_does_not_fail_an_accepted_run(workspace, fake, scanned):
    # A failure writing the debug report/images (an unwritable or deleted debug directory) must not fail an
    # otherwise accepted parse: the canonical result is already written and remains the run's output of record.
    execution = resolve(RunParams(pdf=Path("input.pdf"), model="fake", cut="none",
                                  debug_dir=Path("debug"), result_dir=Path("result")))
    events = []
    with patch.object(ocr, "write_report", side_effect=OSError("debug directory is gone")):
        markdown = convert(execution, emit=events.append)
    assert markdown == "complete output"
    manifest = json.loads(Path("result/result.json").read_text(encoding="utf-8"))
    assert manifest["status"] == "success" and list(manifest["pages"]) == ["1"]
    assert json.loads(Path("result/pages/1.json").read_text(encoding="utf-8"))["markdown"] == "complete output"
    assert {"type": "log", "text": "Debug report not written: debug directory is gone"} in events, events


def test_a_failed_debug_report_does_not_mask_an_incomplete_run(workspace, fake, scanned):
    # An incomplete recognition still raises exactly as before, even when the debug write that follows it also
    # fails: the debug failure is logged and swallowed, never the run's own refusal.
    fake.records = [PAGE_RECORD]
    execution = resolve(RunParams(pdf=Path("input.pdf"), model="fake", cut="none", debug_dir=Path("debug")))
    events = []
    with (patch.object(ocr, "write_report", side_effect=OSError("debug directory is gone")),
          pytest.raises(IncompleteConversionError, match="page 1")):
        convert(execution, emit=events.append)
    assert {"type": "log", "text": "Debug report not written: debug directory is gone"} in events, events


# --- Knobs: refused before anything runs when the transcriber does not honour them, passed through otherwise -------
@pytest.mark.parametrize("flag", ["--max-output-tokens", "--max-image-size"])
def test_a_knob_the_transcriber_does_not_accept_is_refused_before_anything_runs(workspace, fake, flag):
    # Knobs the transcriber does not accept are refused before anything runs (exit 2), accepted ones pass through.
    assert run(flag, "5") == 2 and fake.calls == []


def test_an_accepted_knob_passes_through_to_the_execution(workspace, fake):
    assert run("--stream") == 0 and fake.calls[-1][0].stream is True


@pytest.mark.parametrize("params, refused", [
    pytest.param(RunParams(pdf=Path("input.pdf"), model="surya", stream=True, max_image_size=800), "max_image_size",
                 id="surya refuses max_image_size"),
    pytest.param(RunParams(pdf=Path("input.pdf"), model="fake", max_output_tokens=5), "max_output_tokens",
                 id="the fake refuses max_output_tokens"),
])
def test_resolve_refuses_the_knobs_a_transcriber_does_not_honour_naming_them(fake, scanned, params, refused):
    # resolve() refuses the knobs a transcriber does not honour, naming them, before anything runs.
    with pytest.raises(ValueError, match=refused):
        resolve(params)


def test_resolve_names_the_records_transcriber(scanned):
    assert resolve(RunParams(pdf=Path("input.pdf"), model="surya")).transcriber == "surya"
    assert resolve(RunParams(pdf=Path("input.pdf"), model="granite_vision", stream=True, max_output_tokens=1,
                             max_image_size=1)).transcriber == "vlm"


def test_the_execution_carries_the_requests_effective_settings(fake, scanned):
    # The execution carries the request's effective settings: the record's repo, the layout model only with a cut.
    execution = resolve(RunParams(pdf=Path("input.pdf"), model="fake", cut="none", crop_dpi=300,
                                  layout_model="layout_egret_xlarge", stream=True, pages=(2, 3)))
    assert execution == Execution(pdf=Path("input.pdf"), transcriber="fake", model="fake", repo="fake/model",
                                  url=DEFAULT_URL, cut="none", layout_model=None, crop_dpi=300,
                                  max_image_size=None, max_output_tokens=None, stream=True, pages=(2, 3),
                                  debug_dir=None, result_dir=None, page_source="pdf", ingest_dir=None)
    assert resolve(RunParams(pdf=Path("input.pdf"), model="fake",
                             layout_model="layout_egret_xlarge")).layout_model == "layout_egret_xlarge"


def test_native_text_is_an_execution_of_its_own():
    # Native text is an execution of its own: no model, server, cut or knobs, whatever the request asked for.
    with patch("kei_exp.kie.stages.ocr.native_regions", return_value=()), \
            patch("kei_exp.kie.stages.ocr.undecodable_glyphs", return_value=False):
        execution = resolve(RunParams(pdf=Path("input.pdf"), model="fake", stream=True, max_image_size=1,
                                      crop_dpi=300, pages=(1, 1), debug_dir=Path("debug")))
    assert execution == Execution(pdf=Path("input.pdf"), transcriber="native", model=None, repo=None, url=None,
                                  cut="none", layout_model=None, crop_dpi=None, max_image_size=None,
                                  max_output_tokens=None, stream=False, pages=(1, 1), debug_dir=Path("debug"),
                                  result_dir=None, page_source="pdf", ingest_dir=None)
    assert TRANSCRIBERS["native"].kind == "native" and TRANSCRIBERS["native"].knobs == frozenset()


def test_every_registered_transcriber_honours_its_row_of_the_knob_table():
    assert {kind: transcriber.knobs for kind, transcriber in TRANSCRIBERS.items()} == TRANSCRIBER_KNOBS
    assert TRANSCRIBER_KNOBS == {"vlm": frozenset({"stream", "max_output_tokens", "max_image_size"}),
                                 "surya": frozenset({"stream"}), "native": frozenset()}


# --- CLI parameter validation stays in main() -------------------------------------------------------------------------
@pytest.mark.parametrize("pages", ["0-1", "2-1", "x"])
def test_the_cli_refuses_a_page_range_that_is_not_one(workspace, fake, pages):
    # CLI parameter validation stays in main().
    assert run("--pages", pages) == 2


@pytest.mark.parametrize("size", ["0", "-1"])
def test_the_cli_refuses_an_image_size_that_is_not_positive(workspace, fake, size):
    assert run("--max-image-size", size) == 2


# --- The VLM assembly chooses everything between a record and a Docling run, and says what it chose -----------------
URL = "http://127.0.0.1:9/v1/chat/completions"
COLUMN_CROPS = [(1, Region("column", (0.0, 0.0, 10.0, 10.0), 0, 0.5), Image.new("L", (860, 2400))),
                (1, Region("column", (10.0, 0.0, 20.0, 10.0), 1, 0.5), Image.new("L", (850, 2380)))]


class Assembled(NamedTuple):
    whole: Assembly      # whole pages, nothing streamed or kept
    cut: Assembly        # the two column crops, streamed, images kept, at a 128-token allowance
    capped: Assembly     # the crops under an explicit 800 px cap
    allowance: int       # the record's spec allowance before anything was assembled


def stage_engine(pipeline: VlmPipeline):
    """The engine of the pipeline's VLM stage, its only stage."""
    stage = pipeline.build_pipe[0]
    assert isinstance(stage, VlmConvertModel)
    return stage.engine


@pytest.fixture
def assembled() -> Assembled:
    """The granite_vision record assembled three ways.

    A fixture so the real pipelines it builds are released before interpreter shutdown, when Docling's
    engine finalizer would find the logging globals already gone.
    """
    record = MODELS["granite_vision"]
    assert record.spec_key is not None  # Model refuses a vlm record without one
    allowance = VLM_SPECS[record.spec_key].max_new_tokens
    whole = assemble(record, url=URL, crops=None, max_image_size=None, max_output_tokens=None,
                     stream=False, keep_images=False, emit=print_event)
    cut = assemble(record, url=URL, crops=COLUMN_CROPS, max_image_size=None, max_output_tokens=128,
                   stream=True, keep_images=True, emit=print_event)
    capped = assemble(record, url=URL, crops=COLUMN_CROPS, max_image_size=800, max_output_tokens=None, stream=False,
                      keep_images=False, emit=print_event)
    return Assembled(whole, cut, capped, allowance)


def test_whole_pages_go_as_pdf_at_the_specs_scale_under_the_default_cap_through_a_plain_engine(assembled):
    whole = assembled.whole
    assert whole.input_format == InputFormat.PDF and whole.options.scale == 2.0 and whole.options.max_size == 1200
    params = engine_options(whole.options).params
    # streaming is an engine, not a request flag
    assert params["model"] == MODELS["granite_vision"].repo and "stream" not in params
    engine = stage_engine(whole.pipeline)
    assert isinstance(engine, ApiVlmEngine) and not isinstance(engine, StreamingVlmEngine)
    assert not whole.pipeline_options.generate_page_images


def test_crops_go_as_images_at_their_size_with_the_runs_allowance_through_the_streaming_engine(assembled):
    cut, record = assembled.cut, MODELS["granite_vision"]
    assert record.spec_key is not None  # Model refuses a vlm record without one
    assert cut.input_format == InputFormat.IMAGE and cut.options.scale == 1.0 and cut.options.max_size == 2400
    assert cut.options.model_spec.max_new_tokens == 128
    assert VLM_SPECS[record.spec_key].max_new_tokens == assembled.allowance  # spec stays pristine
    engine = stage_engine(cut.pipeline)
    assert isinstance(engine, StreamingVlmEngine) and engine.emit is print_event
    assert cut.pipeline_options.generate_page_images and cut.pipeline_options.images_scale == 1.0


def test_an_explicit_image_cap_replaces_the_largest_crop(assembled):
    assert assembled.capped.options.max_size == 800


@pytest.mark.parametrize("width, height", [(1191, 842), (842, 1191), (300, 200)],
                         ids=["landscape past the cap", "portrait past the cap", "under the cap"])
def test_the_page_image_override_keeps_page_image_at_the_inference_render(assembled, width, height):
    # The page-image override keeps page.image at the inference render, cap included.
    whole = assembled.whole
    pipeline = whole.pipeline
    with patch.object(VlmPipeline, "_initialize_page", side_effect=lambda result, page: page):
        page = Page(page_no=1, size=Size(width=width, height=height))
        page._backend = cast(Any, SimpleNamespace(
            get_page_image=lambda scale: Image.new("RGB", (int(width * scale), int(height * scale)))))
        pipeline._initialize_page(cast(Any, SimpleNamespace()), page)
        inference_image = page.get_image(scale=whole.options.scale, max_size=whole.options.max_size)
        assert inference_image is not None
        assert page.image is inference_image and max(inference_image.size) <= 1200
        assert abs(inference_image.width / inference_image.height - width / height) < 0.01


# --- The VLM adapter turns Docling results into records, Markdown and an outcome -------------------------------------
LENGTH_ERROR = ErrorItem(component_type=DoclingComponentType.PIPELINE, module_name="Pipeline",
                         error_message="VLM output incomplete (stop_reason=length).",
                         category=FailureCategory.INFERENCE_FAILURE, page_no=1)
STRAY_ERROR = ErrorItem(component_type=DoclingComponentType.PIPELINE, module_name="Pipeline",
                        error_message="backend down", category=FailureCategory.INFERENCE_FAILURE, page_no=None)
USAGE = {"prompt_tokens": 1156, "completion_tokens": 8192}
MARKDOWN_OPTIONS = vlm_options(MODELS["infinity_parser"], URL, 1200)


def docling_result(*, status: ConversionStatus = ConversionStatus.PARTIAL_SUCCESS,
                   errors: tuple[ErrorItem, ...] = (LENGTH_ERROR,), stop_reason: VlmStopReason = VlmStopReason.LENGTH,
                   usage: dict | None = USAGE) -> ConversionResult:
    """A stand-in with the fields the adapter reads: one page whose prediction is a fenced Markdown page, and a
    document that exports per page; by default Docling's partial success over a page that stopped at its cap."""
    prediction = VlmPrediction(text="```markdown\n# T\n\n76. First\n```", stop_reason=stop_reason,
                               generation_time=1.5, usage=usage)
    page = Page(page_no=1)
    page.predictions.vlm_response = prediction
    document_page = SimpleNamespace(image=SimpleNamespace(pil_image=Image.new("RGB", (24, 32), "red")))
    return cast(ConversionResult, SimpleNamespace(
        status=status, errors=list(errors), pages=[page],
        document=SimpleNamespace(pages={1: document_page},
                                 export_to_markdown=lambda page_no=None: f"exported {page_no}",
                                 export_to_text=lambda page_no=None: f"text {page_no}"),
    ))


def test_page_records_number_crops_across_results_and_carry_each_predictions_facts():
    result = docling_result()
    records = page_records([result, result], COLUMN_CROPS, MARKDOWN_OPTIONS)
    assert [r.page for r in records] == [1, 2]
    assert records[1].region is not None and records[1].region["order"] == 1  # numbered across results
    first = records[0]
    assert first.region is not None and first.region["ink"] == 0.5 and first.region["source_page"] == 1
    assert first.image is not None and first.image.mode == "RGBA" and first.image.getpixel((0, 0)) == (255, 0, 0, 255)
    assert first.seconds == 1.5
    assert first.input_tokens == 1156 and first.output_tokens == 8192 and first.stop == "length" and first.capped
    assert first.payload["prediction"]["usage"]["prompt_tokens"] == 1156
    assert first.stats == {"input_tokens": 1156, "output_tokens": 8192, "stop": "length"}
    # A Markdown model's record keeps its text as generated, fence stripped and numbering kept, and that is its text;
    # a crop record names no page, a whole-page record names the backend's.
    assert first.markdown == "# T\n\n76. First" and first.text == first.markdown and first.source_page is None
    assert first.incomplete == "page 1: VLM output incomplete (stop_reason=length)."


def test_a_whole_page_record_names_the_backends_page_and_reports_missing_usage_as_unavailable():
    (whole,) = page_records([docling_result(usage=None)], None, MARKDOWN_OPTIONS)
    assert whole.stats == {"input_tokens": "unavailable", "output_tokens": "unavailable", "stop": "length"}
    assert whole.input_tokens is None and whole.region is None and whole.source_page == 1


def test_a_doctags_document_is_exported_per_page():
    (doctags,) = page_records([docling_result()], None, vlm_options(MODELS["granite_docling"], URL, 1200))
    assert doctags.markdown == "exported 1" and doctags.text == "text 1"  # a DocTags document is exported per page


def test_transcription_of_puts_a_pages_error_on_its_record_and_the_backends_facts_in_the_header():
    outcome = transcription_of(MARKDOWN_OPTIONS, [docling_result()], None)
    assert outcome.pages[0].markdown == "# T\n\n76. First"
    assert outcome.incomplete == "page 1: VLM output incomplete (stop_reason=length)."
    assert outcome.header["docling_status"] == "partial_success" and outcome.header["errors"][0]["page_no"] == 1
    infinity_spec = VLM_SPECS["infinity_parser"]
    assert outcome.header["prompt"] == infinity_spec.prompt
    assert outcome.header["max_output_tokens"] == 16384


def test_a_status_no_page_carries_is_the_runs_own_reason():
    # A status no page carries is the run's own reason; a failed status with every error on a page adds nothing.
    stray = docling_result(errors=(STRAY_ERROR,))
    assert transcription_of(MARKDOWN_OPTIONS, [stray], None).unattributed == "partial_success: backend down"


def test_a_successful_run_is_complete_and_its_header_carries_the_generation_params():
    success = docling_result(status=ConversionStatus.SUCCESS, errors=(), stop_reason=VlmStopReason.END_OF_SEQUENCE)
    outcome = transcription_of(MARKDOWN_OPTIONS, [success], None)
    assert outcome.pages[0].markdown == "# T\n\n76. First" and outcome.incomplete is None
    assert outcome.header["docling_status"] == "success"
    assert outcome.header["generation_params"]["chat_template_kwargs"] == {"enable_thinking": False}


def test_the_recorded_layout_is_what_the_worker_resolves(tmp_path, monkeypatch):
    """A run's recorded `ingest` setting reaches its execution; a native PDF ignores it, as it ignores the split."""
    from kei_exp import runs
    from kei_exp.kie.stages import ocr as ocr_stage
    directory = tmp_path / "run"
    directory.mkdir()
    (directory / "input.pdf").write_bytes(b"%PDF-1.4")
    params = {"model": "surya", "layout_model": "layout_heron_101", "page_source": "ingest",
              "ingest": {"split": "spread", "overrides": {"1": 4800}}}
    monkeypatch.setattr(ocr_stage, "native_regions", lambda *_args, **_kwargs: None)
    assert runs.execution_for(directory, params).ingest == {"split": "spread", "overrides": {"1": 4800}}
    assert runs.execution_for(directory, {"model": "surya", "layout_model": "layout_heron_101",
                                          "page_source": "ingest"}).ingest is None
    monkeypatch.setattr(ocr_stage, "native_regions", lambda *_args, **_kwargs: ())
    monkeypatch.setattr(ocr_stage, "undecodable_glyphs", lambda *_args, **_kwargs: False)
    native = runs.execution_for(directory, params)
    assert (native.page_source, native.ingest) == ("pdf", None)

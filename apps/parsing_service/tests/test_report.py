"""The debug report (kei_exp.report.write_report): one schema for every transcriber, written from hand-built page
records with no GPU or server. A VLM run, an incomplete Surya run, the publication by rename and a native execution;
the report writes whatever the execution says, nothing is special-cased in the writer."""
import dataclasses
import json
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from kei_exp import files
from kei_exp.models import MODELS
from kei_exp.report import write_report
from kei_exp.transcription.types import DEFAULT_URL, Execution, PageRecord, Transcription


def execution(**overrides) -> Execution:
    """A Surya whole-page execution unless overridden; the report writes whatever the execution says."""
    fields = {"page_source": "pdf", "ingest_dir": None, "pdf": Path("scan.pdf"), "transcriber": "surya",
              "model": "surya", "repo": MODELS["surya"].repo, "url": DEFAULT_URL, "cut": "none", "layout_model": None,
              "crop_dpi": 250, "max_image_size": None, "max_output_tokens": None, "stream": False, "pages": None,
              "debug_dir": None, "result_dir": None}
    return Execution(**{**fields, **overrides})


column = {"source_page": 1, "kind": "column", "bbox": [0, 0, 10, 10], "order": 0}
vlm_pages = [
    PageRecord(page=1, region=column, image=Image.new("RGBA", (24, 32), "red"), seconds=1.5, input_tokens=1156,
               output_tokens=512, stop="end_of_sequence", capped=False,
               payload={"prediction": {"text": "# T", "usage": {"prompt_tokens": 1156, "completion_tokens": 512}}},
               stats={"input_tokens": 1156, "output_tokens": 512, "stop": "end_of_sequence"},
               markdown="# T", text="T", incomplete=None, source_page=None),
    # A page without a prediction: no image, no stats, so no page_stats event.
    PageRecord(page=2, region={**column, "order": 1}, image=None, seconds=None, input_tokens=None, output_tokens=None,
               stop=None, capped=False, payload={"prediction": None}, stats={}, markdown="", text="", incomplete=None,
               source_page=None),
]
vlm_header = {"prompt": "P", "scale": 1.0, "max_size": 2400, "max_output_tokens": 8192,
              "generation_params": {"model": "m", "repetition_penalty": 1.05}, "errors": [],
              "docling_status": "success"}
surya_pages = [PageRecord(page=1, region=None, image=Image.new("L", (10, 12)), seconds=None, input_tokens=None,
                          output_tokens=16384, stop=None, capped=True,
                          payload={"blocks": [{"html": "<p>x</p>"}], "image_bbox": [0, 0, 10, 12]},
                          stats={"blocks": 1, "errors": 0, "skipped": 0, "output_tokens": 16384, "capped": True},
                          markdown="x", text="x", incomplete="the output kept for page 1 used up its token cap",
                          source_page=3)]
surya_header = {"prompt": None, "scale": 192 / 72, "max_size": None, "max_output_tokens": 16384,
                "generation_params": None, "errors": []}


def test_a_vlm_run_reports_its_settings_its_pages_their_images_and_the_events(tmp_path):
    events = []
    vlm = execution(transcriber="vlm", model="granite_vision", repo=MODELS["granite_vision"].repo, cut="auto",
                    layout_model="layout_egret_xlarge", stream=True, debug_dir=tmp_path)
    write_report(Transcription(vlm_header, vlm_pages), vlm,
                 "2026-09-14T00:00:00+00:00", 12.3456, tmp_path, events.append)
    report = json.loads((tmp_path / "report.json").read_text(encoding="utf-8"))
    assert report["transcriber"] == "vlm" and report["model"] == "granite_vision"
    assert report["repo"] == MODELS["granite_vision"].repo and report["url"] == DEFAULT_URL
    assert report["source"] == "scan.pdf" and report["pages_requested"] is None and report["cut"] == "auto"
    assert report["crop_dpi"] == 250 and report["stream"] is True
    assert report["layout_model"] == "layout_egret_xlarge"
    assert report["started"] == "2026-09-14T00:00:00+00:00" and report["seconds"] == 12.346
    assert report["status"] == "success" and report["incomplete"] is None
    assert report["prompt"] == "P" and report["generation_params"]["repetition_penalty"] == 1.05
    assert report["docling_status"] == "success" and report["errors"] == []
    assert report["tokens"] == {"input": 1156, "output": 512}
    assert set(report["versions"]) == {"docling", "surya-ocr"} and all(report["versions"].values())
    assert [page["page"] for page in report["pages"]] == [1, 2]
    first, second = report["pages"]
    assert first["region"] == column and first["image_pixels"] == [24, 32] and first["seconds"] == 1.5
    assert first["input_tokens"] == 1156 and first["output_tokens"] == 512 and first["stop"] == "end_of_sequence"
    assert first["capped"] is False and first["prediction"]["usage"]["prompt_tokens"] == 1156
    assert second["image_pixels"] is None and second["prediction"] is None and second["region"]["order"] == 1
    assert (first["markdown"], first["text"], first["incomplete"], first["source_page"]) == ("# T", "T", None, None)
    with Image.open(tmp_path / "page-1.png") as image:
        assert image.mode == "RGBA" and image.getpixel((0, 0)) == (255, 0, 0, 255)
    assert not (tmp_path / "page-2.png").exists()
    assert [event["type"] for event in events] == ["page_stats", "log"]
    assert events[0] == {"type": "page_stats", "page": 1, "image": [24, 32], "input_tokens": 1156,
                         "output_tokens": 512, "stop": "end_of_sequence"}
    assert events[1]["text"] == f"Debug files: {tmp_path.resolve()}"


def test_an_incomplete_surya_run_reports_its_reason_and_its_capped_page_as_sent(tmp_path):
    events = []
    write_report(Transcription(surya_header, surya_pages), execution(pages=(3, 3), debug_dir=tmp_path),
                 "2026-09-14T00:00:01+00:00", 3.0, tmp_path, events.append)
    report = json.loads((tmp_path / "report.json").read_text(encoding="utf-8"))
    assert report["transcriber"] == "surya" and report["status"] == "incomplete"
    assert report["layout_model"] is None
    assert report["incomplete"].startswith("the output kept") and report["pages_requested"] == [3, 3]
    assert report["tokens"] == {"input": None, "output": 16384} and report["prompt"] is None
    assert "docling_status" not in report and report["scale"] == 192 / 72
    page = report["pages"][0]
    assert page["region"] is None and page["blocks"][0]["html"] == "<p>x</p>" and page["image_bbox"] == [0, 0, 10, 12]
    assert page["capped"] is True and page["output_tokens"] == 16384 and page["stop"] is None
    assert page["incomplete"].startswith("the output kept") and page["source_page"] == 3
    with Image.open(tmp_path / "page-1.png") as image:
        assert image.mode == "L"  # Surya images are saved exactly as sent
    assert events[0]["blocks"] == 1 and events[0]["capped"] is True and events[0]["image"] == [10, 12]


def test_the_report_is_published_by_rename_once_its_content_is_complete(tmp_path):
    """report.json is published by rename, so a reader polling the run as it ends (the API's boxes endpoint) never
    parses a half-written file: at the moment the name appears, the content under it is complete."""
    events = []
    published = []
    real_replace = files.os.replace

    def replace(part, target):
        part, target = Path(part), Path(target)
        assert not target.exists() and part.parent == target.parent, (part, target)
        assert json.loads(part.read_text(encoding="utf-8"))["transcriber"] == "surya"
        published.append(target.name)
        real_replace(part, target)

    with patch.object(files.os, "replace", replace):
        write_report(Transcription(surya_header, [dataclasses.replace(surya_pages[0], incomplete=None, capped=False)]),
                     execution(debug_dir=tmp_path), "2026-09-14T00:00:02+00:00", 1.0, tmp_path, events.append)
    assert published == ["report.json"], published
    assert json.loads((tmp_path / "report.json").read_text(encoding="utf-8"))["status"] == "success"
    assert not list(tmp_path.glob("*.part")), list(tmp_path.iterdir())


def test_a_native_execution_reports_exactly_its_own_settings(tmp_path):
    """A native execution reports exactly its own settings: nothing is special-cased in the writer."""
    events = []
    native_header = {"prompt": None, "scale": 1.0, "max_size": None, "max_output_tokens": None,
                     "generation_params": None, "errors": [], "docling_status": "success"}
    write_report(Transcription(native_header, []),
                 execution(transcriber="native", model=None, repo=None, url=None, crop_dpi=None, debug_dir=tmp_path),
                 "2026-09-14T00:00:03+00:00", 0.5, tmp_path, events.append)
    report = json.loads((tmp_path / "report.json").read_text(encoding="utf-8"))
    assert (report["transcriber"], report["model"], report["repo"], report["url"], report["cut"], report["crop_dpi"],
            report["layout_model"], report["stream"]) == ("native", None, None, None, "none", None, None, False)
    assert report["tokens"] == {"input": None, "output": None} and report["pages"] == []

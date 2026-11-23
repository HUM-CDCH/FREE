"""Docling's weights are read from kei's local folder (kei_exp.weights): once they are there, a conversion asks the
Hugging Face hub nothing."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import Mock

import httpx
import pytest
from docling.datamodel.pipeline_options import PdfPipelineOptions
from PIL import Image

from kei_exp import cut, weights
from kei_exp.kie.stages.ocr import TRANSCRIBERS, resolve
from kei_exp.regions import DEFAULT_LAYOUT_MODEL
from kei_exp.transcription.types import RunParams
from tests.helpers.pdfs import text_pdf


@pytest.mark.parametrize("table", [False, True], ids=["layout", "table"])
def test_partial_snapshot_can_be_retried_after_the_hub_cache_is_repaired(tmp_path, monkeypatch, table):
    monkeypatch.setattr(weights.settings, "cache_dir", tmp_path / "docling")
    monkeypatch.setattr(weights.settings, "artifacts_path", None)
    layout = tmp_path / "layout"
    layout.mkdir()
    for name in ("config.json", "preprocessor_config.json", "model.safetensors"):
        (layout / name).write_bytes(b"layout")
    tables = tmp_path / "tables"
    for mode in ("accurate", "fast"):
        model = tables / "model_artifacts" / "tableformer" / mode
        model.mkdir(parents=True)
        (model / "tm_config.json").write_bytes(b"config")
        (model / f"tableformer_{mode}.safetensors").write_bytes(b"weights")
    monkeypatch.setattr(weights, "download_hf_model", lambda *_args, **_kwargs: layout)
    monkeypatch.setattr(weights.TableStructureModel, "download_models", lambda: tables)

    snapshot = tables if table else layout
    missing = "model_artifacts/tableformer/accurate/tableformer_accurate.safetensors" if table else "model.safetensors"
    (snapshot / missing).unlink()
    options = PdfPipelineOptions(do_table_structure=table)
    with pytest.raises(FileNotFoundError, match="Incomplete Docling snapshot"):
        weights.local(options)
    name = "docling-project--docling-models" if table else "docling-project--docling-layout-heron"
    folder = weights.settings.cache_dir / "models" / weights.version("docling") / name
    assert not folder.exists()

    folder.mkdir()  # a legacy worker published a config-only copy
    (folder / "config.json").write_bytes(b"old")
    (snapshot / missing).write_bytes(b"repaired")
    assert weights.local(options) == folder.parent
    assert (folder / missing).read_bytes() == b"repaired"


def test_concurrent_cold_starts_recover_interrupted_staging_and_fetch_once(tmp_path, monkeypatch):
    folder = tmp_path / "model"
    staging = folder.with_suffix(".partial")
    staging.mkdir()
    (staging / "interrupted").touch()
    snapshot = tmp_path / "snapshot"
    snapshot.mkdir()
    (snapshot / "weights").write_bytes(b"model")
    # Both callers have observed a miss before either can acquire the real file lock.
    both_missed = Barrier(2)
    file_lock = weights.FileLock

    def lock(path):
        both_missed.wait(timeout=10)
        return file_lock(path)

    monkeypatch.setattr(weights, "FileLock", lock)
    fetch = Mock(return_value=snapshot)
    with ThreadPoolExecutor(2) as pool:
        jobs = [pool.submit(weights._keep, folder, ("weights",), fetch) for _ in range(2)]
        for job in jobs:
            job.result()
    fetch.assert_called_once_with()
    assert not staging.exists() and not (folder / "interrupted").exists()
    assert (folder / "weights").read_bytes() == b"model"


@pytest.mark.live_model
def test_a_conversion_asks_the_hub_nothing_once_its_weights_are_local(tmp_path, monkeypatch):
    # Left to find its own weights, Docling resolves each model's revision on huggingface.co for every pipeline it
    # builds, cached or not: every native conversion waited on the hub (once for 68 s) for weights it already had,
    # and so did a worker's first cut. Both pipelines kei builds are checked: the native one and the cut's layout.
    monkeypatch.setattr(weights.settings, "cache_dir", tmp_path / "docling")
    monkeypatch.setattr(weights.settings, "artifacts_path", None)
    text_pdf(tmp_path / "page.pdf", [["One line of native text is enough to build the pipeline."]])
    execution = resolve(RunParams(pdf=tmp_path / "page.pdf", model="surya"))

    def convert() -> None:
        native = TRANSCRIBERS["native"].transcribe(execution, None, lambda event: None)
        assert native.incomplete is None and "native text" in native.pages[0].text, native.incomplete
        cut._layout_converter.cache_clear()  # a new worker process builds it again
        cut._layout(Image.new("RGB", (200, 200), "white"), 1.0, (0, 0), DEFAULT_LAYOUT_MODEL)

    convert()  # the first use on this machine fetches the weights

    def refuse(*_args, **_kwargs):
        raise AssertionError("a conversion whose weights are local asked the network")
    monkeypatch.setattr(httpx.Client, "send", refuse)
    convert()

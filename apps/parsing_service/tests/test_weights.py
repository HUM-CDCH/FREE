"""Docling's weights are read from kei's local folder (kei_exp.weights): once they are there, a conversion asks the
Hugging Face hub nothing."""
import httpx
import pytest
from PIL import Image

from kei_exp import cut
from kei_exp.kie.stages.ocr import TRANSCRIBERS, resolve
from kei_exp.regions import DEFAULT_LAYOUT_MODEL
from kei_exp.transcription.types import RunParams
from tests.helpers.pdfs import text_pdf


@pytest.mark.live_model
def test_a_conversion_asks_the_hub_nothing_once_its_weights_are_local(tmp_path, monkeypatch):
    # Left to find its own weights, Docling resolves each model's revision on huggingface.co for every pipeline it
    # builds, cached or not: every native conversion waited on the hub (once for 68 s) for weights it already had,
    # and so did a worker's first cut. Both pipelines kei builds are checked: the native one and the cut's layout.
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

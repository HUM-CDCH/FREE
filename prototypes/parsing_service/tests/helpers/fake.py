"""A transcriber that stands in for the adapters behind convert(): one record per input with queued Markdown and
reasons, queued records outright, or one Surya-like block per crop; it remembers what it was asked. Registered
under the kind `fake` with a model record of its own for the duration of a test."""
from collections.abc import Iterator
from contextlib import contextmanager

from kei_exp.cut import region_info
from kei_exp.kie.stages.ocr import TRANSCRIBERS
from kei_exp.models import MODELS, Model
from kei_exp.transcription.types import PageRecord, Transcription

HEADER = {"prompt": "P", "scale": 2.0, "max_size": 1200, "max_output_tokens": 8192,
          "generation_params": {"model": "fake/model"}, "errors": []}
BLOCK = {"reading_order": 0, "label": "Text", "confidence": 0.9, "bbox": [10, 20, 30, 40], "html": "<p>x</p>",
         "skipped": False, "error": False}


class FakeTranscriber:
    kind = "fake"

    def __init__(self, *, knobs: frozenset[str] = frozenset({"stream"}), blocks: bool = False) -> None:
        self.knobs = knobs
        self.blocks = blocks                # one Surya-like block per crop at crop pixels (10, 20)-(30, 40)
        self.header = dict(HEADER)
        self.markdown = "complete output"   # every record's Markdown
        self.incomplete = None              # every record's reason
        self.records = None                 # queued records, used instead of the built ones when set
        self.calls: list[tuple] = []

    def transcribe(self, execution, crops, emit) -> Transcription:
        self.calls.append((execution, crops))
        if not self.blocks:
            emit({"type": "phase", "name": "vlm", "total": None})
            emit({"type": "token", "page": 1, "text": "x"})  # numbered by input ordinal, as every adapter does
        if self.records is not None:
            return Transcription(self.header, self.records)
        if self.blocks:
            pages = [PageRecord(page=number, region=region_info(crop), image=None, seconds=None, input_tokens=None,
                                output_tokens=None, stop=None, capped=False, payload={"blocks": [dict(BLOCK)]},
                                stats={}, markdown="text", text="x", incomplete=None, source_page=None)
                     for number, crop in enumerate(crops or [], 1)]
            return Transcription({"prompt": None, "scale": None, "max_size": None, "max_output_tokens": None,
                                  "generation_params": None, "errors": []}, pages)
        first, last = execution.pages or (1, 1)  # the one-page input of the conversion tests
        inputs = [(n, region_info(crop), None) for n, crop in enumerate(crops, 1)] if crops is not None else \
            [(n, None, first + n - 1) for n in range(1, last - first + 2)]
        return Transcription(self.header, [
            PageRecord(page=n, region=region, image=None, seconds=None, input_tokens=None, output_tokens=None,
                       stop=None, capped=False, payload={}, stats={}, markdown=self.markdown, text=self.markdown,
                       incomplete=self.incomplete, source_page=source)
            for n, region, source in inputs])


@contextmanager
def registered(fake: FakeTranscriber, *, max_new_tokens: int | None = 8192) -> Iterator[FakeTranscriber]:
    """`fake` registered as the transcriber of the `fake` model record for the block."""
    TRANSCRIBERS[fake.kind] = fake
    MODELS["fake"] = Model("fake/model", kind=fake.kind, max_new_tokens=max_new_tokens)
    try:
        yield fake
    finally:
        TRANSCRIBERS.pop(fake.kind, None)
        MODELS.pop("fake", None)

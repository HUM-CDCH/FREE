"""Streaming transcription: read_stream prints each SSE piece as it arrives, maps the finish reason to the run's stop
reason and refuses broken streams; StreamingVlmEngine sends the streamed request Docling's API path would; the CLI
printer labels the live text by page. No model server: the responses are hand-written event lines."""
import base64
import json
from contextlib import redirect_stdout
from io import BytesIO, StringIO
from unittest.mock import Mock, patch

import pytest
from docling.models.inference_engines.vlm.base import VlmEngineInput
from PIL import Image

from kei_exp.models import MODELS
from kei_exp.progress import _Printer
from kei_exp.transcription.streaming import StreamingVlmEngine, read_stream
from kei_exp.transcription.vlm import engine_options, vlm_options


def events(finish_reason, output):
    """The event lines of one completion, three text pieces then `finish_reason`; as each next line is pulled, the
    piece before it must already have reached `output`."""
    yield b": keepalive"
    yield b'data: {"choices": [{"delta": {"role": "assistant"}}]}'
    for piece in ["Grüße", "\n", "Welt"]:
        before = output.getvalue()
        # Non-ASCII arrives as raw UTF-8 bytes; a Latin-1 decode would corrupt it.
        yield b"data: " + json.dumps({"choices": [{"delta": {"content": piece}}]}, ensure_ascii=False).encode()
        assert output.getvalue() == before + piece  # Printed before the next event arrives.
    yield b"data: " + json.dumps({"choices": [{"delta": {}, "finish_reason": finish_reason}]}).encode()
    yield b'data: {"choices": [], "usage": {"prompt_tokens": 1156, "completion_tokens": 3}}'
    yield b"data: [DONE]"


@pytest.mark.parametrize(("reason", "expected"), [
    pytest.param("stop", "end_of_sequence", id="stop"),
    pytest.param("length", "length", id="length"),
    pytest.param("content_filter", "content_filter", id="content_filter"),
])
def test_read_stream_prints_each_piece_and_keeps_the_stop_reason_and_usage(reason, expected):
    output = StringIO()
    response = Mock()
    response.iter_lines.return_value = events(reason, output)
    with redirect_stdout(output):
        result = read_stream(response)
    assert result.text == "Grüße\nWelt" and result.stop_reason == expected
    assert result.metadata["usage"]["prompt_tokens"] == 1156
    assert result.metadata["num_tokens"] == 3


BROKEN_STREAMS = [
    pytest.param([], id="empty"),
    pytest.param([b'data: {"choices": [{"finish_reason": "stop"}]}'], id="finish-without-done"),
    pytest.param([b"data: [DONE]"], id="done-without-finish"),
    pytest.param([b'data: {"error": {"message": "failed"}}'], id="error-event"),
    pytest.param([b"data: invalid"], id="not-json"),
]


@pytest.mark.parametrize("lines", BROKEN_STREAMS)
def test_read_stream_refuses_a_broken_stream(lines):
    response = Mock()
    response.iter_lines.return_value = iter(lines)
    with redirect_stdout(StringIO()), pytest.raises((RuntimeError, ValueError)):  # else: broken stream accepted
        read_stream(response)


def test_engine_streams_the_request_with_usage_and_an_rgba_png():
    engine = StreamingVlmEngine(enable_remote_services=True, options=engine_options(
        vlm_options(MODELS["granite_vision"], "http://localhost:8000/v1/chat/completions", 1200)
    ), emit=None)
    output = StringIO()
    with patch("kei_exp.transcription.streaming.requests.post") as post, redirect_stdout(output):
        response = post.return_value.__enter__.return_value
        response.iter_lines.return_value = events("length", output)
        result = engine.predict_batch([VlmEngineInput(
            image=Image.new("RGB", (12, 8), "red"), prompt="Transcribe", max_new_tokens=100
        )])[0]
        payload = post.call_args.kwargs["json"]
        assert payload["stream"] and payload["stream_options"]["include_usage"]
        assert payload["max_tokens"] == 100 and result.stop_reason == "length"
        encoded = payload["messages"][0]["content"][0]["image_url"]["url"].split(",", 1)[1]
        with Image.open(BytesIO(base64.b64decode(encoded))) as image:
            assert image.size == (12, 8) and image.mode == "RGBA"


def test_printer_labels_the_live_text_by_page():
    # The CLI printer labels the live text by page: a label when the page changes, a fresh one after a retry of the
    # page being printed, and a fresh one for the next conversion (phase events reset it).
    emitted = [
        {"type": "phase", "name": "ocr", "total": 2},
        {"type": "page_start", "page": 1}, {"type": "token", "page": 1, "text": "one"},
        {"type": "page_start", "page": 2}, {"type": "token", "page": 2, "text": "two"},
        {"type": "token", "page": 1, "text": " more"},
        {"type": "page_start", "page": 1}, {"type": "token", "page": 1, "text": "again"},
        {"type": "page_end", "page": 1, "stop_reason": "end_of_sequence", "output_tokens": 2, "seconds": 0.1},
        {"type": "token", "page": 2, "text": " done"},
        {"type": "page_end", "page": 2, "stop_reason": "end_of_sequence", "output_tokens": 2, "seconds": 0.1},
        {"type": "phase", "name": "export", "total": None},
        {"type": "phase", "name": "vlm", "total": 1}, {"type": "token", "page": 1, "text": "next run"},
    ]
    output, printer = StringIO(), _Printer()
    with redirect_stdout(output):
        for event in emitted:
            printer(event)
    expected = "[page 1] one\n[page 2] two\n[page 1]  more\n[page 1] again\n[page 2]  done\n[page 1] next run"
    assert output.getvalue() == expected, repr(output.getvalue())

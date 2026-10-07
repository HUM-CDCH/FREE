import base64
import json
import time
from collections.abc import Callable
from io import BytesIO

import requests
from docling.models.inference_engines.vlm.api_openai_compatible_engine import (
    ApiVlmEngine,
)
from docling.models.inference_engines.vlm.base import VlmEngineInput, VlmEngineOutput

from kei_exp.progress import STOP_REASONS, Emit


def read_stream(response: requests.Response, on_token: Callable[[str], None] | None = None) -> VlmEngineOutput:
    """Collect an SSE completion; each piece goes to on_token as it arrives, or to stdout without one."""
    pieces, usage, finish_reason = [], None, None
    for raw_line in response.iter_lines(chunk_size=1):
        # SSE is UTF-8 by spec; requests would guess Latin-1 for text/event-stream.
        line = raw_line.decode("utf-8", errors="replace")
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            break
        event = json.loads(data)
        if event.get("error"):
            raise RuntimeError(f"Streaming API error: {event['error']}")
        if event.get("usage") is not None:
            usage = event["usage"]
        for choice in event.get("choices", []):
            piece = (choice.get("delta") or {}).get("content") or ""
            if on_token is None:
                print(piece, end="", flush=True)
            else:
                on_token(piece)
            pieces.append(piece)
            finish_reason = choice.get("finish_reason") or finish_reason
    else:
        raise RuntimeError("Model stream disconnected before [DONE]")
    if on_token is None:
        print(flush=True)
    if finish_reason not in STOP_REASONS:
        raise RuntimeError(f"Unexpected stream finish reason: {finish_reason}")
    return VlmEngineOutput(
        text="".join(pieces).strip(),
        stop_reason=STOP_REASONS[finish_reason],
        metadata={"usage": usage, "num_tokens": (usage or {}).get("completion_tokens")},
    )


class StreamingVlmEngine(ApiVlmEngine):
    def __init__(self, *args, emit: Emit | None = None, **kwargs):
        super().__init__(*args, **kwargs)
        self.emit = emit
        self.page = 0  # running page number across every batch of this run

    def _on_token(self, page: int) -> Callable[[str], None] | None:
        """The callback that emits page's tokens as they stream, bound to page now; None without an emit."""
        emit = self.emit
        if emit is None:
            return None
        return lambda text: emit({"type": "token", "page": page, "text": text})

    def predict_batch(self, input_batch: list[VlmEngineInput]) -> list[VlmEngineOutput]:
        outputs = []
        # Sequential requests keep each page's live text together.
        for item in input_batch:
            self.page += 1
            page = self.page
            image = BytesIO()
            # Match Docling's API path: RGB normalization, then RGBA PNG encoding.
            item.image.convert("RGB").convert("RGBA").save(image, "PNG")
            payload = {
                "temperature": item.temperature,
                "max_tokens": item.max_new_tokens,
                **self.options.params,
                "stream": True,
                "stream_options": {"include_usage": True},
                "messages": [{"role": "user", "content": [
                    {"type": "image_url", "image_url": {
                        "url": "data:image/png;base64," + base64.b64encode(image.getvalue()).decode("ascii"),
                    }},
                    {"type": "text", "text": item.prompt},
                ]}],
            }
            if item.stop_strings:
                payload.setdefault("stop", item.stop_strings)
            on_token = self._on_token(page)
            if self.emit is not None:
                self.emit({"type": "page_start", "page": page})
            started = time.monotonic()
            with requests.post(
                str(self.options.url), json=payload, headers=self.options.headers,
                timeout=self.options.timeout, stream=True,
            ) as response:
                response.raise_for_status()
                output = read_stream(response, on_token)
            output.metadata["generation_time"] = time.monotonic() - started
            if self.emit is not None:
                self.emit({"type": "page_end", "page": page, "stop_reason": output.stop_reason,
                           "output_tokens": output.metadata["num_tokens"],
                           "seconds": output.metadata["generation_time"]})
            outputs.append(output)
        return outputs

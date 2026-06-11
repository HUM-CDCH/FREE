import base64
import io
import json
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx
import pypdfium2 as pdfium
from fastapi import Depends, FastAPI, Form, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from PIL import Image
from pydantic import BaseModel
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="NUEXTRACT3_", env_file=".env")

    base_url: str = "http://127.0.0.1:12434/engines/v1"
    model: str = "hf.co/numind/NuExtract3-GGUF:mmproj"
    api_key: str = "EMPTY"
    timeout_seconds: float = 120
    pdf_dpi: int = 64
    max_tokens: int = 10000
    system_prompt: str = (
        "You are a precise information extraction assistant. "
        "Return faithful, source-grounded results only."
    )


settings = Settings()

app = FastAPI(title="NuExtract3 extraction server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

JSONL_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
JSON_LINE_EVENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["event", "data"],
    "properties": {
        "event": {"type": "string"},
        "data": {"type": "object", "additionalProperties": True},
    },
}
STREAM_RESPONSES: dict[int, dict[str, Any]] = {
    200: {
        "description": (
            "JSON Lines stream. Swagger UI receives a buffered JSON array preview "
            "because it cannot render application/jsonl responses reliably."
        ),
        "content": {
            "application/json": {
                "schema": {"type": "array", "items": JSON_LINE_EVENT_SCHEMA}
            },
            "application/jsonl": {
                "schema": {
                    "type": "string",
                    "description": "One JsonLineEvent JSON object per line.",
                }
            },
        },
    }
}


class JsonLineEvent(BaseModel):
    event: str
    data: dict[str, Any]


@dataclass(frozen=True)
class ExtractRequest:
    content: list[dict[str, Any]]
    chat_kwargs: dict[str, Any]
    temperature: float
    reasoning: bool
    pages: int


@dataclass(frozen=True)
class MarkdownRequest:
    jpeg_pages: list[bytes]
    chat_kwargs: dict[str, Any]
    temperature: float
    reasoning: bool


@dataclass(frozen=True)
class TemplateRequest:
    content: list[dict[str, Any]]
    chat_kwargs: dict[str, Any]
    temperature: float
    pages: int


def resolve_temperature(temperature: float | None, reasoning: bool) -> float:
    # model card recommends 0.2 without reasoning, 0.6 with reasoning
    if temperature is not None:
        return temperature
    return 0.6 if reasoning else 0.2


def pages_to_jpeg(data: bytes, content_type: str | None) -> list[bytes]:
    if data.startswith(b"%PDF") or content_type == "application/pdf":
        pdf = pdfium.PdfDocument(data)
        try:
            images = [
                page.render(scale=settings.pdf_dpi / 72).to_pil() for page in pdf
            ]
        finally:
            pdf.close()
    else:
        try:
            images = [Image.open(io.BytesIO(data))]
        except Exception:
            raise HTTPException(400, "Unsupported file type: expected a PDF or an image")

    pages = []
    for img in images:
        buffer = io.BytesIO()
        img.convert("RGB").save(buffer, format="JPEG", quality=95)
        pages.append(buffer.getvalue())
    return pages


def make_image_content(jpeg_pages: list[bytes], extra_text: str | None) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = [
        {
            "type": "image_url",
            "image_url": {
                "url": f"data:image/jpeg;base64,{base64.b64encode(page).decode()}",
                "detail": "high",
            },
        }
        for page in jpeg_pages
    ]
    if extra_text:
        content.append({"type": "text", "text": extra_text})
    return content


def make_text_content(text: str) -> list[dict[str, Any]]:
    return [{"type": "text", "text": text}]


def strip_code_fence(payload: str) -> str:
    return re.sub(
        r"^```(?:json|markdown|text)?\s*|\s*```$",
        "",
        payload.strip(),
        flags=re.IGNORECASE | re.MULTILINE,
    ).strip()


def pretty_json_or_text(payload: str) -> str:
    if not payload:
        return ""
    cleaned = strip_code_fence(payload)
    try:
        return json.dumps(json.loads(cleaned), indent=4, ensure_ascii=False)
    except Exception:
        return cleaned


def extract_answer_block(text: str) -> str:
    if not text:
        return ""
    match = re.search(
        r"<answer>\s*(.*?)\s*</answer>", text, flags=re.DOTALL | re.IGNORECASE
    )
    if match:
        return pretty_json_or_text(match.group(1).strip())

    json_objects = list(re.finditer(r"\{[\s\S]*\}", text))
    if json_objects:
        candidate = max(json_objects, key=lambda m: len(m.group(0))).group(0)
        return pretty_json_or_text(candidate)

    return text.strip()


class ThinkSplitter:
    """Route streamed deltas into incremental (think, output) text.

    llama.cpp-based servers stream reasoning on a separate reasoning_content
    channel with the answer in content; vLLM-style servers inline
    <think>…</think> in content. Tags can straddle chunk boundaries, so a
    trailing partial tag is withheld until the next chunk resolves it.
    """

    _START = "<think>"
    _END = "</think>"

    def __init__(self, reasoning: bool):
        # until proven otherwise, content may open with an inline think block
        self._inline_think = reasoning
        self._at_start = True
        self._buffer = ""
        self.think = ""
        self.output = ""

    def feed(self, reasoning_delta: str, content_delta: str) -> tuple[str, str]:
        think_delta, output_delta = reasoning_delta, ""
        if reasoning_delta and self._inline_think:
            # reasoning has its own channel, so content is pure output
            self._inline_think = False
            output_delta, self._buffer = self._buffer, ""
        if not self._inline_think:
            output_delta += content_delta
        elif content_delta:
            inline_think, inline_output = self._split_inline(content_delta)
            think_delta += inline_think
            output_delta += inline_output
        self.think += think_delta
        self.output += output_delta
        return think_delta, output_delta

    def close(self) -> str:
        """Flush a withheld partial tag when the stream ends mid-tag."""
        tail, self._buffer = self._buffer, ""
        self.think += tail
        return tail

    def _split_inline(self, content_delta: str) -> tuple[str, str]:
        self._buffer += content_delta
        if self._at_start:
            candidate = self._buffer.lstrip()
            if candidate.lower().startswith(self._START):
                self._buffer = candidate[len(self._START):]
                self._at_start = False
            elif self._START.startswith(candidate.lower()):
                return "", ""  # may still grow into a leading <think>; hold
            else:
                self._at_start = False

        end_idx = self._buffer.lower().find(self._END)
        if end_idx != -1:
            think, output = self._buffer[:end_idx], self._buffer[end_idx + len(self._END):]
            self._buffer = ""
            self._inline_think = False
            return think, output

        held = self._partial_end_len()
        think, self._buffer = self._buffer[: len(self._buffer) - held], self._buffer[len(self._buffer) - held:]
        return think, ""

    def _partial_end_len(self) -> int:
        for length in range(min(len(self._buffer), len(self._END) - 1), 0, -1):
            if self._buffer[-length:].lower() == self._END[:length]:
                return length
        return 0


def normalize_template(template: str | None) -> str:
    """Pretty-print valid JSON templates; pass anything else through untouched."""
    tpl = (template or "").strip()
    if not tpl:
        return "{}"
    try:
        return json.dumps(json.loads(tpl), indent=4, ensure_ascii=False)
    except Exception:
        return tpl


def parse_result(answer: str) -> Any:
    try:
        return json.loads(answer)
    except Exception:
        return answer


def apply_jsonl_headers(response: Response) -> None:
    for header, value in JSONL_HEADERS.items():
        response.headers[header] = value


def jsonl_event(event: str, data: dict[str, Any]) -> JsonLineEvent:
    return JsonLineEvent(event=event, data=data)


def wants_buffered_json(request: Request) -> bool:
    accept = request.headers.get("accept", "")
    return "application/json" in accept and "application/jsonl" not in accept


async def stream_jsonl_events(
    events: AsyncIterator[JsonLineEvent],
) -> AsyncIterator[str]:
    async for event in events:
        yield f"{event.model_dump_json()}\n"


async def collect_json_events(
    events: AsyncIterator[JsonLineEvent],
) -> list[dict[str, Any]]:
    return [event.model_dump(mode="json") async for event in events]


async def render_event_response(
    request: Request,
    events: AsyncIterator[JsonLineEvent],
) -> Response:
    if wants_buffered_json(request):
        return JSONResponse(await collect_json_events(events), headers=JSONL_HEADERS)
    return StreamingResponse(
        stream_jsonl_events(events),
        media_type="application/jsonl",
        headers=JSONL_HEADERS,
    )


def build_payload(
    content: list[dict[str, Any]],
    chat_kwargs: dict[str, Any],
    temperature: float,
    stream: bool,
) -> dict[str, Any]:
    return {
        "model": settings.model,
        "temperature": temperature,
        "max_tokens": settings.max_tokens,
        "stream": stream,
        "messages": [
            {"role": "system", "content": settings.system_prompt},
            {"role": "user", "content": content},
        ],
        "chat_template_kwargs": chat_kwargs,
    }


def delta_to_text(chunk: dict[str, Any]) -> tuple[str, str]:
    """Return (reasoning_delta, content_delta) from a streamed chunk."""
    choices = chunk.get("choices") or []
    if not choices:
        return "", ""
    delta = choices[0].get("delta") or {}
    content = delta.get("content")
    if isinstance(content, list):
        content = "".join(
            part.get("text", "") for part in content if isinstance(part, dict)
        )
    return delta.get("reasoning_content") or "", content or ""


async def call_model_stream(
    content: list[dict[str, Any]],
    chat_kwargs: dict[str, Any],
    temperature: float,
) -> AsyncIterator[tuple[str, str]]:
    """Yield (reasoning_delta, content_delta) for each streamed chunk."""
    payload = build_payload(content, chat_kwargs, temperature, stream=True)
    async with httpx.AsyncClient(timeout=settings.timeout_seconds) as client:
        async with client.stream(
            "POST",
            f"{settings.base_url.rstrip('/')}/chat/completions",
            json=payload,
            headers={"Authorization": f"Bearer {settings.api_key}"},
        ) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[len("data:"):].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue
                think_delta, answer_delta = delta_to_text(chunk)
                if think_delta or answer_delta:
                    yield think_delta, answer_delta


async def jsonl_delta_events(
    splitter: ThinkSplitter,
    model_stream: AsyncIterator[tuple[str, str]],
    extra: dict[str, Any] | None = None,
) -> AsyncIterator[JsonLineEvent]:
    """Emit a delta JSON Lines event per chunk, carrying only the new text."""
    base = extra or {}
    async for reasoning_delta, content_delta in model_stream:
        think_delta, output_delta = splitter.feed(reasoning_delta, content_delta)
        if think_delta or output_delta:
            yield jsonl_event(
                "delta", {**base, "think": think_delta, "output": output_delta}
            )
    tail = splitter.close()
    if tail:
        yield jsonl_event("delta", {**base, "think": tail, "output": ""})


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


async def prepare_extract_request(
    response: Response,
    file: UploadFile | None = None,
    text: str | None = Form(None),
    template: str | None = Form(None),
    instruction: str | None = Form(None),
    reasoning: bool = Form(False),
    temperature: float | None = Form(None),
) -> ExtractRequest:
    apply_jsonl_headers(response)
    text = (text or "").strip()
    if file is None and not text:
        raise HTTPException(400, "Provide a document file or text")

    instruction = (instruction or "").strip()
    template_json = normalize_template(template)
    use_structured = template_json != "{}"

    extra_parts = []
    if instruction:
        extra_parts.append(f"Instructions:\n{instruction}")
    if use_structured:
        extra_parts.append(f"Extraction template:\n```json\n{template_json}\n```")
    extra_text = "\n\n".join(extra_parts) or None

    if file is not None:
        jpeg_pages = pages_to_jpeg(await file.read(), file.content_type)
        content = make_image_content(jpeg_pages, extra_text)
    else:
        jpeg_pages = []
        content = make_text_content(f"{text}\n\n{extra_text}" if extra_text else text)

    chat_kwargs: dict[str, Any] = {
        "mode": "structured" if use_structured else "content",
        "enable_thinking": reasoning,
    }
    if use_structured:
        chat_kwargs["template"] = template_json
    if instruction:
        chat_kwargs["instructions"] = instruction

    temp = resolve_temperature(temperature, reasoning)
    return ExtractRequest(
        content=content,
        chat_kwargs=chat_kwargs,
        temperature=temp,
        reasoning=reasoning,
        pages=len(jpeg_pages),
    )


async def extract_events(request: ExtractRequest) -> AsyncIterator[JsonLineEvent]:
    splitter = ThinkSplitter(request.reasoning)
    try:
        async for event in jsonl_delta_events(
            splitter,
            call_model_stream(
                request.content, request.chat_kwargs, request.temperature
            ),
        ):
            yield event
        think = splitter.think.strip()
        answer = extract_answer_block(splitter.output)
        raw = (
            f"{splitter.think}\n</think>\n{splitter.output}"
            if think
            else splitter.output
        )
        yield jsonl_event(
            "done",
            {
                "result": parse_result(answer),
                "reasoning": think or None,
                "raw": raw,
                "pages": request.pages,
            },
        )
    except httpx.HTTPError as exc:
        yield jsonl_event("error", {"detail": f"Model endpoint error: {exc}"})


@app.post("/extract", responses=STREAM_RESPONSES)
async def extract(
    http_request: Request,
    request: ExtractRequest = Depends(prepare_extract_request),
) -> Response:
    return await render_event_response(http_request, extract_events(request))


async def prepare_markdown_request(
    response: Response,
    file: UploadFile,
    reasoning: bool = Form(False),
    temperature: float | None = Form(None),
) -> MarkdownRequest:
    apply_jsonl_headers(response)
    jpeg_pages = pages_to_jpeg(await file.read(), file.content_type)
    chat_kwargs: dict[str, Any] = {"mode": "markdown", "enable_thinking": reasoning}
    temp = resolve_temperature(temperature, reasoning)
    return MarkdownRequest(
        jpeg_pages=jpeg_pages,
        chat_kwargs=chat_kwargs,
        temperature=temp,
        reasoning=reasoning,
    )


async def markdown_events(
    request: MarkdownRequest,
) -> AsyncIterator[JsonLineEvent]:
    results = []
    try:
        for index, page in enumerate(request.jpeg_pages):
            page_content = make_image_content([page], None)
            splitter = ThinkSplitter(request.reasoning)
            async for event in jsonl_delta_events(
                splitter,
                call_model_stream(
                    page_content, request.chat_kwargs, request.temperature
                ),
                extra={"page": index},
            ):
                yield event
            output = splitter.output.strip()
            results.append(output)
            yield jsonl_event(
                "page_done",
                {
                    "page": index,
                    "markdown": output,
                    "reasoning": splitter.think.strip() or None,
                },
            )
        yield jsonl_event("done", {"pages": results, "count": len(results)})
    except httpx.HTTPError as exc:
        yield jsonl_event("error", {"detail": f"Model endpoint error: {exc}"})


@app.post("/markdown", responses=STREAM_RESPONSES)
async def markdown(
    http_request: Request,
    request: MarkdownRequest = Depends(prepare_markdown_request),
) -> Response:
    return await render_event_response(http_request, markdown_events(request))


TEMPLATE_GUIDANCE = (
    "Generate a concise JSON extraction template for this document. "
    "Use descriptive field names and simple type hints like string, "
    "number, YYYY-MM-DD, boolean, or arrays of objects. Return only "
    "the JSON template."
)


async def prepare_template_request(
    response: Response,
    file: UploadFile | None = None,
    text: str | None = Form(None),
    temperature: float | None = Form(None),
) -> TemplateRequest:
    apply_jsonl_headers(response)
    text = (text or "").strip()
    if file is None and not text:
        raise HTTPException(400, "Provide a document file or text")

    if file is not None:
        jpeg_pages = pages_to_jpeg(await file.read(), file.content_type)
        content = make_image_content(jpeg_pages, TEMPLATE_GUIDANCE)
    else:
        jpeg_pages = []
        content = make_text_content(f"{text}\n\n{TEMPLATE_GUIDANCE}")

    # the chat template defaults enable_thinking to true, which this mode forbids
    chat_kwargs: dict[str, Any] = {"mode": "template-generation", "enable_thinking": False}
    temp = resolve_temperature(temperature, False)
    return TemplateRequest(
        content=content,
        chat_kwargs=chat_kwargs,
        temperature=temp,
        pages=len(jpeg_pages),
    )


async def generate_template_events(
    request: TemplateRequest,
) -> AsyncIterator[JsonLineEvent]:
    splitter = ThinkSplitter(False)
    try:
        async for event in jsonl_delta_events(
            splitter,
            call_model_stream(
                request.content, request.chat_kwargs, request.temperature
            ),
        ):
            yield event
        template = parse_result(pretty_json_or_text(splitter.output))
        yield jsonl_event(
            "done",
            {"template": template, "raw": splitter.output, "pages": request.pages},
        )
    except httpx.HTTPError as exc:
        yield jsonl_event("error", {"detail": f"Model endpoint error: {exc}"})


@app.post("/generate-template", responses=STREAM_RESPONSES)
async def generate_template(
    http_request: Request,
    request: TemplateRequest = Depends(prepare_template_request),
) -> Response:
    return await render_event_response(
        http_request, generate_template_events(request)
    )

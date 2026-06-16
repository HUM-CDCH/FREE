import base64
import io
import json
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, Literal

import httpx
import pypdfium2 as pdfium
from fastapi import FastAPI, Form, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from model_providers import ChatContent, ModelProvider, create_model_provider
from PIL import Image
from pydantic import BaseModel, TypeAdapter, ValidationError, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="NUEXTRACT3_", env_file=".env")

    provider: Literal["ollama", "vllm", "openai"] = "ollama"
    base_url: str = "http://127.0.0.1:11434"
    model: str = "nuextract"          # vision model: PDF images → extracted data
    schema_model: str = "qwen3.5:2b"  # text model: annotations → schema suggestion
    api_key: str = ""
    timeout_seconds: float = 120
    pdf_dpi: int = 64
    max_tokens: int = 10000
    system_prompt: str = (
        "You are a precise information extraction assistant. "
        "Return faithful, source-grounded results only."
    )

    @field_validator("provider", mode="before")
    @classmethod
    def normalize_provider(cls, value: Any) -> Any:
        return value.lower() if isinstance(value, str) else value


settings = Settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.client = httpx.AsyncClient(timeout=settings.timeout_seconds)
    app.state.provider = create_model_provider(settings, app.state.client)
    try:
        yield
    finally:
        await app.state.client.aclose()


app = FastAPI(title="NuExtract3 extraction server", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

JSONL_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}

class JsonLineEvent(BaseModel):
    event: str
    data: dict[str, Any]


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


def quote_bare_hyphenated_numbers(payload: str) -> str:
    """Quote JSON-like ID values such as 8-1 without touching string content."""
    output: list[str] = []
    in_string = False
    escaped = False
    last_significant: str | None = None
    index = 0
    while index < len(payload):
        char = payload[index]
        if in_string:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
                last_significant = '"'
            index += 1
            continue

        if char == '"':
            in_string = True
            output.append(char)
            index += 1
            continue
        if char.isspace():
            output.append(char)
            index += 1
            continue
        if last_significant in {":", "[", ","} and (char.isdigit() or char == "-"):
            end = index + 1
            while end < len(payload) and (
                payload[end].isdigit() or payload[end] == "-"
            ):
                end += 1
            token = payload[index:end]
            next_index = end
            while next_index < len(payload) and payload[next_index].isspace():
                next_index += 1
            if (
                re.fullmatch(r"-?\d+(?:-\d+)+", token)
                and next_index < len(payload)
                and payload[next_index] in {",", "}", "]"}
            ):
                output.append(json.dumps(token))
                last_significant = '"'
                index = end
                continue

        output.append(char)
        last_significant = char
        index += 1

    return "".join(output)


def parse_repaired_json_result(answer: str) -> Any:
    repaired = quote_bare_hyphenated_numbers(answer)
    candidates = [repaired]
    stripped = repaired.strip()
    if stripped.startswith("{"):
        candidates.append(f"[{stripped}")
        if stripped.endswith("}"):
            candidates.append(f"[{stripped}]")

    for candidate in candidates:
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass
    raise ValueError("Model returned invalid JSON for the extraction result")


def parse_json_object_result(answer: str) -> dict[str, Any]:
    try:
        result = json.loads(answer)
    except json.JSONDecodeError:
        result = parse_repaired_json_result(answer)
    if not isinstance(result, dict):
        if isinstance(result, list):
            return {"items": result}
        raise ValueError("Model returned a JSON value instead of an object")
    return result


class JSONLResponse(StreamingResponse):
    media_type = "application/jsonl"


STREAM_RESPONSES: dict[int | str, dict[str, Any]] = {
    200: {
        "description": (
            "JSON Lines stream of JsonLineEvent objects. Clients that accept "
            "only application/json (e.g. Swagger UI) get a buffered array."
        ),
        "content": {
            "application/json": {"schema": {"type": "array"}},
            "application/jsonl": {"schema": {"type": "string"}},
        },
    }
}


async def catch_model_errors(
    events: AsyncIterator[JsonLineEvent],
) -> AsyncIterator[JsonLineEvent]:
    try:
        async for event in events:
            yield event
    except httpx.HTTPError as exc:
        yield JsonLineEvent(
            event="error", data={"detail": f"Model endpoint error: {exc}"}
        )


async def jsonl_response(
    request: Request, events: AsyncIterator[JsonLineEvent]
) -> Response:
    events = catch_model_errors(events)
    accept = request.headers.get("accept", "")
    if "application/json" in accept and "application/jsonl" not in accept:
        return JSONResponse(
            [event.model_dump(mode="json") async for event in events],
            headers=JSONL_HEADERS,
        )
    return JSONLResponse(
        (f"{event.model_dump_json()}\n" async for event in events),
        headers=JSONL_HEADERS,
    )


def get_model_provider() -> ModelProvider:
    return app.state.provider


async def call_model_stream(
    content: ChatContent,
    chat_kwargs: dict[str, Any],
    temperature: float,
    model: str | None = None,
) -> AsyncIterator[tuple[str, str]]:
    """Yield (reasoning_delta, content_delta) for each streamed chunk."""
    async for delta in get_model_provider().stream_chat(
        content, chat_kwargs, temperature, model=model
    ):
        yield delta


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
            yield JsonLineEvent(
                event="delta",
                data={**base, "think": think_delta, "output": output_delta},
            )
    tail = splitter.close()
    if tail:
        yield JsonLineEvent(event="delta", data={**base, "think": tail, "output": ""})


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


async def extract_events(
    content: list[dict[str, Any]],
    chat_kwargs: dict[str, Any],
    temperature: float,
    reasoning: bool,
    pages: int,
) -> AsyncIterator[JsonLineEvent]:
    splitter = ThinkSplitter(reasoning)
    async for event in jsonl_delta_events(
        splitter, call_model_stream(content, chat_kwargs, temperature)
    ):
        yield event
    think = splitter.think.strip()
    answer = extract_answer_block(splitter.output)
    raw = (
        f"{splitter.think}\n</think>\n{splitter.output}"
        if think
        else splitter.output
    )
    if chat_kwargs.get("mode") == "structured":
        try:
            result = parse_json_object_result(answer)
        except ValueError as exc:
            yield JsonLineEvent(event="error", data={"detail": str(exc), "raw": raw})
            return
    else:
        result = parse_result(answer)
    yield JsonLineEvent(
        event="done",
        data={
            "result": result,
            "reasoning": think or None,
            "raw": raw,
            "pages": pages,
        },
    )


async def chat_events(
    content: list[dict[str, Any]],
    chat_kwargs: dict[str, Any],
    temperature: float,
    reasoning: bool,
) -> AsyncIterator[JsonLineEvent]:
    splitter = ThinkSplitter(reasoning)
    async for event in jsonl_delta_events(
        splitter, call_model_stream(content, chat_kwargs, temperature)
    ):
        yield event
    message = splitter.output.strip()
    yield JsonLineEvent(
        event="done",
        data={
            "message": message,
            "reasoning": splitter.think.strip() or None,
            "raw": splitter.output,
        },
    )


@app.post("/chat", responses=STREAM_RESPONSES)
async def chat(
    request: Request,
    text: str | None = Form(None),
    reasoning: bool = Form(False),
    temperature: float | None = Form(None),
) -> Response:
    text = (text or "").strip()
    if not text:
        raise HTTPException(400, "Provide chat text")

    content = [{"type": "text", "text": text}]
    chat_kwargs: dict[str, Any] = {"enable_thinking": reasoning}
    return await jsonl_response(
        request,
        chat_events(
            content,
            chat_kwargs,
            resolve_temperature(temperature, reasoning),
            reasoning,
        ),
    )


@app.post("/extract", responses=STREAM_RESPONSES)
async def extract(
    request: Request,
    file: UploadFile | None = None,
    text: str | None = Form(None),
    template: str | None = Form(None),
    instruction: str | None = Form(None),
    reasoning: bool = Form(False),
    temperature: float | None = Form(None),
) -> Response:
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
    embedded_extra_text = extra_text

    if file is not None:
        jpeg_pages = pages_to_jpeg(await file.read(), file.content_type)
        content = make_image_content(jpeg_pages, embedded_extra_text)
    else:
        jpeg_pages = []
        content = [
            {
                "type": "text",
                "text": (
                    f"{text}\n\n{embedded_extra_text}"
                    if embedded_extra_text
                    else text
                ),
            }
        ]

    chat_kwargs: dict[str, Any] = {
        "mode": "structured" if use_structured else "content",
        "enable_thinking": reasoning,
    }
    if use_structured:
        chat_kwargs["template"] = template_json
    if instruction:
        chat_kwargs["instructions"] = instruction

    return await jsonl_response(
        request,
        extract_events(
            content,
            chat_kwargs,
            resolve_temperature(temperature, reasoning),
            reasoning,
            len(jpeg_pages),
        ),
    )


async def markdown_events(
    jpeg_pages: list[bytes],
    chat_kwargs: dict[str, Any],
    temperature: float,
    reasoning: bool,
) -> AsyncIterator[JsonLineEvent]:
    results = []
    for index, page in enumerate(jpeg_pages):
        page_content = make_image_content([page], None)
        splitter = ThinkSplitter(reasoning)
        async for event in jsonl_delta_events(
            splitter,
            call_model_stream(page_content, chat_kwargs, temperature),
            extra={"page": index},
        ):
            yield event
        output = splitter.output.strip()
        results.append(output)
        yield JsonLineEvent(
            event="page_done",
            data={
                "page": index,
                "markdown": output,
                "reasoning": splitter.think.strip() or None,
            },
        )
    yield JsonLineEvent(event="done", data={"pages": results, "count": len(results)})


@app.post("/markdown", responses=STREAM_RESPONSES)
async def markdown(
    request: Request,
    file: UploadFile,
    reasoning: bool = Form(False),
    temperature: float | None = Form(None),
) -> Response:
    jpeg_pages = pages_to_jpeg(await file.read(), file.content_type)
    chat_kwargs: dict[str, Any] = {"mode": "markdown", "enable_thinking": reasoning}
    return await jsonl_response(
        request,
        markdown_events(
            jpeg_pages,
            chat_kwargs,
            resolve_temperature(temperature, reasoning),
            reasoning,
        ),
    )


TEMPLATE_GUIDANCE = (
    "Generate a concise JSON extraction template for this document. "
    "Use descriptive field names and simple type hints like string, "
    "number, YYYY-MM-DD, boolean, or arrays of objects. Return only "
    "the JSON template."
)

ANNOTATION_MODES = ("hints", "fields")


class TemplateAnnotation(BaseModel):
    text: str
    pageNumber: int


TEMPLATE_ANNOTATIONS = TypeAdapter(list[TemplateAnnotation])


def parse_annotations(annotations: str | None) -> list[TemplateAnnotation]:
    if not annotations:
        return []
    try:
        return TEMPLATE_ANNOTATIONS.validate_json(annotations)
    except ValidationError as error:
        raise HTTPException(
            400, f"annotations must be a JSON array of {{text, pageNumber}} objects: {error}"
        ) from error


def template_guidance(annotations: list[TemplateAnnotation], mode: str) -> str:
    if not annotations:
        return TEMPLATE_GUIDANCE
    lines = "\n".join(
        f"- page {item.pageNumber}: {item.text}" for item in annotations
    )
    if mode == "fields":
        instruction = (
            "Build the template primarily from these highlights - derive the "
            "fields from the highlighted information, using the rest of the "
            "document only as context."
        )
    else:
        instruction = (
            "Design the template from the whole document, but make sure every "
            "highlighted piece of information is covered by a field."
        )
    return (
        f"{TEMPLATE_GUIDANCE}\n\n"
        f"The user highlighted these passages in the document:\n{lines}\n"
        f"{instruction}"
    )


async def generate_template_events(
    content: ChatContent,
    chat_kwargs: dict[str, Any],
    temperature: float,
    pages: int,
    model: str | None = None,
) -> AsyncIterator[JsonLineEvent]:
    splitter = ThinkSplitter(False)
    async for event in jsonl_delta_events(
        splitter, call_model_stream(content, chat_kwargs, temperature, model=model)
    ):
        yield event
    template = parse_result(pretty_json_or_text(splitter.output))
    yield JsonLineEvent(
        event="done",
        data={"template": template, "raw": splitter.output, "pages": pages},
    )


@app.post("/generate-template", responses=STREAM_RESPONSES)
async def generate_template(
    request: Request,
    file: UploadFile | None = None,
    text: str | None = Form(None),
    temperature: float | None = Form(None),
    annotations: str | None = Form(None),
    annotations_mode: str | None = Form(None),
) -> Response:
    text = (text or "").strip()
    mode = annotations_mode or "hints"
    if mode not in ANNOTATION_MODES:
        raise HTTPException(400, f"annotations_mode must be one of {ANNOTATION_MODES}")
    guidance = template_guidance(parse_annotations(annotations), mode)

    chat_kwargs: dict[str, Any] = {"mode": "template-generation", "enable_thinking": False}
    model = settings.schema_model
    if file is not None:
        jpeg_pages = pages_to_jpeg(await file.read(), file.content_type)
        content = make_image_content(jpeg_pages, guidance)
        model = None
    else:
        jpeg_pages = []
        content = [{"type": "text", "text": f"{text}\n\n{guidance}" if text else guidance}]

    return await jsonl_response(
        request,
        generate_template_events(
            content,
            chat_kwargs,
            resolve_temperature(temperature, False),
            len(jpeg_pages),
            model=model,
        ),
    )

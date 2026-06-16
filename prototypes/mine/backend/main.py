import base64
import hashlib
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
from PIL import Image
from pydantic import BaseModel, TypeAdapter, ValidationError, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="NUEXTRACT3_", env_file=".env")

    provider: Literal["ollama", "openai"] = "ollama"
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

client: httpx.AsyncClient


@asynccontextmanager
async def lifespan(app: FastAPI):
    global client
    client = httpx.AsyncClient(timeout=settings.timeout_seconds)
    yield
    await client.aclose()


app = FastAPI(title="NuExtract3 extraction server", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

JSONL_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}

# In-memory document store (prototype — cleared on restart)
_pdf_cache: dict[str, bytes] = {}        # doc_hash → raw PDF bytes
_pdf_text: dict[str, list[str]] = {}     # doc_hash → [page_0_text, page_1_text, ...]


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


def model_api_base_url(base_url: str, provider: str) -> str:
    """Return the OpenAI-compatible API base URL for the configured provider."""
    normalized = base_url.rstrip("/")
    if provider == "ollama" and not normalized.endswith("/v1"):
        return f"{normalized}/v1"
    return normalized


def chat_completions_url() -> str:
    return f"{model_api_base_url(settings.base_url, settings.provider)}/chat/completions"


def model_headers(api_key: str) -> dict[str, str]:
    key = api_key.strip()
    if not key or key.upper() == "EMPTY":
        return {}
    return {"Authorization": f"Bearer {key}"}


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


def build_payload(
    content: list[dict[str, Any]],
    chat_kwargs: dict[str, Any],
    temperature: float,
    stream: bool,
    model: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": model or settings.model,
        "temperature": temperature,
        "max_tokens": settings.max_tokens,
        "stream": stream,
        "messages": [
            {"role": "system", "content": settings.system_prompt},
        ],
    }
    if settings.provider == "ollama":
        payload["messages"].append(
            {"role": "user", "content": ollama_content(content, chat_kwargs)}
        )
        if chat_kwargs.get("enable_thinking"):
            payload["reasoning"] = {"effort": "medium"}
    else:
        payload["messages"].append({"role": "user", "content": content})
        payload["chat_template_kwargs"] = chat_kwargs
    return payload


def ollama_content(
    content: list[dict[str, Any]], chat_kwargs: dict[str, Any]
) -> list[dict[str, Any]]:
    task_prompt = ollama_task_prompt(chat_kwargs)
    if not task_prompt:
        return content
    return [{"type": "text", "text": task_prompt}, *content]


def ollama_task_prompt(chat_kwargs: dict[str, Any]) -> str:
    mode = chat_kwargs.get("mode")
    if mode == "markdown":
        return (
            "Convert the supplied document page or image to faithful Markdown. "
            "Preserve reading order, headings, tables, lists, and visible text. "
            "Return only Markdown."
        )
    if mode == "template-generation":
        return (
            "Generate an extraction template for the supplied document or text. "
            "Return only a valid JSON object. Use concise field names and simple "
            "type hints such as string, number, YYYY-MM-DD, boolean, or arrays "
            "of objects."
        )
    if mode == "structured":
        return (
            "Extract source-grounded information from the supplied document or "
            "text using the extraction template and instructions. Return the "
            "final answer inside <answer>...</answer>. The answer content must "
            "be valid JSON matching the requested template."
        )
    if mode == "content":
        return (
            "Extract source-grounded information from the supplied document or "
            "text using any provided instructions. Return the final answer "
            "inside <answer>...</answer>."
        )
    return ""


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
    model: str | None = None,
) -> AsyncIterator[tuple[str, str]]:
    """Yield (reasoning_delta, content_delta) for each streamed chunk."""
    payload = build_payload(content, chat_kwargs, temperature, stream=True, model=model)
    async with client.stream(
        "POST",
        chat_completions_url(),
        json=payload,
        headers=model_headers(settings.api_key),
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
    yield JsonLineEvent(
        event="done",
        data={
            "result": parse_result(answer),
            "reasoning": think or None,
            "raw": raw,
            "pages": pages,
        },
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

    if file is not None:
        jpeg_pages = pages_to_jpeg(await file.read(), file.content_type)
        content = make_image_content(jpeg_pages, extra_text)
    else:
        jpeg_pages = []
        content = [
            {"type": "text", "text": f"{text}\n\n{extra_text}" if extra_text else text}
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
    guidance: str,
    temperature: float,
) -> AsyncIterator[JsonLineEvent]:
    content = [{"type": "text", "text": guidance}]
    chat_kwargs: dict[str, Any] = {"mode": "template-generation", "enable_thinking": False}
    splitter = ThinkSplitter(False)
    async for event in jsonl_delta_events(
        splitter, call_model_stream(content, chat_kwargs, temperature, model=settings.schema_model)
    ):
        yield event
    template = parse_result(pretty_json_or_text(splitter.output))
    yield JsonLineEvent(
        event="done",
        data={"template": template, "raw": splitter.output, "pages": 0},
    )


@app.post("/generate-template", responses=STREAM_RESPONSES)
async def generate_template(
    request: Request,
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
    if text:
        guidance = f"{text}\n\n{guidance}"
    return await jsonl_response(
        request,
        generate_template_events(guidance, resolve_temperature(temperature, False)),
    )


# ---------------------------------------------------------------------------
# Document preparation (Phase 1)
# ---------------------------------------------------------------------------

class DocumentRecord(BaseModel):
    doc_hash: str
    filename: str
    page_count: int
    has_text_layer: bool


@app.post("/documents/prepare")
async def prepare_document(file: UploadFile) -> DocumentRecord:
    data = await file.read()
    if not (data.startswith(b"%PDF") or (file.content_type or "").startswith("application/pdf")):
        raise HTTPException(400, "Only PDF files are supported")

    doc_hash = hashlib.sha256(data).hexdigest()
    if doc_hash not in _pdf_cache:
        pdf = pdfium.PdfDocument(data)
        pages_text: list[str] = []
        try:
            for page in pdf:
                try:
                    text = page.get_textpage().get_text_range()
                    pages_text.append(text or "")
                except Exception:
                    pages_text.append("")
            page_count = len(pdf)
        finally:
            pdf.close()

        _pdf_cache[doc_hash] = data
        _pdf_text[doc_hash] = pages_text

    stored_pages = _pdf_text[doc_hash]
    has_text_layer = any(t.strip() for t in stored_pages)
    return DocumentRecord(
        doc_hash=doc_hash,
        filename=file.filename or "document.pdf",
        page_count=len(stored_pages),
        has_text_layer=has_text_layer,
    )


# ---------------------------------------------------------------------------
# Per-selection extraction (Phase 2 → 4 shortcut)
# ---------------------------------------------------------------------------

_SELECTION_TEMPLATE = json.dumps(
    {"find_type": "string", "description": "string", "location": "string", "period": "string"},
    indent=4,
)

_CONTEXT_WINDOW = 600  # characters on each side of the selection


def _surrounding_context(page_text: str, selection: str, window: int) -> str:
    idx = page_text.find(selection)
    if idx == -1:
        return selection
    start = max(0, idx - window)
    end = min(len(page_text), idx + len(selection) + window)
    return page_text[start:end].strip()


@app.post("/extract-selection", responses=STREAM_RESPONSES)
async def extract_selection(
    request: Request,
    doc_hash: str = Form(...),
    selection: str = Form(...),
    page_number: int = Form(...),
    template: str | None = Form(None),
    reasoning: bool = Form(False),
    temperature: float | None = Form(None),
) -> Response:
    if doc_hash not in _pdf_text:
        raise HTTPException(404, "Document not found — call /documents/prepare first")

    page_idx = page_number - 1
    pages = _pdf_text[doc_hash]
    if page_idx < 0 or page_idx >= len(pages):
        raise HTTPException(400, f"page_number {page_number} out of range (document has {len(pages)} pages)")

    context = _surrounding_context(pages[page_idx], selection, _CONTEXT_WINDOW)
    template_json = normalize_template(template) if template else _SELECTION_TEMPLATE

    prompt = (
        f"Context (page {page_number}):\n{context}\n\n"
        f"Highlighted selection: {selection}\n\n"
        f"Extraction template:\n```json\n{template_json}\n```"
    )
    content = [{"type": "text", "text": prompt}]
    chat_kwargs: dict[str, Any] = {
        "mode": "structured",
        "enable_thinking": reasoning,
        "template": template_json,
    }
    return await jsonl_response(
        request,
        extract_events(content, chat_kwargs, resolve_temperature(temperature, reasoning), reasoning, 0),
    )

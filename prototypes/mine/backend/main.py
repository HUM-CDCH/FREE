import base64
import io
import json
import re
from typing import Any

import httpx
import pypdfium2 as pdfium
from fastapi import FastAPI, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="NUEXTRACT3_", env_file=".env")

    base_url: str = "http://127.0.0.1:12434/engines/v1"
    model: str = "hf.co/numind/NuExtract3-GGUF:mmproj"
    api_key: str = "EMPTY"
    timeout_seconds: float = 120
    pdf_dpi: int = 64
    temperature: float = 0


settings = Settings()

app = FastAPI(title="NuExtract3 extraction server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


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


def extract_answer(text: str) -> tuple[Any, str | None]:
    """Split reasoning from the answer and parse JSON when present."""
    reasoning = None
    match = re.search(r"<think>(.*?)</think>", text, re.DOTALL)
    if match:
        reasoning = match.group(1).strip()
        text = text[match.end():].strip()

    match = re.search(r"<answer>(.*?)(?:</answer>|$)", text, re.DOTALL)
    answer = match.group(1).strip() if match else text.strip()
    answer = re.sub(r"^```(?:json)?\s*|\s*```$", "", answer)

    start, end = answer.find("{"), answer.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(answer[start : end + 1]), reasoning
        except json.JSONDecodeError:
            pass
    return answer, reasoning


async def call_model(content: list[dict[str, Any]], chat_kwargs: dict[str, Any]) -> str:
    payload = {
        "model": settings.model,
        "temperature": settings.temperature,
        "messages": [{"role": "user", "content": content}],
        "chat_template_kwargs": chat_kwargs,
    }
    async with httpx.AsyncClient(timeout=settings.timeout_seconds) as client:
        try:
            response = await client.post(
                f"{settings.base_url.rstrip('/')}/chat/completions",
                json=payload,
                headers={"Authorization": f"Bearer {settings.api_key}"},
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise HTTPException(502, f"Model endpoint error: {exc}")
    return response.json()["choices"][0]["message"]["content"] or ""


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.post("/extract")
async def extract(
    file: UploadFile,
    template: str | None = Form(None),
    instruction: str | None = Form(None),
    reasoning: bool = Form(False),
):
    template = (template or "").strip()
    if template and template != "{}":
        try:
            template = json.dumps(json.loads(template), indent=4)
        except json.JSONDecodeError:
            raise HTTPException(400, "template is not valid JSON")
    else:
        template = ""
    instruction = (instruction or "").strip()

    jpeg_pages = pages_to_jpeg(await file.read(), file.content_type)

    extra_parts = []
    if instruction:
        extra_parts.append(f"Instructions:\n{instruction}")
    if template:
        extra_parts.append(f"Extraction template:\n```json\n{template}\n```")

    chat_kwargs: dict[str, Any] = {
        "mode": "structured" if template else "content",
        "enable_thinking": reasoning,
    }
    if template:
        chat_kwargs["template"] = template
    if instruction:
        chat_kwargs["instructions"] = instruction

    raw = await call_model(
        make_image_content(jpeg_pages, "\n\n".join(extra_parts) or None), chat_kwargs
    )
    result, think = extract_answer(raw)
    return {"result": result, "reasoning": think, "raw": raw, "pages": len(jpeg_pages)}


TEMPLATE_GUIDANCE = (
    "Generate a concise JSON extraction template for this document. "
    "Use descriptive field names and simple type hints like string, "
    "number, YYYY-MM-DD, boolean, or arrays of objects. Return only "
    "the JSON template."
)


@app.post("/generate-template")
async def generate_template(
    file: UploadFile,
    instruction: str | None = Form(None),
):
    instruction = (instruction or "").strip()
    jpeg_pages = pages_to_jpeg(await file.read(), file.content_type)

    extra_text = TEMPLATE_GUIDANCE
    if instruction:
        extra_text = f"Instructions:\n{instruction}\n\n{extra_text}"

    # the chat template defaults enable_thinking to true, which this mode forbids
    chat_kwargs: dict[str, Any] = {"mode": "template-generation", "enable_thinking": False}
    if instruction:
        chat_kwargs["instructions"] = instruction

    raw = await call_model(make_image_content(jpeg_pages, extra_text), chat_kwargs)
    template, _ = extract_answer(raw)
    return {"template": template, "raw": raw, "pages": len(jpeg_pages)}

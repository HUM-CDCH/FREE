from typing import Any

import httpx
from fastapi import APIRouter, Form, HTTPException, Response, UploadFile
from fastapi.responses import JSONResponse

from shared.model_call import ModelCall, ResultParseError, Result
from shared.model_stream import call_model_stream
from shared.parsing import normalize_template
from shared.pdf import make_image_content, pages_to_jpeg
from shared.result_parsers import AnswerParser, StructuredParser
from shared.streaming import JSON_RESPONSES
from shared.temperature import ReasoningTemperature
from shared.think_splitter import ThinkSplitter

router = APIRouter()


def _reconstruct_raw(output: str, reasoning: str | None) -> str:
    """Preserve the prior raw shape: reasoning is wrapped in a </think> marker
    ahead of the answer; without reasoning the output is used verbatim."""
    return f"{reasoning}\n</think>\n{output}" if reasoning else output


@router.post("/extract", responses=JSON_RESPONSES)
async def extract(
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

    call = ModelCall(
        temperature=ReasoningTemperature(),
        splitter=ThinkSplitter,
        parser=StructuredParser() if use_structured else AnswerParser(),
    )
    try:
        result: Result = await call.collect(
            call_model_stream,
            content,
            chat_kwargs,
            reasoning=reasoning,
            temperature=temperature,
        )
    except ResultParseError as exc:
        raise HTTPException(
            502,
            detail={
                "message": str(exc),
                "raw": _reconstruct_raw(exc.output, exc.reasoning),
            },
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(502, detail=f"Model endpoint error: {exc}") from exc

    return JSONResponse(
        {
            "result": result.value,
            "reasoning": result.reasoning,
            "raw": _reconstruct_raw(result.output, result.reasoning),
            "pages": len(jpeg_pages),
        }
    )

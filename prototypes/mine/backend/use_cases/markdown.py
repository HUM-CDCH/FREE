from typing import Any

import httpx
from fastapi import APIRouter, Form, HTTPException, Response, UploadFile
from fastapi.responses import JSONResponse

from shared.model_call import ModelCall
from shared.model_stream import call_model_stream
from shared.pdf import make_image_content, pages_to_jpeg
from shared.streaming import JSON_RESPONSES
from shared.temperature import ReasoningTemperature
from shared.think_splitter import ThinkSplitter

router = APIRouter()

MARKDOWN_CALL = ModelCall(temperature=ReasoningTemperature(), splitter=ThinkSplitter)


@router.post("/markdown", responses=JSON_RESPONSES)
async def markdown(
    file: UploadFile,
    reasoning: bool = Form(False),
    temperature: float | None = Form(None),
) -> Response:
    jpeg_pages = pages_to_jpeg(await file.read(), file.content_type)
    # Per the NuExtract3 model card, send every page image in one call, in page
    # order — the same one-call pattern /extract uses.
    content = make_image_content(jpeg_pages, None)
    chat_kwargs: dict[str, Any] = {"mode": "markdown", "enable_thinking": reasoning}

    try:
        result = await MARKDOWN_CALL.collect(
            call_model_stream,
            content,
            chat_kwargs,
            reasoning=reasoning,
            temperature=temperature,
        )
    except httpx.HTTPError as exc:
        raise HTTPException(502, detail=f"Model endpoint error: {exc}") from exc

    return JSONResponse({"markdown": result.output.strip(), "pages": len(jpeg_pages)})

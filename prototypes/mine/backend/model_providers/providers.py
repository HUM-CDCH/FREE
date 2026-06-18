import json
from collections.abc import AsyncIterator
from typing import Any

import httpx

from model_providers.base import ChatDelta
from shared.request_compiler import PreparedProviderRequest


def chat_delta_to_text(chunk: dict[str, Any]) -> ChatDelta:
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


class ModelProviderError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        raw_detail: str,
        cause: BaseException,
        status_code: int | None = None,
        url: str | None = None,
    ) -> None:
        super().__init__(message)
        self.raw_detail = raw_detail
        self.status_code = status_code
        self.url = url
        self.__cause__ = cause


class ProviderHTTPTransport:
    def __init__(self, client: httpx.AsyncClient):
        self._client = client

    async def stream(
        self, prepared: PreparedProviderRequest
    ) -> AsyncIterator[ChatDelta]:
        try:
            async with self._client.stream(
                "POST",
                prepared.url,
                json=dict(prepared.payload),
                headers=dict(prepared.headers),
            ) as response:
                try:
                    response.raise_for_status()
                except httpx.HTTPStatusError as exc:
                    body = (await response.aread()).decode(errors="replace").strip()
                    detail = (
                        f"HTTP {response.status_code} {response.reason_phrase} "
                        f"from {response.url}"
                    )
                    if body:
                        detail = f"{detail}\n\n{body}"
                    raise ModelProviderError(
                        f"Model endpoint error: {detail}",
                        raw_detail=detail,
                        cause=exc,
                        status_code=response.status_code,
                        url=str(response.url),
                    ) from exc
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
                    reasoning_delta, content_delta = chat_delta_to_text(chunk)
                    if reasoning_delta or content_delta:
                        yield reasoning_delta, content_delta
        except httpx.HTTPError as exc:
            raise ModelProviderError(
                f"Model endpoint error: {exc}", raw_detail=str(exc), cause=exc
            ) from exc

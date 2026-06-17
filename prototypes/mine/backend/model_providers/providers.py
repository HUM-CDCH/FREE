import json
from collections.abc import AsyncIterator
from typing import Any

import httpx

from model_providers.base import ChatContent, ChatDelta, ModelProvider, ProviderSettings


def model_headers(api_key: str) -> dict[str, str]:
    key = api_key.strip()
    if not key or key.upper() == "EMPTY":
        return {}
    return {"Authorization": f"Bearer {key}"}


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


class OpenAICompatibleProvider(ModelProvider):
    def __init__(self, settings: ProviderSettings, client: httpx.AsyncClient):
        self.settings = settings
        self.client = client

    def api_base_url(self) -> str:
        return self.settings.base_url.rstrip("/")

    def chat_completions_url(self) -> str:
        return f"{self.api_base_url()}/chat/completions"

    def headers(self) -> dict[str, str]:
        return model_headers(self.settings.api_key)

    def build_payload(
        self,
        content: ChatContent,
        template_kwargs: dict[str, Any],
        temperature: float,
        stream: bool,
    ) -> dict[str, Any]:
        return {
            "model": self.settings.model,
            "temperature": temperature,
            "max_tokens": self.settings.max_tokens,
            "stream": stream,
            "messages": [
                {"role": "system", "content": self.settings.system_prompt},
                {"role": "user", "content": content},
            ],
            "chat_template_kwargs": template_kwargs,
        }

    async def stream_chat(
        self,
        content: ChatContent,
        template_kwargs: dict[str, Any],
        temperature: float,
    ) -> AsyncIterator[ChatDelta]:
        payload = self.build_payload(
            content, template_kwargs, temperature, stream=True
        )
        async with self.client.stream(
            "POST",
            self.chat_completions_url(),
            json=payload,
            headers=self.headers(),
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
                raise httpx.HTTPStatusError(
                    detail, request=exc.request, response=exc.response
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


class OllamaProvider(OpenAICompatibleProvider):
    def api_base_url(self) -> str:
        normalized = self.settings.base_url.rstrip("/")
        if not normalized.endswith("/v1"):
            return f"{normalized}/v1"
        return normalized

    def build_payload(
        self,
        content: ChatContent,
        template_kwargs: dict[str, Any],
        temperature: float,
        stream: bool,
    ) -> dict[str, Any]:
        payload = super().build_payload(
            content, template_kwargs, temperature, stream
        )
        if template_kwargs.get("enable_thinking"):
            payload["reasoning"] = {"effort": "medium"}
        return payload


def create_model_provider(
    settings: ProviderSettings, client: httpx.AsyncClient
) -> ModelProvider:
    if settings.provider == "ollama":
        return OllamaProvider(settings, client)
    if settings.provider in {"vllm", "openai"}:
        return OpenAICompatibleProvider(settings, client)
    raise ValueError(f"Unsupported model provider: {settings.provider}")

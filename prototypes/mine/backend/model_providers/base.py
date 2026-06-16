from collections.abc import AsyncIterator
from typing import Any, Literal, Protocol

import httpx

ChatContent = list[dict[str, Any]]
ChatDelta = tuple[str, str]


class ProviderSettings(Protocol):
    provider: Literal["ollama", "vllm", "openai"]
    base_url: str
    model: str
    api_key: str
    max_tokens: int
    system_prompt: str


class ModelProvider(Protocol):
    settings: ProviderSettings
    client: httpx.AsyncClient

    async def stream_chat(
        self,
        content: ChatContent,
        chat_kwargs: dict[str, Any],
        temperature: float,
        model: str | None = None,
    ) -> AsyncIterator[ChatDelta]:
        """Yield streamed model deltas as (reasoning_delta, content_delta)."""

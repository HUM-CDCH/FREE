from collections.abc import AsyncIterator
from typing import Any

from model_providers import ChatContent, ModelProvider

_provider: ModelProvider | None = None


def bind_provider(provider: ModelProvider) -> None:
    """Bind the process-wide model provider, called once at app startup."""
    global _provider
    _provider = provider


def get_model_provider() -> ModelProvider:
    if _provider is None:
        raise RuntimeError(
            "Model provider is not bound; call bind_provider() during app startup"
        )
    return _provider


async def call_model_stream(
    content: ChatContent,
    chat_kwargs: dict[str, Any],
    temperature: float,
) -> AsyncIterator[tuple[str, str]]:
    """Yield (reasoning_delta, content_delta) for each streamed chunk."""
    async for delta in get_model_provider().stream_chat(
        content, chat_kwargs, temperature
    ):
        yield delta

from typing import Any, Literal, Protocol

ChatContent = list[dict[str, Any]]
ChatDelta = tuple[str, str]


class ProviderSettings(Protocol):
    provider: Literal["ollama", "vllm", "openai"]
    base_url: str
    model: str
    api_key: str
    max_tokens: int
    system_prompt: str

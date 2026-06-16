from typing import Any, Literal

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="NUEXTRACT3_", env_file=".env")

    provider: Literal["ollama", "vllm", "openai"] = "ollama"
    base_url: str = "http://127.0.0.1:11434"
    model: str = "nuextract"          # vision model: PDF images → extracted data
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

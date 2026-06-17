from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx

from model_providers import ChatContent, ModelProvider
from shared.model_call import ModelCall, Result
from shared.result_parsers import ResultParser
from shared.temperature import TemperaturePolicy
from shared.think_splitter import ThinkSplitter


@dataclass(frozen=True, slots=True)
class ModelRequest:
    content: ChatContent
    template_kwargs: dict[str, Any]
    reasoning: bool = False
    temperature: float | None = None


class ModelGatewayError(RuntimeError):
    def __init__(self, message: str, *, raw_detail: str, cause: BaseException) -> None:
        super().__init__(message)
        self.raw_detail = raw_detail
        self.__cause__ = cause


class ModelGateway:
    def __init__(
        self,
        provider: ModelProvider,
        *,
        temperature: TemperaturePolicy,
        splitter: type[ThinkSplitter] = ThinkSplitter,
    ) -> None:
        self._provider = provider
        self._temperature = temperature
        self._splitter = splitter

    async def _stream_provider(
        self,
        content: ChatContent,
        template_kwargs: dict[str, Any],
        temperature: float,
    ) -> AsyncIterator[tuple[str, str]]:
        try:
            async for delta in self._provider.stream_chat(
                content, template_kwargs, temperature
            ):
                yield delta
        except httpx.HTTPError as exc:
            raise ModelGatewayError(
                f"Model endpoint error: {exc}", raw_detail=str(exc), cause=exc
            ) from exc

    def _call(self, parser: ResultParser | None) -> ModelCall:
        return ModelCall(
            temperature=self._temperature,
            parser=parser,
            splitter=self._splitter,
        )

    async def collect(
        self,
        request: ModelRequest,
        *,
        parser: ResultParser | None = None,
    ) -> Result:
        try:
            return await self._call(parser).collect(
                self._stream_provider,
                request.content,
                request.template_kwargs,
                reasoning=request.reasoning,
                temperature=request.temperature,
            )
        except httpx.HTTPError as exc:
            raise ModelGatewayError(
                f"Model endpoint error: {exc}", raw_detail=str(exc), cause=exc
            ) from exc

    def stream(
        self,
        request: ModelRequest,
        *,
        parser: ResultParser | None = None,
    ):
        return self._call(parser).stream(
            self._stream_provider,
            request.content,
            request.template_kwargs,
            reasoning=request.reasoning,
            temperature=request.temperature,
        )

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Protocol

from model_providers.base import ChatDelta
from shared.model_command import ModelCommand
from shared.request_compiler import PreparedProviderRequest, RequestCompiler
from shared.result_parsers import ResultParser
from shared.think_splitter import ThinkSplitter


class ProviderTransport(Protocol):
    def stream(self, prepared: PreparedProviderRequest) -> AsyncIterator[ChatDelta]:
        """Yield streamed model deltas as (reasoning_delta, content_delta)."""
        ...


@dataclass
class Result:
    output: str
    reasoning: str | None
    value: Any


class ResultParseError(ValueError):
    def __init__(self, message: str, output: str, reasoning: str | None) -> None:
        super().__init__(message)
        self.output = output
        self.reasoning = reasoning


def _finish(output: str, reasoning: str | None, parser: ResultParser | None) -> Result:
    if parser is None:
        return Result(output=output, reasoning=reasoning, value=output)
    try:
        value = parser.parse(output)
    except ValueError as exc:
        raise ResultParseError(str(exc), output, reasoning) from exc
    return Result(output=output, reasoning=reasoning, value=value)


class _ModelStream:
    def __init__(
        self,
        transport_stream: AsyncIterator[ChatDelta],
        splitter: ThinkSplitter,
        parser: ResultParser | None,
    ) -> None:
        self._transport_stream = transport_stream
        self._splitter = splitter
        self._parser = parser
        self.result: Result | None = None

    async def __aiter__(self) -> AsyncIterator[ChatDelta]:
        async for reasoning_delta, content_delta in self._transport_stream:
            think_delta, output_delta = self._splitter.feed(
                reasoning_delta, content_delta
            )
            if think_delta or output_delta:
                yield think_delta, output_delta
        tail = self._splitter.close()
        if tail:
            yield tail, ""
        self.result = _finish(
            self._splitter.output, self._splitter.think.strip() or None, self._parser
        )


class ModelExecutor:
    def __init__(
        self,
        compiler: RequestCompiler,
        transport: ProviderTransport,
        *,
        splitter: type[ThinkSplitter] = ThinkSplitter,
    ) -> None:
        self._compiler = compiler
        self._transport = transport
        self._splitter = splitter

    def stream(
        self,
        command: ModelCommand,
        *,
        parser: ResultParser | None = None,
    ) -> _ModelStream:
        prepared = self._compiler.compile(command)
        return _ModelStream(
            self._transport.stream(prepared),
            self._splitter(command.reasoning),
            parser,
        )

    async def collect(
        self,
        command: ModelCommand,
        *,
        parser: ResultParser | None = None,
    ) -> Result:
        stream = self.stream(command, parser=parser)
        async for _ in stream:
            pass
        if stream.result is None:
            raise RuntimeError("Model stream ended without producing a result")
        return stream.result

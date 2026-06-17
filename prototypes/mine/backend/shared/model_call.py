from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any

from model_providers import ChatContent
from shared.result_parsers import ResultParser
from shared.temperature import TemperaturePolicy
from shared.think_splitter import ThinkSplitter

# The model-stream collaborator is passed in by the gateway/use case at call
# time so ModelCall stays independent of provider transport details.
ModelStream = Callable[[ChatContent, dict[str, Any], float], AsyncIterator[tuple[str, str]]]


@dataclass
class Result:
    """The completed model call: the answer text, the reasoning (or None), and
    the parsed result value (or the answer text when no parser is set)."""

    output: str
    reasoning: str | None
    value: Any


class ResultParseError(ValueError):
    """A result parser could not parse the model output. Carries the raw output
    and reasoning so the caller can build an error payload (e.g. /extract's 502)."""

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


class _Streamer:
    """Per-request streamer: holds the splitter and accumulation so the shared
    ModelCall stays stateless. Async-iterable over (think, output) delta tuples;
    exposes `.result` once iteration completes."""

    def __init__(
        self,
        model_stream: AsyncIterator[tuple[str, str]],
        splitter: ThinkSplitter,
        parser: ResultParser | None,
    ) -> None:
        self._model_stream = model_stream
        self._splitter = splitter
        self._parser = parser
        self.result: Result | None = None

    async def __aiter__(self) -> AsyncIterator[tuple[str, str]]:
        async for reasoning_delta, content_delta in self._model_stream:
            think_delta, output_delta = self._splitter.feed(reasoning_delta, content_delta)
            if think_delta or output_delta:
                yield think_delta, output_delta
        tail = self._splitter.close()
        if tail:
            yield tail, ""
        self.result = _finish(
            self._splitter.output, self._splitter.think.strip() or None, self._parser
        )


class ModelCall:
    """Uniform composition root over the model-call spine (model stream ->
    reasoning split -> result parse). Composed once from injectable collaborators
    and shared across requests, so it holds no per-request state: per-request
    state lives on the local splitter (collect) or the per-request streamer
    (stream)."""

    def __init__(
        self,
        *,
        temperature: TemperaturePolicy,
        parser: ResultParser | None = None,
        splitter: type[ThinkSplitter] = ThinkSplitter,
    ) -> None:
        self._temperature = temperature
        self._parser = parser
        self._splitter = splitter

    async def collect(
        self,
        model_stream: ModelStream,
        content: ChatContent,
        chat_kwargs: dict[str, Any],
        *,
        reasoning: bool,
        temperature: float | None,
    ) -> Result:
        """Buffered: drive the model stream to completion through a local
        splitter, then parse. Returns a Result — the deterministic test / /docs
        seam."""
        resolved = self._temperature.resolve(temperature, reasoning)
        splitter = self._splitter(reasoning)
        async for reasoning_delta, content_delta in model_stream(content, chat_kwargs, resolved):
            splitter.feed(reasoning_delta, content_delta)
        splitter.close()
        return _finish(splitter.output, splitter.think.strip() or None, self._parser)

    def stream(
        self,
        model_stream: ModelStream,
        content: ChatContent,
        chat_kwargs: dict[str, Any],
        *,
        reasoning: bool,
        temperature: float | None,
    ) -> _Streamer:
        """Streaming: return a per-request streamer, async-iterable over
        (think, output) delta tuples, exposing `.result` after iteration."""
        resolved = self._temperature.resolve(temperature, reasoning)
        return _Streamer(
            model_stream(content, chat_kwargs, resolved),
            self._splitter(reasoning),
            self._parser,
        )

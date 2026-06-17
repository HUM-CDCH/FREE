import asyncio
import unittest

import httpx

from shared.model_gateway import ModelGatewayError
from shared.model_gateway import ModelGateway, ModelRequest
from shared.result_parsers import StructuredParser
from shared.temperature import ReasoningTemperature


class FakeProvider:
    def __init__(
        self,
        chunks=None,
        error: Exception | None = None,
    ) -> None:
        self.calls = []
        self.chunks = chunks or [
            ("", '{"store": "Trader Joe\'s"}'),
        ]
        self.error = error

    async def stream_chat(self, content, chat_kwargs, temperature):
        self.calls.append((content, chat_kwargs, temperature))
        if self.error is not None:
            raise self.error
        for chunk in self.chunks:
            yield chunk


class ModelGatewayTests(unittest.TestCase):
    def test_collect_executes_request_and_accepts_parser_argument(self) -> None:
        provider = FakeProvider(
            chunks=[("reasoning ", ""), ("", '{"store": "Trader Joe\'s"}')]
        )
        gateway = ModelGateway(provider, temperature=ReasoningTemperature())
        request = ModelRequest(
            content=[{"type": "text", "text": "Invoice"}],
            chat_kwargs={"mode": "structured", "enable_thinking": True},
            reasoning=True,
            temperature=None,
        )

        async def drive():
            return await gateway.collect(request, parser=StructuredParser())

        result = asyncio.run(drive())

        self.assertEqual(result.value, {"store": "Trader Joe's"})
        self.assertEqual(result.reasoning, "reasoning")
        self.assertFalse(hasattr(request, "parser"))
        self.assertEqual(
            provider.calls,
            [
                (
                    [{"type": "text", "text": "Invoice"}],
                    {"mode": "structured", "enable_thinking": True},
                    0.6,
                )
            ],
        )

    def test_stream_executes_request_and_exposes_final_result(self) -> None:
        provider = FakeProvider()
        gateway = ModelGateway(provider, temperature=ReasoningTemperature())
        request = ModelRequest(
            content=[{"type": "text", "text": "Invoice"}],
            chat_kwargs={"mode": "structured", "enable_thinking": False},
            reasoning=False,
        )

        async def drive():
            streamer = gateway.stream(request, parser=StructuredParser())
            chunks = [chunk async for chunk in streamer]
            return chunks, streamer.result

        chunks, result = asyncio.run(drive())

        self.assertEqual(chunks, [("", '{"store": "Trader Joe\'s"}')])
        self.assertEqual(result.value, {"store": "Trader Joe's"})

    def test_model_gateway_error_preserves_raw_detail_and_cause(self) -> None:
        cause = httpx.ConnectError("boom")
        gateway = ModelGateway(
            FakeProvider(error=cause), temperature=ReasoningTemperature()
        )
        request = ModelRequest(content=[], chat_kwargs={})

        async def drive():
            return await gateway.collect(request)

        with self.assertRaises(ModelGatewayError) as ctx:
            asyncio.run(drive())

        self.assertEqual(str(ctx.exception), "Model endpoint error: boom")
        self.assertEqual(ctx.exception.raw_detail, "boom")
        self.assertIs(ctx.exception.__cause__, cause)


if __name__ == "__main__":
    unittest.main()

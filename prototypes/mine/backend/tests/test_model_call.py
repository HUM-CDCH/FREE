import asyncio
import unittest

from shared.model_call import ModelCall, ResultParseError
from shared.result_parsers import StructuredParser
from shared.temperature import ReasoningTemperature


def make_stream(chunks):
    """A fresh stream function for each call, so collect() and stream() can each
    drive an independent pass over the same chunks."""

    async def stream(content, template_kwargs, temperature):
        for reasoning_delta, content_delta in chunks:
            yield reasoning_delta, content_delta

    return stream


class ModelCallConsistencyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.call = ModelCall(
            temperature=ReasoningTemperature(), parser=StructuredParser()
        )
        self.chunks = [
            ("the reasoning ", ""),
            ("", '{"store": '),
            ("", '"Trader Joe\'s"}'),
        ]

    def test_collect_equals_accumulated_stream(self) -> None:
        stream_fn = make_stream(self.chunks)

        async def drive():
            collected = await self.call.collect(
                stream_fn, [], {}, reasoning=True, temperature=None
            )

            streamer = self.call.stream(
                stream_fn, [], {}, reasoning=True, temperature=None
            )
            think_acc, output_acc = "", ""
            async for think_delta, output_delta in streamer:
                think_acc += think_delta
                output_acc += output_delta
            return collected, streamer.result, think_acc, output_acc

        collected, streamed, think_acc, output_acc = asyncio.run(drive())

        # collect() and stream() agree on value, reasoning, and raw output.
        self.assertEqual(collected.value, streamed.value)
        self.assertEqual(collected.reasoning, streamed.reasoning)
        self.assertEqual(collected.output, streamed.output)

        # The streamed deltas accumulate back to the buffered result.
        self.assertEqual(output_acc, collected.output)
        self.assertEqual(think_acc.strip() or None, collected.reasoning)

        # And the value is actually the repaired/parsed structure.
        self.assertEqual(collected.value, {"store": "Trader Joe's"})
        self.assertEqual(collected.reasoning, "the reasoning")

    def test_collect_raises_result_parse_error_with_raw(self) -> None:
        stream_fn = make_stream([("", "not json at all")])

        async def drive():
            return await self.call.collect(
                stream_fn, [], {}, reasoning=False, temperature=None
            )

        with self.assertRaises(ResultParseError) as ctx:
            asyncio.run(drive())
        self.assertEqual(ctx.exception.output, "not json at all")
        self.assertEqual(ctx.exception.reasoning, None)


if __name__ == "__main__":
    unittest.main()

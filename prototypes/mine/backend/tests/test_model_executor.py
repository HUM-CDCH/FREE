import asyncio
import inspect
import unittest

from shared.model_command import ChatTask, ModelCommand
from shared.model_executor import ModelExecutor, ResultParseError
from shared.request_compiler import PreparedProviderRequest
from shared.result_parsers import StructuredParser
import shared.model_executor as model_executor_module


class FakeCompiler:
    def __init__(self) -> None:
        self.commands = []

    def compile(self, command):
        self.commands.append(command)
        return PreparedProviderRequest(
            url="http://example.test/v1/chat/completions",
            headers={},
            payload={"call": len(self.commands)},
        )


class FakeTransport:
    def __init__(self, chunks) -> None:
        self.chunks = chunks
        self.prepared = []

    async def stream(self, prepared):
        self.prepared.append(prepared)
        for chunk in self.chunks:
            yield chunk


class ModelExecutorTests(unittest.TestCase):
    def test_collect_equals_accumulated_stream(self) -> None:
        chunks = [("the reasoning ", ""), ("", '{"store": '), ("", '"Trader Joe\'s"}')]
        command = ModelCommand(task=ChatTask(), content=[], reasoning=True)
        compiler = FakeCompiler()
        transport = FakeTransport(chunks)
        executor = ModelExecutor(compiler, transport)

        async def drive():
            collected = await executor.collect(command, parser=StructuredParser())
            streamer = executor.stream(command, parser=StructuredParser())
            think_acc, output_acc = "", ""
            async for think_delta, output_delta in streamer:
                think_acc += think_delta
                output_acc += output_delta
            return collected, streamer.result, think_acc, output_acc

        collected, streamed, think_acc, output_acc = asyncio.run(drive())

        self.assertEqual(collected.value, {"store": "Trader Joe's"})
        self.assertEqual(collected.value, streamed.value)
        self.assertEqual(collected.reasoning, streamed.reasoning)
        self.assertEqual(collected.output, streamed.output)
        self.assertEqual(output_acc, collected.output)
        self.assertEqual(think_acc.strip() or None, collected.reasoning)
        self.assertEqual(compiler.commands, [command, command])
        self.assertEqual(len(transport.prepared), 2)

    def test_collect_raises_result_parse_error_with_raw(self) -> None:
        executor = ModelExecutor(
            FakeCompiler(), FakeTransport([("", "not json at all")])
        )

        async def drive():
            return await executor.collect(
                ModelCommand(task=ChatTask(), content=[]),
                parser=StructuredParser(),
            )

        with self.assertRaises(ResultParseError) as ctx:
            asyncio.run(drive())

        self.assertEqual(ctx.exception.output, "not json at all")
        self.assertEqual(ctx.exception.reasoning, None)

    def test_executor_does_not_own_provider_payload_fields(self) -> None:
        source = inspect.getsource(model_executor_module)

        self.assertNotIn("ReasoningTemperature", source)
        self.assertNotIn(".resolve(", source)
        self.assertNotIn("chat_template_kwargs", source)
        self.assertNotIn("template_kwargs", source)


if __name__ == "__main__":
    unittest.main()

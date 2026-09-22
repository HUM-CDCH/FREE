"""A scripted chat completion for the extraction tests: no server, every call recorded."""
import json
from collections.abc import Callable
from typing import Any

from kei_exp.kie.extract.llm import Reply

Script = Callable[[str, str, dict | None], Any]


class FakeChat:
    """`script(system, user, schema)` answers each call: a JSON-serialisable object becomes the reply's text, a
    `Reply` is returned as is (for truncation and garbage), an exception is raised."""
    model = "fake/extractor"

    def __init__(self, script: Script) -> None:
        self.script = script
        self.calls: list[dict] = []

    def complete(self, *, system: str, user: str, schema: dict | None) -> Reply:
        self.calls.append({"system": system, "user": user, "schema": schema})
        answer = self.script(system, user, schema)
        if isinstance(answer, Reply):
            return answer
        return Reply(text=json.dumps(answer, ensure_ascii=False), input_tokens=10, output_tokens=5, finish="stop",
                     seconds=0.0)

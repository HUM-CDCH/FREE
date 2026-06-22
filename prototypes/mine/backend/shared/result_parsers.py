from typing import Any, Protocol

from shared.json_repair import parse_json_object_result
from shared.parsing import extract_answer_block, parse_result, pretty_json_or_text


class ResultParser(Protocol):
    """Transform raw model output into a use case's result value."""

    def parse(self, output: str) -> Any: ...


class StructuredParser:
    """Structured extraction: pull the answer block, then parse it as a JSON
    object, repairing known NuExtract quirks. Raises ValueError when the output
    cannot be parsed or repaired."""

    def parse(self, output: str) -> Any:
        return parse_json_object_result(extract_answer_block(output))


class AnswerParser:
    """Free-text extraction: pull the answer block, then JSON-decode it when it
    is valid JSON, otherwise return the text unchanged."""

    def parse(self, output: str) -> Any:
        return parse_result(extract_answer_block(output))


class TemplateParser:
    """Schema suggestion: pretty-print the output as JSON when possible, then
    JSON-decode it, otherwise return the text unchanged."""

    def parse(self, output: str) -> Any:
        return parse_result(pretty_json_or_text(output))

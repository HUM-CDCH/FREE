import unittest

from shared.result_parsers import AnswerParser, StructuredParser, TemplateParser


class StructuredParserTests(unittest.TestCase):
    def setUp(self) -> None:
        self.parser = StructuredParser()

    def test_repairs_object_sequence_with_hyphenated_ids(self) -> None:
        result = self.parser.parse(
            '{"Gravnummer": 8, "fund": [{"nummer": 8-1}]}, '
            '{"Gravnummer": 13, "fund": [{"nummer": 13-2}]}'
        )
        self.assertEqual(
            result,
            {
                "items": [
                    {"Gravnummer": 8, "fund": [{"nummer": "8-1"}]},
                    {"Gravnummer": 13, "fund": [{"nummer": "13-2"}]},
                ]
            },
        )

    def test_repairs_missing_opening_array_bracket(self) -> None:
        result = self.parser.parse(
            '{"Gravnummer": 8, "fund": [{"nummer": 8-1}]}, '
            '{"Gravnummer": 13, "fund": [{"nummer": 13-2}]}]'
        )
        self.assertEqual(len(result["items"]), 2)

    def test_repairs_trailing_malformed_field_after_complete_object(self) -> None:
        result = self.parser.parse(
            '{"title": "Grav 8", "summary": "source-grounded text"}, '
            '"summary": null}'
        )
        self.assertEqual(
            result,
            {"title": "Grav 8", "summary": "source-grounded text"},
        )

    def test_pulls_answer_block_before_parsing(self) -> None:
        result = self.parser.parse('<answer>{"store": "Trader Joe\'s"}</answer>')
        self.assertEqual(result, {"store": "Trader Joe's"})

    def test_rejects_irrecoverable_output(self) -> None:
        with self.assertRaises(ValueError) as ctx:
            self.parser.parse("not json at all")
        self.assertEqual(
            str(ctx.exception),
            "Model returned invalid JSON for the extraction result",
        )


class AnswerParserTests(unittest.TestCase):
    def setUp(self) -> None:
        self.parser = AnswerParser()

    def test_decodes_json_in_answer_block(self) -> None:
        self.assertEqual(
            self.parser.parse('<answer>{"name": "value"}</answer>'),
            {"name": "value"},
        )

    def test_returns_free_text_unchanged(self) -> None:
        self.assertEqual(self.parser.parse("<answer>just words</answer>"), "just words")


class TemplateParserTests(unittest.TestCase):
    def setUp(self) -> None:
        self.parser = TemplateParser()

    def test_decodes_fenced_json_template(self) -> None:
        self.assertEqual(
            self.parser.parse('```json\n{"site": "string"}\n```'),
            {"site": "string"},
        )

    def test_returns_non_json_text_unchanged(self) -> None:
        self.assertEqual(self.parser.parse("free-form note"), "free-form note")


if __name__ == "__main__":
    unittest.main()

import importlib
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

doctags_module = importlib.import_module("app.parsing.doctags_to_markdown")
doctags_to_markdown = doctags_module.doctags_to_markdown
convert_doctags_to_markdown = doctags_module.convert_doctags_to_markdown
llm_markdown_page_spans = doctags_module.llm_markdown_page_spans


class TestDocTagsToMarkdown(unittest.TestCase):
    def test_section_headers(self):
        out = doctags_to_markdown(
            "<doctag><section_header_level_2>Findings</section_header_level_2></doctag>"
        )
        self.assertEqual(out, "## Findings")

    def test_text_blocks(self):
        out = doctags_to_markdown("<doctag><text> Alpha body. </text></doctag>")
        self.assertEqual(out, "Alpha body.")

    def test_page_breaks(self):
        out = doctags_to_markdown("<text>One</text><page_break><text>Two</text>")
        self.assertEqual(out, "One\n\n---\n\nTwo")

    def test_page_footers_drop_by_default(self):
        out = doctags_to_markdown(
            "<text>Body</text><page_footer>Page 1</page_footer><text>Next</text>"
        )
        self.assertEqual(out, "Body\n\nNext")

    def test_page_footers_can_be_kept(self):
        out = doctags_to_markdown(
            "<text>Body</text><page_footer>Page 1</page_footer>",
            drop_page_footers=False,
        )
        self.assertEqual(out, "Body\n\n*Page 1*")

    def test_otsl_table(self):
        out = doctags_to_markdown(
            "<otsl><ched>Name<ched>Age<nl><fcel>Ada<fcel>37<nl><fcel>Bob<fcel>41</otsl>"
        )
        self.assertEqual(
            out,
            "| Name | Age |\n| --- | --- |\n| Ada | 37 |\n| Bob | 41 |",
        )

    def test_otsl_tables_split_across_page_breaks_keep_page_offsets(self):
        result = convert_doctags_to_markdown(
            "<otsl><ched>Name<ched>Age<nl><fcel>Ada<fcel>37</otsl>"
            "<page_footer>1</page_footer><page_break>"
            "<otsl><fcel>Bob<fcel>41<nl><fcel>Cy<fcel>29</otsl>"
        )
        self.assertEqual(result.markdown.count("| Name | Age |"), 2)
        self.assertEqual(len(result.page_spans), 2)
        self.assertIn("| Ada | 37 |", result.page_spans[0].text)
        self.assertEqual(
            result.page_spans[1].text,
            "| Name | Age |\n| --- | --- |\n| Bob | 41 |\n| Cy | 29 |",
        )
        for span in result.page_spans:
            self.assertEqual(
                result.markdown[span.llm_markdown_start : span.llm_markdown_end],
                span.text,
            )

    def test_otsl_cell_text_preserves_angle_brackets(self):
        out = doctags_to_markdown(
            "<otsl><ched>Expression<nl><fcel>x < 3 and y > 1</otsl>"
        )
        self.assertIn("| x < 3 and y > 1 |", out)

    def test_otsl_cell_escapes_existing_backslashes_before_pipes(self):
        out = doctags_to_markdown(r"<otsl><ched>Value<nl><fcel>x\|y</otsl>")
        self.assertIn(r"| x\\\|y |", out)

    def test_wrapped_physical_page_table_fragments_merge(self):
        result = convert_doctags_to_markdown(
            "<doctag><otsl><ched>Name<ched>Age<nl>"
            "<fcel>Ada<fcel>37</otsl></doctag>"
            "<page_break>"
            "<doctag><otsl><fcel>Bob<fcel>41</otsl></doctag>"
        )
        self.assertEqual(len(result.page_spans), 2)
        self.assertIn("| Name | Age |", result.page_spans[1].text)
        self.assertIn("| Bob | 41 |", result.page_spans[1].text)

    def test_page_header_between_split_table_fragments_is_furniture(self):
        result = convert_doctags_to_markdown(
            "<otsl><ched>Name<ched>Age<nl><fcel>Ada<fcel>37</otsl>"
            "<page_break><page_header>Research ledger</page_header>"
            "<otsl><fcel>Bob<fcel>41<nl><fcel>Cy<fcel>29</otsl>"
        )

        self.assertEqual(
            result.page_spans[1].text,
            "| Name | Age |\n| --- | --- |\n| Bob | 41 |\n| Cy | 29 |",
        )

    def test_narrative_between_split_table_fragments_prevents_merge(self):
        result = convert_doctags_to_markdown(
            "<otsl><ched>Name<ched>Age<nl><fcel>Ada<fcel>37</otsl>"
            "<page_break><text>Narrative context</text>"
            "<otsl><fcel>Bob<fcel>41<nl><fcel>Cy<fcel>29</otsl>"
        )

        self.assertEqual(
            result.page_spans[1].text,
            "Narrative context\n\n| Bob | 41 |\n| --- | --- |\n| Cy | 29 |",
        )

    def test_adjacent_same_page_tables_are_not_merged_or_truncated(self):
        out = doctags_to_markdown(
            "<otsl><ched>A<nl><fcel>1</otsl><otsl><fcel>Second<fcel>2</otsl>"
        )
        self.assertEqual(
            sum(line.startswith("| ---") for line in out.splitlines()),
            2,
        )
        self.assertIn("| Second | 2 |", out)

    def test_split_table_keeps_requested_footer_and_row_header_as_body(self):
        result = convert_doctags_to_markdown(
            "<otsl><ched>Name<ched>Value<nl><fcel>A<fcel>1</otsl>"
            "<page_footer>Page 1</page_footer><page_break>"
            "<otsl><rhed>B<fcel>2</otsl>",
            drop_page_footers=False,
        )
        self.assertIn("*Page 1*", result.page_spans[0].text)
        self.assertIn("| B | 2 |", result.page_spans[1].text)
        self.assertIn("| Name | Value |", result.page_spans[1].text)

    def test_standard_otsl_span_and_row_header_tokens_are_preserved(self):
        out = doctags_to_markdown(
            "Before<otsl><rhed>Region<fcel>Value<nl>"
            "<fcel>North<ucel><nl><fcel>South<fcel>2</otsl>After"
        )
        self.assertIn("Before", out)
        self.assertIn("Region", out)
        self.assertIn("South", out)
        self.assertIn("After", out)

    def test_unsupported_otsl_does_not_delete_surrounding_text(self):
        out = doctags_to_markdown("Before<otsl><unknown>cell</unknown></otsl>After")
        self.assertIn("Before", out)
        self.assertIn("<unknown>cell</unknown>", out)
        self.assertIn("After", out)

    def test_table_separator_is_not_a_page_break(self):
        spans = llm_markdown_page_spans("| Name | Age |\n| --- | --- |\n| Ada | 37 |")
        self.assertEqual(len(spans), 1)

    def test_page_span_offsets_exclude_trimmed_whitespace(self):
        markdown = "One  \n\n---\n\n  Two  "
        spans = llm_markdown_page_spans(markdown)
        self.assertEqual([span.text for span in spans], ["One", "Two"])
        for span in spans:
            self.assertEqual(
                markdown[span.llm_markdown_start : span.llm_markdown_end],
                span.text,
            )


if __name__ == "__main__":
    unittest.main()

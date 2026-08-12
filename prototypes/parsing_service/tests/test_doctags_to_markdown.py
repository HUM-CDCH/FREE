import importlib
import sys
import time
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

    def test_numbered_scientific_headings_correct_docling_level(self):
        out = doctags_to_markdown(
            "<doctag>"
            "<section_header_level_1>2. Materials and Methods</section_header_level_1>"
            "<section_header_level_1>2.1. Sample Collection</section_header_level_1>"
            "<section_header_level_1>2.1.3. Assay Details</section_header_level_1>"
            "</doctag>"
        )

        self.assertEqual(
            out,
            "# 2. Materials and Methods\n\n"
            "## 2.1. Sample Collection\n\n"
            "### 2.1.3. Assay Details",
        )

    def test_non_numbered_catalog_headings_keep_docling_level(self):
        out = doctags_to_markdown(
            "<doctag><section_header_level_1>Grav 8</section_header_level_1></doctag>"
        )

        self.assertEqual(out, "# Grav 8")

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

    def test_doctags_continuation_targets_last_preceding_table(self):
        result = convert_doctags_to_markdown(
            "<doctag>"
            "<otsl><ched>N ummer<ched>Type<nl><fcel>26-3<fcel>A</otsl>"
            "<otsl><ched>Fundnummer<ched>Type<nl><fcel>26-1<fcel>B</otsl>"
            "</doctag><page_break><doctag>"
            "<otsl><fcel>26-11<fcel>C</otsl>"
            "</doctag>"
        )

        self.assertEqual(result.markdown.count("| N ummer | Type |"), 1)
        self.assertEqual(result.markdown.count("| Fundnummer | Type |"), 2)
        self.assertIn("| 26-11 | C |", result.page_spans[1].text)
        self.assertNotIn("N ummer", result.page_spans[1].text)

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

    def test_minified_unordered_list_items_render_as_distinct_marked_lines(self):
        out = doctags_to_markdown(
            "<unordered_list><list_item>Alpha</list_item>"
            "<list_item>Beta</list_item></unordered_list>"
        )

        self.assertEqual(out, "- Alpha\n- Beta")

    def test_producer_shaped_nested_ordered_and_unordered_lists(self):
        out = doctags_to_markdown(
            "<ordered_list><list_item>First</list_item>"
            "<list_item><unordered_list>"
            "<list_item>Nested A</list_item><list_item>Nested B</list_item>"
            "</unordered_list></list_item><list_item>Second</list_item>"
            "</ordered_list>"
        )

        self.assertEqual(out, "1. First\n   - Nested A\n   - Nested B\n1. Second")

    def test_list_is_separated_from_following_table(self):
        out = doctags_to_markdown(
            "<unordered_list><list_item>Alpha</list_item></unordered_list>"
            "<otsl><ched>Name<nl><fcel>Ada</otsl>"
        )

        self.assertEqual(out, "- Alpha\n\n| Name |\n| --- |\n| Ada |")

    def test_code_uses_a_fence_longer_than_source_backticks(self):
        source = "print('before')\n```\nprint('after')"
        out = doctags_to_markdown(f"<code>{source}</code>")

        self.assertEqual(out, f"````\n{source}\n````")

    def test_code_drops_the_producer_language_control_token(self):
        out = doctags_to_markdown("<code><_Python_>print(1)</code>")

        self.assertEqual(out, "```\nprint(1)\n```")

    def test_semantic_placeholder_cannot_replace_source_text(self):
        source = "\ue000FREE_SEMANTIC_BLOCK_0\ue001"
        out = doctags_to_markdown(f"<text>{source}</text><code>print(1)</code>")

        self.assertEqual(out, f"{source}\n\n```\nprint(1)\n```")

    def test_page_placeholder_cannot_fabricate_a_physical_page(self):
        source = "before\ue000FREE_PAGE_BREAK\ue001after"
        result = convert_doctags_to_markdown(f"<text>{source}</text>")

        self.assertEqual(result.markdown, source)
        self.assertEqual([span.text for span in result.page_spans], [source])

    def test_many_lists_and_semantic_blocks_complete_within_linear_bound(self):
        count = 10_000
        doctags = (
            "<unordered_list>"
            + "<list_item>x</list_item>" * count
            + "</unordered_list>"
            + "<code>x</code>" * count
        )

        started = time.perf_counter()
        result = convert_doctags_to_markdown(doctags)
        elapsed = time.perf_counter() - started

        self.assertEqual(result.markdown.count("- x"), count)
        self.assertEqual(result.markdown.count("```\nx\n```"), count)
        self.assertLess(elapsed, 1.0)

    def test_formula_uses_separate_line_delimiters(self):
        source = r"E = mc^2 + \alpha"
        out = doctags_to_markdown(f"<formula>{source}</formula>")

        self.assertEqual(out, f"$$\n{source}\n$$")

    def test_semantic_wrappers_preserve_source_text_and_exact_page_spans(self):
        code = "if value:\n    return `literal`"
        formula = r"x_1 + y^2"
        result = convert_doctags_to_markdown(
            "<unordered_list><list_item>Alpha & Beta</list_item></unordered_list>"
            "<page_break>"
            f"<code>{code}</code><formula>{formula}</formula>"
        )

        self.assertEqual(
            [span.text for span in result.page_spans],
            ["- Alpha & Beta", f"```\n{code}\n```\n\n$$\n{formula}\n$$"],
        )
        for span in result.page_spans:
            self.assertEqual(
                result.markdown[span.llm_markdown_start : span.llm_markdown_end],
                span.text,
            )

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


class TestAnchorResolution(unittest.TestCase):
    def test_block_location_tokens_resolve_to_an_anchor(self):
        result = convert_doctags_to_markdown(
            "<doctag><text><loc_60><loc_107><loc_321><loc_124>Alpha body.</text></doctag>",
            page_dims={1: (612.0, 792.0)},
        )

        self.assertEqual(result.markdown, "Alpha body.")
        self.assertNotIn("loc_", result.markdown)
        self.assertEqual(len(result.anchors), 1)
        anchor = result.anchors[0]
        self.assertEqual(
            result.markdown[anchor.markdown_start : anchor.markdown_end],
            "Alpha body.",
        )
        self.assertEqual(anchor.page, 1)
        x0, y0, x1, y1 = anchor.bbox
        self.assertAlmostEqual(x0, 60 / 500 * 612.0)
        self.assertAlmostEqual(y0, 107 / 500 * 792.0)
        self.assertAlmostEqual(x1, 321 / 500 * 612.0)
        self.assertAlmostEqual(y1, 124 / 500 * 792.0)

    def test_table_cell_location_tokens_produce_no_anchor(self):
        result = convert_doctags_to_markdown(
            "<doctag><otsl><ched><loc_1><loc_2><loc_3><loc_4>Name"
            "<ched><loc_5><loc_6><loc_7><loc_8>Age<nl>"
            "<fcel><loc_9><loc_10><loc_11><loc_12>Ada"
            "<fcel><loc_13><loc_14><loc_15><loc_16>37</otsl></doctag>",
            page_dims={1: (612.0, 792.0)},
        )

        self.assertEqual(result.anchors, ())
        self.assertNotIn("loc_", result.markdown)
        self.assertEqual(
            result.markdown,
            "| Name | Age |\n| --- | --- |\n| Ada | 37 |",
        )

    def test_no_location_tokens_leaves_markdown_byte_identical(self):
        doctags = "<doctag><text>Alpha body.</text><page_break><text>Two</text></doctag>"

        without_dims = convert_doctags_to_markdown(doctags)
        with_dims = convert_doctags_to_markdown(doctags, page_dims={1: (612.0, 792.0)})

        self.assertEqual(without_dims.markdown, with_dims.markdown)
        self.assertEqual(without_dims.anchors, ())
        self.assertEqual(with_dims.anchors, ())

    def test_missing_page_dims_still_strips_locations_without_anchors(self):
        result = convert_doctags_to_markdown(
            "<doctag><text><loc_60><loc_107><loc_321><loc_124>Alpha body.</text></doctag>"
        )

        self.assertEqual(result.markdown, "Alpha body.")
        self.assertEqual(result.anchors, ())


if __name__ == "__main__":
    unittest.main()

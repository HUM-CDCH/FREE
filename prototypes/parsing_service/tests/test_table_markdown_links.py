import unittest

from app.models.parsed_document import ParsedTable
from app.parsing.doctags_to_markdown import PageMarkdownSpan
from app.parsing.table_markdown_links import link_tables_to_canonical_markdown


class TestTableMarkdownLinks(unittest.TestCase):
    def test_links_a_unique_view_within_its_page(self):
        view = "| Name |\n| --- |\n| Ada |"
        markdown = f"Intro\n\n{view}\n\nTail"
        table = ParsedTable(table_id="p01_t01", page_number=1, markdown_view=view)
        linked = link_tables_to_canonical_markdown(
            [table], markdown, [PageMarkdownSpan(1, markdown, 0, len(markdown))]
        )
        self.assertEqual(linked[0].canonical_markdown_start, markdown.index(view))
        self.assertEqual(linked[0].canonical_markdown_end, markdown.index(view) + len(view))

    def test_does_not_guess_for_repeated_view_on_one_page(self):
        view = "| Name |\n| --- |\n| Ada |"
        markdown = f"{view}\n\n{view}"
        table = ParsedTable(table_id="p01_t01", page_number=1, markdown_view=view)
        linked = link_tables_to_canonical_markdown(
            [table], markdown, [PageMarkdownSpan(1, markdown, 0, len(markdown))]
        )
        self.assertIsNone(linked[0].canonical_markdown_start)

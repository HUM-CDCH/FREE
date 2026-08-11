from __future__ import annotations

import unittest
from pathlib import Path

from app.models.parser_output import ParsedTable, TableCell
from app.parsing.semantic_stream import (
    TableSlot,
    doctags_to_intermediate_blocks,
    derive_logical_table_groups,
    match_table_slot,
    ocr_pages_to_blocks,
    place_table_slots,
    semantic_blocks_to_v2,
)


class TestSemanticStream(unittest.TestCase):
    def test_doc_tags_emit_ordered_typed_blocks_and_page_boundary(self):
        blocks = doctags_to_intermediate_blocks(
            "<doctag><section_header_level_2>Title</section_header_level_2>"
            "<text>Body &amp; exact</text><caption>Figure 1</caption></doctag>"
            "<page_break><doctag><code>print(1)</code><formula>x^2</formula></doctag>"
        )[0]
        self.assertEqual(
            [(block.kind, block.page_number) for block in blocks],
            [("heading", 1), ("paragraph", 1), ("caption", 1), ("page_boundary", 1), ("code", 2), ("formula", 2)],
        )
        self.assertEqual(blocks[1].text, "Body &amp; exact")
        self.assertEqual(blocks[0].level, 2)

    def test_numbered_heading_hierarchy_overrides_flat_producer_levels(self):
        blocks = doctags_to_intermediate_blocks(
            "<section_header_level_1>2. Materials and Methods</section_header_level_1>"
            "<section_header_level_1>2.9. Analysis</section_header_level_1>"
            "<section_header_level_1>2.9.1. Total RNA Extraction</section_header_level_1>"
        )[0]

        self.assertEqual(
            [(block.text, block.level) for block in blocks],
            [
                ("2. Materials and Methods", 1),
                ("2.9. Analysis", 2),
                ("2.9.1. Total RNA Extraction", 3),
            ],
        )

    def test_retained_zhang_headings_publish_three_outline_levels(self):
        fixture = (
            Path(__file__).parent / "fixtures" / "zhang_flat_headings.doctags"
        ).read_text(encoding="utf-8")
        headings = [
            block
            for block in doctags_to_intermediate_blocks(fixture)[0]
            if block.kind == "heading"
        ]

        self.assertEqual(len(headings), 27)
        self.assertEqual(
            {level: sum(block.level == level for block in headings) for level in (1, 2, 3)},
            {1: 7, 2: 18, 3: 2},
        )
        self.assertEqual(
            [block.text for block in headings if block.level == 1][1:5],
            [
                "1. Introduction",
                "2. Materials and Methods",
                "3. Results and Discussion",
                "4. Conclusions",
            ],
        )

    def test_non_outline_numbers_do_not_invent_heading_hierarchy(self):
        blocks = doctags_to_intermediate_blocks(
            "<section_header_level_1>Grav 8</section_header_level_1>"
            "<section_header_level_2>2024 findings</section_header_level_2>"
        )[0]

        self.assertEqual([block.level for block in blocks], [1, 2])

    def test_minified_lists_code_formula_caption_and_blank_page(self):
        blocks = doctags_to_intermediate_blocks(
            "<unordered_list><list_item>A</list_item><list_item>B</list_item></unordered_list>"
            "<code>x</code><formula>x^2</formula><page_break><page_break>"
            "<caption>Caption</caption>"
        )[0]
        self.assertEqual([block.kind for block in blocks], ["list", "code", "formula", "page_boundary", "page_boundary", "caption"])
        self.assertEqual(blocks[-1].page_number, 3)

    def test_picture_wrapper_is_not_published_as_text(self):
        blocks = doctags_to_intermediate_blocks(
            "<picture><loc_10><loc_20><loc_30><loc_40>"
            "<caption><loc_10><loc_41><loc_30><loc_50>Figure 1</caption>"
            "</picture>"
        )[0]
        self.assertEqual([(block.kind, block.text) for block in blocks], [("caption", "Figure 1")])

    def test_ocr_emits_one_block_per_line_with_unchanged_page_geometry(self):
        lines = {
            2: [
                {"text": "First", "bbox": [1, 2, 3, 4]},
                {"text": "Second", "bbox": [5, 6, 9, 10]},
            ]
        }
        blocks = ocr_pages_to_blocks(lines)
        self.assertEqual([block.text for block in blocks], ["First", "Second"])
        self.assertEqual([block.geometry for block in blocks], lines[2])
        published = semantic_blocks_to_v2(blocks, "a" * 64, "test", parser="paddleocr")
        self.assertEqual(
            [block.bbox.model_dump() for block in published],
            [
                {"x0": 1.0, "y0": 2.0, "x1": 3.0, "y1": 4.0},
                {"x0": 5.0, "y0": 6.0, "x1": 9.0, "y1": 10.0},
            ],
        )

    def test_doctags_geometry_survives_location_stripping_on_rotated_page(self):
        blocks = doctags_to_intermediate_blocks(
            "<text><loc_50><loc_100><loc_250><loc_200>Body</text>",
            page_sizes={1: (100, 200)},
        )[0]
        published = semantic_blocks_to_v2(blocks, "a" * 64, "test")
        self.assertEqual(
            published[0].bbox.model_dump(),
            {"x0": 10.0, "y0": 40.0, "x1": 50.0, "y1": 80.0},
        )

    def test_inline_table_slot_is_preserved_until_canonical_matching(self):
        blocks, slots = doctags_to_intermediate_blocks("<text>Before</text><otsl><ched>Name</otsl>")
        self.assertEqual([block.kind for block in blocks], ["paragraph", "table_slot"])
        self.assertEqual(slots[0].matrix, (("Name",),))

    def test_mismatched_slot_is_unplaced_and_never_substituted_inline(self):
        blocks, slots = doctags_to_intermediate_blocks(
            "<otsl><ched>Different</otsl>"
        )
        table = ParsedTable(
            table_id="table-1", page_number=1, rows=1, cols=1,
            cells=[TableCell(row=0, col=0, text="Canonical", role="header")],
        )
        placed = place_table_slots(blocks, slots, [table])
        self.assertFalse(any(block.kind == "table_slot" for block in placed.blocks))
        self.assertEqual(placed.unplaced_content, {1: ("table-1",)})
        self.assertEqual(placed.diagnostics[0].code, "table_slot_unmatched")

    def test_continuation_requires_an_explicit_reviewed_pair(self):
        first = ParsedTable(table_id="first", page_number=1, rows=1, cols=1, cells=[TableCell(row=0, col=0, text="A")])
        second = ParsedTable(table_id="second", page_number=2, rows=1, cols=1, cells=[TableCell(row=0, col=0, text="A")])
        self.assertEqual(len(derive_logical_table_groups([first, second])), 2)
        groups = derive_logical_table_groups([first, second], continuation_pairs=[("first", "second")])
        self.assertEqual(len(groups), 1)
        self.assertTrue(groups[0].continuation)
        self.assertEqual([table.table_id for table in groups[0].fragments], ["first", "second"])

    def test_producer_reference_is_used_for_same_content_repeated_tables(self):
        from app.parsing.semantic_stream import TableSlot
        first = ParsedTable(table_id="first", page_number=1, producer_ref="#/tables/0", producer_order=0, rows=1, cols=1, cells=[TableCell(row=0, col=0, text="Same", role="header")])
        second = ParsedTable(table_id="second", page_number=1, producer_ref="#/tables/1", producer_order=1, rows=1, cols=1, cells=[TableCell(row=0, col=0, text="Same", role="header")])
        matched, diagnostics = match_table_slot(TableSlot(1, 1, (("Same",),), (("header",),), producer_ref="#/tables/1"), [first, second])
        self.assertEqual(matched, second)
        self.assertEqual(diagnostics, ())

    def test_matching_slot_requires_exact_content(self):
        blocks = doctags_to_intermediate_blocks("<otsl><ched>Name</otsl>")[0]
        slot_id = next(block.table_slot for block in blocks if block.kind == "table_slot")
        table = ParsedTable(table_id="table-1", page_number=1, rows=1, cols=1, cells=[TableCell(row=0, col=0, text="Name", role="header")])
        matched, diagnostics = match_table_slot(TableSlot(1, 1, (("Name",),), (("header",),)), [table])
        self.assertEqual(matched, table)
        self.assertEqual(diagnostics, ())
        self.assertIsNotNone(slot_id)


if __name__ == "__main__":
    unittest.main()

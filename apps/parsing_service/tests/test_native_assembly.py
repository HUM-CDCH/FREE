"""Native text must survive paragraph assembly before the reading-order stage."""
from types import SimpleNamespace

import pytest
from docling.datamodel.base_models import Cluster, LayoutPrediction, Page, Table, TableStructurePrediction
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.models.stages.page_assemble.page_assemble_model import PageAssembleModel, PageAssembleOptions
from docling.pipeline.standard_pdf_pipeline import StandardPdfPipeline
from docling_core.types.doc import BoundingBox, CoordOrigin, DocItemLabel, Size, TableCell
from docling_core.types.doc.page import BoundingRectangle, TextCell

from kei_exp.transcription.native import PageBoundPipeline
from kei_exp.transcription.native_tables import align_native_table


@pytest.fixture
def assembly(monkeypatch):
    # Use the production pipeline's assembly selection without loading unrelated layout/table weights.
    def initialize(self, _options):
        self.assemble_model = PageAssembleModel(options=PageAssembleOptions())
        self.reading_order_model = SimpleNamespace(ro_model=SimpleNamespace(predict_merges=lambda **_: {}))
    monkeypatch.setattr(StandardPdfPipeline, '__init__', initialize)
    return PageBoundPipeline(PdfPipelineOptions()).assemble_model


@pytest.mark.parametrize(('lines', 'expected'), [
    (['Reference AB7-', '204 was catalogued.'], 'Reference AB7-204 was catalogued.'),
    (['Series ISO-', '9001 is named.'], 'Series ISO-9001 is named.'),
    (['Code R2-', 'a is printed.'], 'Code R2-a is printed.'),
    (['North-', 'South orientation.'], 'North-South orientation.'),
    (['An algo-', 'rithm is described.'], 'An algorithm is described.'),
    (['A separator -', 'followed by text.'], 'A separator - followed by text.'),
])
def test_line_joining_preserves_identifiers_and_compounds(assembly, lines, expected):
    assert assembly.sanitize_text(lines) == expected


def box(left, top, right, bottom):
    return BoundingBox(l=left, t=top, r=right, b=bottom, coord_origin=CoordOrigin.TOPLEFT)


def cell(index, text, left, top, right):
    return TextCell(index=index, text=text, orig=text, from_ocr=False,
                    rect=BoundingRectangle.from_bounding_box(box(left, top, right, top + 8)))


def cluster(index, cells, label=DocItemLabel.TEXT):
    return Cluster(id=index, label=label, cells=cells,
                   bbox=BoundingBox.enclosing_bbox([c.rect.to_bounding_box() for c in cells]))


def assembled(assembly, clusters):
    page = Page(page_no=1, size=Size(width=600, height=800))
    page._backend = SimpleNamespace(is_valid=lambda: True)
    page.predictions.layout = LayoutPrediction(clusters=clusters)
    output = list(assembly(SimpleNamespace(timings={}), [page]))
    assert output == [page]
    return page.assembled.elements


def test_table_grid_cannot_move_native_values_between_printed_rows(assembly):
    words = [cell(r * 3 + c, text, 10 + 60 * c, 20 + 12 * r, 45 + 60 * c)
             for r, row in enumerate((('Place', 'Area', 'Year'), ('Site A', 'East', '1700'),
                                     ('Site B', 'West', '1701'), ('Site C', 'East', '1702'),
                                     ('Site D', 'West', '1703'))) for c, text in enumerate(row)]
    layout = cluster(0, words, DocItemLabel.TABLE)
    predicted = []
    for row in range(4):
        for column in range(3):
            source_rows = [row] if row == 0 else [1, 2] if row == 1 else [3] if row == 2 else [4]
            if column == 2 and row == 2:
                source_rows = []
            if column == 2 and row == 3:
                source_rows = [3, 4]
            selected = [words[r * 3 + column] for r in source_rows]
            predicted.append(TableCell(text=' '.join(w.text for w in selected),
                start_row_offset_idx=row, end_row_offset_idx=row + 1,
                start_col_offset_idx=column, end_col_offset_idx=column + 1,
                column_header=row == 0,
                bbox=BoundingBox.enclosing_bbox([w.rect.to_bounding_box() for w in selected]) if selected else None))
    table = Table(id=0, label=DocItemLabel.TABLE, page_no=1, cluster=layout,
                  num_rows=4, num_cols=3, table_cells=predicted, otsl_seq=[])
    page = Page(page_no=1, size=Size(width=300, height=200))
    page._backend = SimpleNamespace(is_valid=lambda: True,
        get_segmented_page=lambda: SimpleNamespace(get_cells_in_bbox=lambda **_: words))
    page.predictions.layout = LayoutPrediction(clusters=[layout])
    page.predictions.tablestructure = TableStructurePrediction(table_map={0: table})
    list(assembly(SimpleNamespace(timings={}), [page]))
    assert table.num_rows == 5
    assert [(c.text, c.start_row_offset_idx) for c in table.table_cells if c.start_col_offset_idx == 2] == [
        ('Year', 0), ('1700', 1), ('1701', 2), ('1702', 3), ('1703', 4)]


def test_consistent_rowspans_and_multiline_cells_are_not_split_into_peer_rows():
    words = [cell(0, 'Long', 10, 20, 40), cell(1, 'name', 10, 32, 40),
             cell(2, 'A', 70, 20, 90), cell(3, 'B', 70, 32, 90)]
    cells = [TableCell(text='Long name', bbox=box(10, 20, 40, 40),
                start_row_offset_idx=0, end_row_offset_idx=2, start_col_offset_idx=0, end_col_offset_idx=1),
             TableCell(text='A', bbox=box(70, 20, 90, 28),
                start_row_offset_idx=0, end_row_offset_idx=1, start_col_offset_idx=1, end_col_offset_idx=2),
             TableCell(text='B', bbox=box(70, 32, 90, 40),
                start_row_offset_idx=1, end_row_offset_idx=2, start_col_offset_idx=1, end_col_offset_idx=2)]
    table = SimpleNamespace(table_cells=cells, num_rows=2, num_cols=2)
    align_native_table(table, words)
    assert table.table_cells is cells and table.num_rows == 2
    # Both physical lines may also be one legitimate multi-line logical row.
    for c in cells:
        c.start_row_offset_idx, c.end_row_offset_idx = 0, 1
    table.num_rows = 1
    align_native_table(table, words)
    assert table.table_cells is cells and table.num_rows == 1


def test_contradictory_columns_without_a_geometric_separation_use_the_unreadable_path():
    words = [cell(0, 'A', 10, 20, 40), cell(1, 'B', 45, 20, 70)]
    cells = [TableCell(text='A', bbox=box(10, 20, 50, 28),
                start_row_offset_idx=0, end_row_offset_idx=1, start_col_offset_idx=0, end_col_offset_idx=1),
             TableCell(text='B', bbox=box(45, 20, 70, 28),
                start_row_offset_idx=1, end_row_offset_idx=2, start_col_offset_idx=1, end_col_offset_idx=2)]
    table = SimpleNamespace(table_cells=cells, num_rows=2, num_cols=2)
    align_native_table(table, words)
    assert table.table_cells == [] and table.num_rows == table.num_cols == 0


def test_native_words_outside_an_incomplete_grid_are_not_discarded():
    words = [cell(0, 'First', 10, 20, 40), cell(1, '1700', 70, 20, 100),
             cell(2, 'Last', 10, 32, 40), cell(3, '1701', 70, 32, 100)]
    cells = [TableCell(text=w.text, bbox=w.rect.to_bounding_box(),
                start_row_offset_idx=0, end_row_offset_idx=1,
                start_col_offset_idx=c, end_col_offset_idx=c + 1) for c, w in enumerate(words[:2])]
    table = SimpleNamespace(table_cells=cells, num_rows=1, num_cols=2)
    align_native_table(table, words)
    assert table.num_rows == 2
    assert [c.text for c in table.table_cells] == ['First', '1700', 'Last', '1701']


def test_a_contradictory_grid_with_ambiguous_continuation_lines_uses_the_unreadable_path():
    words = [cell(0, 'Long', 10, 20, 40), cell(1, 'name', 10, 32, 40), cell(2, '1700', 70, 32, 100)]
    cells = [TableCell(text='Long name', bbox=box(10, 20, 40, 40),
                start_row_offset_idx=0, end_row_offset_idx=1, start_col_offset_idx=0, end_col_offset_idx=1),
             TableCell(text='1700', bbox=box(70, 32, 100, 40),
                start_row_offset_idx=1, end_row_offset_idx=2, start_col_offset_idx=1, end_col_offset_idx=2)]
    table = SimpleNamespace(table_cells=cells, num_rows=2, num_cols=2)
    align_native_table(table, words)
    assert table.table_cells == [] and table.num_rows == table.num_cols == 0


def test_interleaved_paragraphs_keep_the_source_lines_in_reading_order(assembly):
    lines = [cell(i, text, 50, 30 + 12 * i, 280) for i, text in enumerate([
        'The initial description begins here.', 'Its continuation belongs next.',
        'Then the account gives the measurements.', 'Finally the description ends.',
    ])]
    # A layout model assigned alternating lines to overlapping paragraph boxes.
    output = assembled(assembly, [cluster(3, [lines[0], lines[2]]), cluster(7, [lines[1], lines[3]])])
    ordered = sorted(output, key=lambda element: (element.cluster.bbox.t, element.cluster.bbox.l))
    assert ' '.join(element.text for element in ordered) == ' '.join(line.text for line in lines)
    assert len({element.id for element in output}) == len(output)


def test_separate_columns_and_nontext_labels_keep_their_groups(assembly):
    left = cluster(1, [cell(0, 'Left first.', 40, 30, 270), cell(1, 'Left second.', 40, 42, 270)])
    right = cluster(2, [cell(2, 'Right first.', 320, 30, 550), cell(3, 'Right second.', 320, 42, 550)])
    heading = cluster(3, [cell(4, 'A section heading', 40, 20, 250)], DocItemLabel.SECTION_HEADER)
    output = assembled(assembly, [left, right, heading])
    assert [(element.id, element.text) for element in output] == [
        (1, 'Left first. Left second.'), (2, 'Right first. Right second.'), (3, 'A section heading')]


def test_adjacent_metadata_cells_keep_the_horizontal_boundary(assembly):
    cells = [cell(0, 'Images: 12, 15', 40, 30, 110), cell(1, 'Drawings: 7', 140, 30, 210)]
    output = assembled(assembly, [cluster(1, cells)])
    assert output[0].text == 'Images: 12, 15\tDrawings: 7'


def test_a_font_change_inside_a_line_does_not_create_a_column(assembly):
    cells = [cell(0, 'One', 40, 30, 60), cell(1, 'sentence.', 63, 30, 110)]
    output = assembled(assembly, [cluster(1, cells)])
    assert output[0].text == 'One sentence.'


def test_cell_boundaries_preserve_native_character_normalization(assembly):
    cells = [cell(0, 'A ﬁ eld', 40, 30, 100), cell(1, 're\x02port.', 103, 30, 160)]
    output = assembled(assembly, [cluster(1, cells)])
    assert output[0].text == 'A field re-port.'


@pytest.mark.parametrize('label', [DocItemLabel.FORM, DocItemLabel.KEY_VALUE_REGION])
def test_overlapping_container_children_retain_the_references_reading_order_uses(assembly, label):
    lines = [cell(i, text, 40, 30 + i * 12, 270) for i, text in enumerate(['A', 'B', 'C', 'D'])]
    first, second = cluster(3, [lines[0], lines[2]]), cluster(7, [lines[1], lines[3]])
    parent = Cluster(id=9, label=label, bbox=box(30, 20, 290, 90), children=[first, second])
    output = assembled(assembly, [parent, first, second])
    # ReadingOrderModel resolves every container child through the assembled ID map.
    ids = {element.id for element in output}
    assert {child.id for element in output for child in element.cluster.children} <= ids

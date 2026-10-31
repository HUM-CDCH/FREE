"""Native text must survive paragraph assembly before the reading-order stage."""
from types import SimpleNamespace

import pytest
from docling.datamodel.base_models import Cluster, LayoutPrediction, Page
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.models.stages.page_assemble.page_assemble_model import PageAssembleModel, PageAssembleOptions
from docling.pipeline.standard_pdf_pipeline import StandardPdfPipeline
from docling_core.types.doc import BoundingBox, CoordOrigin, DocItemLabel, Size
from docling_core.types.doc.page import BoundingRectangle, TextCell

from kei_exp.transcription.native import PageBoundPipeline


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

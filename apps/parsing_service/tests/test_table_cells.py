"""Native cells remain children of the exact canonical parent text."""
from dataclasses import replace

import pytest
from pydantic import ValidationError

from kei_exp.pagefile import PageTable
from kei_exp.transcription.tables import table_of_html
from kei_exp.transcription.types import html_to_text
from kei_exp.kie.passages import Passage
from kei_exp.kie.extract.grounding import verify
from tests.helpers.chat import FakeChat
from tests.test_extract_stages import SCHEMA

HTML = '<table><tr><th>number</th><th>description</th></tr><tr><td>7-8</td><td>Glass bead</td></tr><tr><td>7-17</td><td>Glass bead</td></tr></table>'


def passage(html=HTML):
    table = table_of_html(html)
    for cell in table['cells']:
        cell['bbox_pt'] = [cell['column'] * 100, cell['row'] * 20, cell['column'] * 100 + 90, cell['row'] * 20 + 18]
    return Passage('p3_s4', 3, 4, html_to_text(html), 'Table', (0, 0, 200, 60), 'block', table=PageTable.model_validate(table))


def test_projection_preserves_unicode_entities_empty_and_merged_cells():
    html = '<table><caption>Unit 7</caption><tr><th colspan="2">Blå &amp; 🦴</th></tr><tr><td rowspan="2">7-8</td><td></td></tr><tr><td>2 pcs.</td></tr></table>'
    table = PageTable.model_validate(table_of_html(html))
    assert [(c.cell_id, c.rowspan, c.colspan) for c in table.cells] == [('r0_c0', 1, 2), ('r1_c0', 2, 1), ('r1_c1', 1, 1), ('r2_c1', 1, 1)]
    assert [c.text for c in table.cells] == ['Blå & 🦴', '7-8', '', '2 pcs.']
    assert all(html_to_text(html)[c.start:c.end] == c.text for c in table.cells)


def test_invalid_nested_or_overlapping_cells_are_not_published():
    assert table_of_html('<table><tr><td><table><tr><td>x</td></tr></table></td></tr></table>') is None
    table = table_of_html(HTML)
    table['cells'][1]['column'] = 0
    table['cells'][1]['cell_id'] = 'r0_c0'
    with pytest.raises(ValidationError):
        PageTable.model_validate(table)


@pytest.mark.parametrize("projected", [False, True])
def test_a_matching_cell_is_selectable_and_its_parent_is_not(projected):
    def choose(system, user, schema):
        assert schema['properties']['C1']['enum'] == ['E4', 'NONE']
        return {'C1': 'E4'}
    links, calls, issues = verify([passage()], {'entry_no': '7-8'}, SCHEMA, FakeChat(choose), record=0, projected=projected)
    assert len(calls) == 1 and not issues
    assert (links[0].cell, links[0].hits, links[0].precision, links[0].bbox_pt, links[0].linked_by) == (
        'r1_c0', 1, 'cell', (0, 20, 90, 38), 'model')


def test_repeated_cells_require_model_with_row_and_sibling_context():
    def choose(system, user, schema):
        assert "r2_c0 row=2 column=0 rowspan=1 colspan=1 data: '7-17'" in user
        assert 'Sibling fields: {"entry_no": "7-17", "site": "Glass bead"}' in user
        return {'C1': 'E6', 'C2': 'E7'}
    links, calls, issues = verify([passage()], {'entry_no': '7-17', 'site': 'Glass bead'}, SCHEMA, FakeChat(choose), record=0)
    assert len(calls) == 1 and not issues
    assert (links[0].cell, links[0].hits, links[0].linked_by) == ('r2_c0', 1, 'model')
    assert (links[1].cell, links[1].hits, links[1].linked_by) == ('r2_c1', 2, 'model')


def test_missing_geometry_stays_coarse_and_wrong_cell_is_rejected():
    item = passage()
    table = item.table.model_copy(deep=True)
    table.cells[2].bbox_pt = None
    links, _, _ = verify([replace(item, table=table)], {'entry_no': '7-8'}, SCHEMA, FakeChat(lambda *_: {'C1': 'E4'}), record=0)
    assert links[0].cell is None and links[0].precision == 'segment' and links[0].bbox_pt == item.bbox_pt
    links, _, issues = verify([item], {'site': 'Glass bead'}, SCHEMA, FakeChat(lambda *_: {'C1': 'E2'}), record=0)
    assert links == [] and issues[0].code == 'unknown_label'


def test_grounded_catalog_uses_only_spans_wholly_inside_one_cell():
    from kei_exp.kie.blocks import Span
    from kei_exp.kie.extract.acceptance import Outcome
    from kei_exp.kie.extract.catalog_result import evidence_link
    item = passage()
    cell = item.table.cells[2]
    span = Span(segment_id=item.id, start=cell.start, end=cell.end)
    outcome = Outcome('accepted', ('records', 0, 'entry_no'), '7-8', spans=[span], linked_by='key')
    assert evidence_link(outcome, {item.id: item}, {})['cell'] == cell.cell_id
    outcome.alternatives = [[span]]
    assert evidence_link(outcome, {item.id: item}, {})['precision'] == 'segment'
    outcome.alternatives = []
    outcome.spans = [Span(segment_id=item.id, start=cell.start, end=item.table.cells[3].end)]
    assert evidence_link(outcome, {item.id: item}, {})['cell'] is None


@pytest.mark.parametrize("projected", [False, True])
def test_a_whole_table_answer_is_rejected_when_its_matching_cell_was_offered(projected):
    links, _, issues = verify([passage()], {'entry_no': '7-8'}, SCHEMA,
                              FakeChat(lambda *_: {'C1': 'E1'}), record=0, projected=projected)
    assert links == [] and issues[0].code == 'unknown_label'


def test_whole_table_support_remains_per_claim_and_per_table():
    first = passage()
    other = replace(passage('<table><tr><td>Other support</td></tr></table>'), id='p4_s0', page=4)
    prose = Passage('p4_s1', 4, 1, 'A glass bead catalogue.', 'text', (0, 0, 200, 60), 'block')
    def choose(system, user, schema):
        # 7-8 has a cell in the first table: only that parent is removed, not other sources.
        assert schema['properties']['C1']['enum'] == ['E4', 'E8', 'E10', 'NONE']
        # This value crosses cells, so the first table must still be available for this claim.
        assert schema['properties']['C2']['enum'] == ['E1', 'E8', 'E10', 'NONE']
        return {'C1': 'E4', 'C2': 'E1'}
    links, calls, issues = verify([first, other, prose], {'entry_no': '7-8', 'site': '7-8 Glass bead'},
                                  SCHEMA, FakeChat(choose), record=0)
    assert len(calls) == 1 and not issues
    assert [(link.segment, link.precision) for link in links] == [('p3_s4', 'cell'), ('p3_s4', 'segment')]


@pytest.mark.parametrize("quoted,span_ids", [(True, False), (False, True)])
def test_other_grounding_modes_also_exclude_a_matching_cells_parent(quoted, span_ids):
    def choose(system, user, schema):
        assert schema['properties']['C1']['properties']['label']['enum'] == ['E4', 'NONE']
        return {'C1': {'label': 'E4', 'attribution': True, **({'quote': '7-8'} if quoted else {})}}
    links, calls, issues = verify([passage()], {'entry_no': '7-8'}, SCHEMA, FakeChat(choose), record=0,
                                  quoted=quoted, span_ids=span_ids)
    assert len(calls) == 1 and not issues and links[0].cell == 'r1_c0'


def test_a_matching_cell_hides_its_table_even_when_the_cell_does_not_support_the_claim():
    def choose(system, user, schema):
        # '7-8' is an entry number, not a site: the table is context only, not a fallback label.
        assert schema['properties']['C1']['enum'] == ['E4', 'NONE']
        return {'C1': 'NONE'}
    links, calls, issues = verify([passage()], {'site': '7-8'}, SCHEMA, FakeChat(choose), record=0)
    assert links == [] and len(calls) == 1

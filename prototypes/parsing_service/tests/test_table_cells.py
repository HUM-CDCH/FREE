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

HTML = '<table><tr><th>nummer</th><th>beskrivelse</th></tr><tr><td>24-8</td><td>Overarmsknogle</td></tr><tr><td>24-17</td><td>Overarmsknogle</td></tr></table>'


def passage(html=HTML):
    table = table_of_html(html)
    for cell in table['cells']:
        cell['bbox_pt'] = [cell['column'] * 100, cell['row'] * 20, cell['column'] * 100 + 90, cell['row'] * 20 + 18]
    return Passage('p3_s4', 3, 4, html_to_text(html), 'Table', (0, 0, 200, 60), 'block', table=PageTable.model_validate(table))


def test_projection_preserves_unicode_entities_empty_and_merged_cells():
    html = '<table><caption>Grav 24</caption><tr><th colspan="2">Blå &amp; 🦴</th></tr><tr><td rowspan="2">24-8</td><td></td></tr><tr><td>2 stk.</td></tr></table>'
    table = PageTable.model_validate(table_of_html(html))
    assert [(c.cell_id, c.rowspan, c.colspan) for c in table.cells] == [('r0_c0', 1, 2), ('r1_c0', 2, 1), ('r1_c1', 1, 1), ('r2_c1', 1, 1)]
    assert [c.text for c in table.cells] == ['Blå & 🦴', '24-8', '', '2 stk.']
    assert all(html_to_text(html)[c.start:c.end] == c.text for c in table.cells)


def test_invalid_nested_or_overlapping_cells_are_not_published():
    assert table_of_html('<table><tr><td><table><tr><td>x</td></tr></table></td></tr></table>') is None
    table = table_of_html(HTML)
    table['cells'][1]['column'] = 0
    table['cells'][1]['cell_id'] = 'r0_c0'
    with pytest.raises(ValidationError):
        PageTable.model_validate(table)


def test_a_unique_cell_is_offered_to_the_model_and_its_parent_not_double_counted():
    def choose(system, user, schema):
        assert schema['properties']['C1']['enum'] == ['E1', 'E4', 'NONE']  # the table and its one matching cell
        return {'C1': 'E4'}
    links, calls, issues = verify([passage()], {'entry_no': '24-8'}, SCHEMA, FakeChat(choose), record=0)
    assert len(calls) == 1 and not issues
    assert (links[0].cell, links[0].hits, links[0].precision, links[0].bbox_pt, links[0].linked_by) == (
        'r1_c0', 1, 'cell', (0, 20, 90, 38), 'model')


def test_repeated_cells_require_model_with_row_and_sibling_context():
    def choose(system, user, schema):
        assert "r2_c0 row=2 column=0 rowspan=1 colspan=1 data: '24-17'" in user
        assert 'Sibling fields: {"entry_no": "24-17", "site": "Overarmsknogle"}' in user
        return {'C1': 'E6', 'C2': 'E7'}
    links, calls, issues = verify([passage()], {'entry_no': '24-17', 'site': 'Overarmsknogle'}, SCHEMA, FakeChat(choose), record=0)
    assert len(calls) == 1 and not issues
    assert (links[0].cell, links[0].hits, links[0].linked_by) == ('r2_c0', 1, 'model')
    assert (links[1].cell, links[1].hits, links[1].linked_by) == ('r2_c1', 2, 'model')


def test_missing_geometry_stays_coarse_and_wrong_cell_is_rejected():
    item = passage()
    table = item.table.model_copy(deep=True)
    table.cells[2].bbox_pt = None
    links, _, _ = verify([replace(item, table=table)], {'entry_no': '24-8'}, SCHEMA, FakeChat(lambda *_: {'C1': 'E4'}), record=0)
    assert links[0].cell is None and links[0].precision == 'segment' and links[0].bbox_pt == item.bbox_pt
    links, _, issues = verify([item], {'site': 'Overarmsknogle'}, SCHEMA, FakeChat(lambda *_: {'C1': 'E2'}), record=0)
    assert links == [] and issues[0].code == 'unknown_label'


def test_grounded_catalog_uses_only_spans_wholly_inside_one_cell():
    from kei_exp.kie.blocks import Span
    from kei_exp.kie.extract.acceptance import Outcome
    from kei_exp.kie.extract.catalog_result import evidence_link
    item = passage()
    cell = item.table.cells[2]
    span = Span(segment_id=item.id, start=cell.start, end=cell.end)
    outcome = Outcome('accepted', ('records', 0, 'entry_no'), '24-8', spans=[span], linked_by='key')
    assert evidence_link(outcome, {item.id: item}, {})['cell'] == cell.cell_id
    outcome.alternatives = [[span]]
    assert evidence_link(outcome, {item.id: item}, {})['precision'] == 'segment'
    outcome.alternatives = []
    outcome.spans = [Span(segment_id=item.id, start=cell.start, end=item.table.cells[3].end)]
    assert evidence_link(outcome, {item.id: item}, {})['cell'] is None

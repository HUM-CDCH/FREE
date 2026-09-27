"""Structural prompts retain source text, merged headers and counted execution boundaries."""
from dataclasses import replace
from html.parser import HTMLParser
from xml.etree import ElementTree

import pytest

from kei_exp.kie.extract import run
from kei_exp.kie.extract.article import inventory_request
from kei_exp.kie.extract.method import ArticleOptions
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.rendering import structured_source
from kei_exp.kie.extract.stages import extract_document, extract_record
from kei_exp.kie.extract.tokens import BudgetUnavailable
from kei_exp.pagefile import PageTable, TableCell
from tests.test_extract_grounded import CountingChat, WordCounter
from tests.test_extract_stages import SCHEMA, evidence, passages


def table_passage():
    text = " Table 1 & conditions\nGroup α\t\nA\tB\t\n37\t42\t\n* in water.\n"
    cells = []
    for row, column, value, role, span in [
        (0, 0, "Group α", "column_header", 2),
        (1, 0, "A", "column_header", 1), (1, 1, "B", "column_header", 1),
        (2, 0, "37", "data", 1), (2, 1, "42", None, 1),
    ]:
        start = text.index(value)
        cells.append(TableCell(cell_id=f"r{row}_c{column}", row=row, column=column,
                               rowspan=1, colspan=span, role=role, text=value,
                               start=start, end=start + len(value), bbox_pt=None))
    return replace(passages([text])[0], label="Table", table=PageTable(
        rows=3, columns=2, cells=cells, producer="docling"))


def test_rendering_roundtrips_exact_source_and_exposes_merged_header_without_inferred_geometry():
    passage = table_passage()
    block = ElementTree.fromstring(structured_source([passage]))
    assert "".join(block.itertext()) == passage.text
    assert block.attrib == {"id": "p1_s0", "label": "Table", "page": "1"}
    header = block.find("table/cell")
    assert header.attrib == {"id": "r0_c0", "row": "0", "column": "0", "rowspan": "1",
                             "colspan": "2", "role": "column_header"}
    assert header.text == "Group α"
    assert [(c.attrib["row"], c.attrib["column"], c.text) for c in block.findall("table/cell")][-2:] == [
        ("2", "0", "37"), ("2", "1", "42")]
    assert "role" not in block.findall("table/cell")[-1].attrib
    assert "bbox" not in structured_source([passage])


def test_block_labels_and_literal_markup_survive_without_inventing_table_cells():
    text = '  <cell>not markup</cell> & "quoted"\n'
    source = [replace(passages([text])[0], label='SectionHeader'),
              replace(passages(["OCR table text"], page=2)[0], label="Table")]
    blocks = ElementTree.fromstring("<source>" + structured_source(source) + "</source>")
    assert [b.attrib["label"] for b in blocks] == ["SectionHeader", "Table"]
    assert ["".join(b.itertext()) for b in blocks] == [text, "OCR table text"]
    assert blocks.findall(".//cell") == []


def test_canonical_control_characters_and_literal_entities_are_not_normalized():
    class TextReader(HTMLParser):
        def handle_data(self, data):
            recovered.append(data)

    recovered = []
    text = "Keywords Collagen \x01 Sturgeon\r\nLiteral &#1; &lt;cell&gt;"
    reader = TextReader()
    reader.feed(structured_source(passages([text])))
    reader.close()
    assert "".join(recovered) == text


def test_inconsistent_cell_text_is_refused_instead_of_rewriting_evidence():
    passage = table_passage()
    passage.table.cells[0] = passage.table.cells[0].model_copy(update={"text": "invented"})
    with pytest.raises(ValueError, match="canonical text"):
        structured_source([passage])


@pytest.mark.parametrize("context", ["full", "bounded"])
def test_all_upstream_stages_receive_and_count_structured_input(monkeypatch, context):
    source = [table_passage()]
    monkeypatch.setattr(run, "load", lambda _: evidence(source))
    fields = CountingChat(lambda *_: {"year": 1842, "title": "Table report"})
    reasoning = CountingChat(lambda *_: {"records": [
        {"label": "A", "identity": {"site": "A"}, "passages": ["p1_s0"]}]})
    method = {"context": context, "rendering": "structured", "grounding": "off"}
    request = run.ExtractRequest(schema=SCHEMA, options={"strategy": "article", "article": method})
    result = run.extract(None, request, Router(fields, reasoning),
                         counter={role: WordCounter() for role in ("fields", "reasoning")})
    assert len(fields.calls) == 2 and len(reasoning.calls) == 1
    for call in fields.calls + reasoning.calls:
        assert '<block id="p1_s0" label="Table" page="1">' in call["user"]
        assert 'colspan="2" role="column_header">Group α' in call["user"]
    assert all(c["input_tokens"] == c["counted_input_tokens"] for c in result["calls"])
    assert result["records"][0]["year"] == 1842
    assert result["rendering_version"] == 1 and result["options"]["article"]["rendering"] == "structured"
    assert result["contexts"] == [{"primary": ["p1_s0"], "overlap": []}]


def test_plain_reference_request_and_serialization_are_preserved():
    source = passages([" Heading\n", "42\t37"])
    assert inventory_request(source, SCHEMA)[1] == "[p1_s0] Heading\n\n[p1_s1] 42\t37"
    assert "rendering" not in ArticleOptions().model_dump()
    base = run.ExtractRequest(schema=SCHEMA, options={"strategy": "article", "article": {}})
    structured = run.ExtractRequest(schema=SCHEMA, options={"strategy": "article", "article": {
        "rendering": "structured"}})
    assert run.fingerprint({"generation": "g", "digest": "d"}, base, {}) != run.fingerprint(
        {"generation": "g", "digest": "d"}, structured, {})


def test_structural_overhead_is_admitted_or_refused_without_sending_a_clipped_table():
    source = [table_passage()]

    class RenderingCounter:
        context_tokens = 8192

        def request_tokens(self, system, user, schema=None):
            return 8192 if "<cell " in user else 100

    chat = CountingChat(lambda *_: {})
    _, calls, issues = extract_record(source, SCHEMA, chat, budget=1, record=0,
                                      counter=RenderingCounter(), structured=True)
    assert not chat.calls
    assert not calls[0].ok and calls[0].counted_input_tokens == 8192
    assert issues[0].code == "call_failed"
    with pytest.raises(BudgetUnavailable, match="requires a token counter"):
        extract_document(evidence(source), SCHEMA, chat, budget=1, structured=True)

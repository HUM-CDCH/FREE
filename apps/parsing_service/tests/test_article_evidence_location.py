"""Article Evidence locates a value's one printing in the evidence the model chose; anything else stays coarse.

The location is read off the value within the chosen candidate's range (a cell, a canonical span, or the whole
passage), searching the whole passage so its neighbours still bound a token. A number counts every printing of its
value, and its one printing must have no other reading. The version 1 Catalog never asks for one
(`test_legacy_catalog_golden.py` pins its bytes).
"""
import json
from dataclasses import replace
from pathlib import Path

import pytest

from kei_exp.kie.extract.assembly import link_json
from kei_exp.kie.extract.grounding import _Candidate, _link, _location, verify
from kei_exp.kie.extract.spans import SourceSpan
from kei_exp.kie.passages import Passage
from kei_exp.pagefile import PageTable, TableCell
from tests.test_article_claims_contract import scripted_artifact
from tests.test_extract_grounded import CountingChat, WordCounter
from tests.test_extract_stages import SCHEMA, passages
from tests.test_extraction_rendering import table_passage

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "contracts" / "article-location-link.json").read_text())


def printed(candidate, value) -> str | None:
    """The raw text the location names, after checking it is one span of the candidate's own passage."""
    location = _location(candidate, value)
    if location is None:
        return None
    [span] = location["spans"]
    text = candidate.passage.text
    assert span["segment"] == candidate.passage.id and 0 <= span["start"] < span["end"] <= len(text)
    assert location["raw"] == text[span["start"]:span["end"]]
    return location["raw"]


@pytest.mark.parametrize("value,text,expected", [
    (18, "aged 18 years", "18"), (18, "aged 18.0 years", "18.0"), (18, "aged 18,0 years", "18,0"),
    (18, "aged 18.00 years", "18.00"), (18.0, "aged 18 years", "18"), (18.0, "aged 18,0 years", "18,0"),
    (18.5, "pH 18,5", "18,5"), (18, "18 of 1,000", "18"), (1000.5, "1,000.5 g", "1,000.5"),
    (18, "18% of sites", "18"), (18, "from 16% to 18%", "18"),
    (18, "range 16–18", "18"), (18, "range 18–20", "18"), (20, "range 18-20", "20"),  # a dash after a number: a range
    (-18, "at −18 °C", "−18"), (-18, "at -18 °C", "-18"), (2, "Nr.2", "2"), (0.5, "(.5)", ".5"),
    (18, "at -18 °C", None), (18, "at – 18 °C", None),        # a dash before a number alone is its sign
    (18, "18.000 m", None), (1000, "1,000 m", None), (1000, "1.000 m", None),
    (1, "1,000 m", None),                                      # a decimal and a thousands reading: ambiguous
    (18, "18.5mm", None), (18, "118, 185 and 3.18", None), (18, "eighteen", None), (True, "1 site", None),
    (5, "pH7.5 buffer", None), (5, "v1.5", None), (5, "A1.5", None), (3, "a2.3", None),  # a fraction glued to a word
    (18, "18 then 18", None), (18, "18 then 18.0", None), (18, "18,0 or 18.00", None),
    (18.0, "18 and 18,0", None), (18, "18 and 18.000", None),  # repeated printings: none is the value's
    (1937, "12.3.1937 and 1937", None), (18, "18,20,22 and 18", None),  # a date or a list prints each part
    # A separator spaced by text extraction (`0 . 02`) leaves one number or several: each reading is printed there, and
    # none is located on it.
    (2, "m s - 2 with ± 0 . 02 and", None), (0.02, "± 0 . 02 and", None), (20, "1 . 20 ×", None), (1, "1 . 20 ×", None),
    (2, "0 .02", None), (2, "0. 02", None), (18, "18 , 20", None), (5, "v1 . 5", None), (18, "18 then 0 . 18", None),
    (20, "18, 20 and 22", "20"), (2, "Nr . 2", "2"), (18, "aged 18 years, 0 . 5 ml", "18"),
    # A slash between digits, a grouping space or apostrophe before exactly three digits, and a plus sign join the
    # number: each part is printed there, and none is located on it.
    (2, "value 1/2 here", None), (1, "value 1/2 here", None), (0.6, "Wdg. 0,6/0,7", None),
    (234, "value 1'234 here", None), (234, "value 1 234 here", None), (1, "value 1 234 here", None),
    (234, "value 1\u202f234 here", None), (7, "SD 7 122  (ca.", None), (1234, "value 1234 or 1 234", None),
    (234, "value 1\t234 here", "234"), (42, "value +42 here", None), (42, "value + 42 here", None),
    # An exponent form prints its value too, and is never located on.
    (18, "Control 18; sample 1.8e1.", None), (18, "Control 18; sample 1.8E+1.", None),
    (18, "Control 18; sample 18e0.", None), (18, "Control 18; sample 1.8×10^1.", None),
    (18, "Control 18; sample 1.8 × 10¹.", None), (18, "Control 18; sample 1.8 × 101.", None),  # a lowered superscript?
    (18, "sample 1.8e1 only", None), (1.8, "sample 1.8×10^1", None), (0.18, "Control 0.18; 1.8 × 10⁻¹", None),
    (18, "Control 18; size 3 x 10 cm", "18"),
    (2005, "year 2005\u0338 x", None),                          # a combining mark is part of the word it follows
])
@pytest.mark.parametrize("as_float", [False, True])
def test_a_number_is_located_only_at_its_one_unambiguous_printing(value, text, expected, as_float):
    if as_float and type(value) is int:
        value = float(value)
    assert printed(_Candidate(passages([text])[0]), value) == expected


def test_a_string_is_located_only_where_it_is_printed_once():
    assert _location(_Candidate(passages(["Survey site:  Cedar Bay"])[0]), "Cedar Bay") == {
        "spans": [{"segment": "p1_s0", "start": 14, "end": 23}], "raw": "Cedar Bay"}
    assert printed(_Candidate(passages(["Cedar Bay, then cedar  bay"])[0]), "Cedar Bay") is None
    assert printed(_Candidate(passages(["Cedar Bayou"])[0]), "Cedar Bay") is None


@pytest.mark.parametrize("value,text,expected", [("18", "aged 18 years", "18"), ("18", "dose 18.5 mg", None),
                                                 ("5", "pH 7.5 buffer", None), ("3", "Fig. 1.3", None),
                                                 ("2019", "2019.5", None), ("2", "± 0 . 02", None),
                                                 ("20", "1 . 20 ×", None), ("20", "18, 20 and 22", "20"),
                                                 ("2", "value 1/2 here", None), ("234", "value 1 234 here", None),
                                                 ("234", "value 1'234 here", None), ("42", "value +42 here", None)])
def test_a_string_of_digits_is_located_only_as_a_whole_number(value, text, expected):
    assert printed(_Candidate(passages([text])[0]), value) == expected


def two_cells() -> Passage:
    text = "Site\tNote\nCedar Bay\tCedar Bay north\n"
    cells = [TableCell(cell_id=f"r1_c{column}", row=1, column=column, rowspan=1, colspan=1, role="data",
                       text=value, start=text.index(value, 10), end=text.index(value, 10) + len(value),
                       bbox_pt=(column * 50, 0, column * 50 + 40, 9))
             for column, value in enumerate(["Cedar Bay", "Cedar Bay north"])]
    return replace(passages([text])[0], label="Table", table=PageTable(rows=2, columns=2, cells=cells,
                                                                       producer="docling"))


def test_a_value_repeated_outside_the_chosen_cell_is_located_in_that_cell():
    passage = two_cells()
    first, second = passage.table.cells
    assert printed(_Candidate(passage), "Cedar Bay") is None
    assert _location(_Candidate(passage, first), "Cedar Bay")["spans"] == [
        {"segment": "p1_s0", "start": 10, "end": 19}]
    assert _location(_Candidate(passage, second), "Cedar Bay")["spans"] == [
        {"segment": "p1_s0", "start": 20, "end": 29}]


def test_a_canonical_span_bounds_the_search_but_the_passage_bounds_its_tokens():
    passage = passages(["Cedar Bay; Baylor 18; Cedar Bay 180"])[0]
    assert printed(SourceSpan(passage, 0, 9), "Cedar Bay") == "Cedar Bay"
    assert printed(SourceSpan(passage, 11, 14), "Bay") is None          # its text reads "Bay", the passage "Baylor"
    assert printed(SourceSpan(passage, 32, 34), 18) is None             # "18" of "180"
    assert printed(SourceSpan(passage, 11, 20), 18) == "18"


def test_offsets_count_code_points_of_the_passage_as_stored():
    text = "🌿🌿 � site: Cedar Bay, 18 🌿"  # a NUL glyph is stored as U+FFFD (`passages.load`)
    candidate = _Candidate(passages([text])[0])
    assert _location(candidate, "Cedar Bay")["spans"][0]["start"] == 11 == text.index("Cedar Bay")
    assert _location(candidate, 18)["spans"][0]["start"] == 22 == text.index("18")


def test_a_whole_table_is_never_located_since_its_box_leaves_out_its_caption():
    passage = table_passage()  # its caption, " Table 1 & conditions", is inlined into its text
    assert printed(_Candidate(passage), 1) is None
    assert printed(_Candidate(passage), 37) is None
    assert printed(SourceSpan(passage, 0, len(passage.text)), 1) is None
    assert printed(_Candidate(replace(passage, table=None)), 1) is None  # a table whose cells were not read
    assert printed(_Candidate(passage, passage.table.cells[3]), 37) == "37"


def test_a_cell_without_a_box_links_its_segment_but_locates_the_value_in_the_cell():
    passage = table_passage()
    cell = passage.table.cells[3]
    links, _, issues = verify([passage], {"year": 37}, SCHEMA, CountingChat(lambda s, u, schema: {
        claim: {"label": "E5", "attribution": True} for claim in schema["properties"]}), record=0,
        counter=WordCounter(), record_context="A", span_ids=True, located=True)
    assert not issues and links[0].precision == "segment" and links[0].cell is None
    assert links[0].location == {"spans": [{"segment": "p1_s0", "start": cell.start, "end": cell.end}], "raw": "37"}


@pytest.mark.parametrize("text,quote,expected", [("Survey site: Cedar Bay north", "Survey site:", "Cedar Bay"),
                                                   ("Site: Cedar Bay north, Cedar Bay south", "Cedar Bay south", None)])
def test_a_quoted_link_is_located_from_its_value_never_its_quote(text, quote, expected):
    chat = CountingChat(lambda s, u, schema: {
        claim: {"label": "E1", "quote": quote, "attribution": True} for claim in schema["properties"]})
    links, _, issues = verify(passages([text]), {"site": "Cedar Bay"}, SCHEMA, chat, record=0, counter=WordCounter(),
                              record_context="A", quoted=True, located=True)
    assert not issues and (links[0].location and links[0].location["raw"]) == expected


def test_only_a_located_verification_locates():
    passage = passages(["Survey site: Cedar Bay"])[0]
    chat = CountingChat(lambda s, u, schema: {claim: "E1" for claim in schema["properties"]})
    [link], _, _ = verify([passage], {"site": "Cedar Bay"}, SCHEMA, chat, record=0)
    assert link.location is None and "location" not in link_json(link)
    assert any("location" in link for link in scripted_artifact()["evidence"])  # Article asks


def test_link_json_writes_the_shared_contract():
    passage = Passage(id="p1_s3", page=1, index=3, text=FIXTURE["passage_text"], label="Text",
                      bbox_pt=(34.0, 100.5, 170.75, 116.5), extent="block")
    link = _link(("records", 0, "site_name"), _Candidate(passage), True, "model",
                 _location(_Candidate(passage), "Cedar Bay"))
    assert link_json(link) == FIXTURE["with_location"] and list(link_json(link)) == list(FIXTURE["with_location"])
    assert link_json(replace(link, location=None)) == FIXTURE["without_location"]

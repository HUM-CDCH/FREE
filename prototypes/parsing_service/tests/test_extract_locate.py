"""Locating a quoted value in a block's own text: normalised matching, raw code-point spans back (design §2).

A block's text is its primary spans in order, joined by separators that belong to no segment. Matching is done on a
normalised view (NFKC, case folded, whitespace collapsed, soft hyphens dropped, a line-end hyphen joined) that keeps
a map to raw offsets, so every match comes back as spans of canonical segment text and never covers a separator.
"""
from kei_exp.kie.extract.locate import BlockText, forms, locate
from kei_exp.kie.model import Span

TEXT = "9. Großenhain. Fdpl. Mühle. Mbl. 2457 (4335). FA: G. Groß-\nsteingrab mit ﬂacher Schale."
SECOND = "Mus. Halle 12. Mbl. 2457 steht auch hier."


def block() -> BlockText:
    return BlockText.of([("p1_s1", TEXT, Span(segment_id="p1_s1", start=0, end=len(TEXT))),
                         ("p1_s2", SECOND, Span(segment_id="p1_s2", start=0, end=len(SECOND)))])


def raw(spans: list[Span]) -> str:
    texts = {"p1_s1": TEXT, "p1_s2": SECOND}
    return "|".join(texts[span.segment_id][span.start:span.end] for span in spans)


def test_an_exact_quote_is_one_span_of_raw_text():
    (found,) = locate(block(), "Großenhain")
    assert raw(found) == "Großenhain" and found[0].start == 3


def test_sharp_s_and_case_match_through_the_normalised_view():
    (found,) = locate(block(), "GROSSENHAIN")
    assert raw(found) == "Großenhain"


def test_a_combining_diaeresis_matches_a_precomposed_quote_and_keeps_both_raw_code_points():
    (found,) = locate(block(), "Mühle")
    assert raw(found) == "Mühle" and found[0].end - found[0].start == 6


def test_a_ligature_matches_its_letters():
    (found,) = locate(block(), "flacher")
    assert raw(found) == "ﬂacher"


def test_a_line_end_hyphen_is_joined_and_the_span_covers_the_raw_break():
    (found,) = locate(block(), "Großsteingrab")
    assert raw(found) == "Groß-\nsteingrab"


def test_repeated_text_comes_back_as_alternative_locations_never_one_value():
    found = locate(block(), "Mbl. 2457")
    assert [raw(spans) for spans in found] == ["Mbl. 2457", "Mbl. 2457"]
    assert [spans[0].segment_id for spans in found] == ["p1_s1", "p1_s2"]


def test_a_quote_across_the_block_boundary_is_split_at_the_separator():
    (found,) = locate(block(), "Schale. Mus. Halle")
    assert [span.segment_id for span in found] == ["p1_s1", "p1_s2"]
    assert raw(found) == "Schale.|Mus. Halle"


def test_text_the_block_does_not_hold_is_not_found():
    assert locate(block(), "Stockhof") == []
    assert locate(block(), "   ") == []


def found(value, text: str) -> list[str]:
    """Where a typed value is printed in `text`, as the extraction checks it."""
    view = BlockText.of([("p1_s9", text, Span(segment_id="p1_s9", start=0, end=len(text)))])
    numeric = isinstance(value, (int, float)) and not isinstance(value, bool)
    return [text[spans[0].start:spans[-1].end] for form in forms(value) for spans in locate(view, form, numeric=numeric)]


def test_a_value_is_found_as_its_type_prints_it_and_only_as_a_whole():
    assert found("Großenhain", "Großenhain. Fdpl.") == ["Großenhain"]
    assert found(2457, "Mbl. 2457 (4335)") == ["2457"] and found(245, "Mbl. 2457 (4335)") == []
    assert found(0.6, "Wdg. 0,6/0,7") == ["0,6"] and found(1827.0, "1827 (3436)") == ["1827"]
    assert found(1.234567, "Tiefe 1.23457") == [] and found(1.23457, "Tiefe 1.23457") == ["1.23457"]
    assert found(245, "Mbl. 245.7") == [] and found(7, "Mbl. 245.7") == [] and found(245.7, "Mbl. 245,7") == ["245,7"]
    assert found(2, "Mbl. -2") == [] and found(-2, "Mbl. -2") == ["-2"] and found(1828, "Mbl. 1827-1828") == ["1828"]
    # A sign may stand apart from its number; a hyphen after a number is a range, spaced or not.
    assert found(2, "Mbl. - 2") == [] and found(2, "Mbl. \u2212 2") == [] and found(2458, "Mbl. 2457 - 2458") == ["2458"]
    # A number after a bare decimal separator is a fraction; after an abbreviation's period it is a number.
    assert found(2, "Mbl. -.2") == [] and found(2, "Tiefe .2") == [] and found(2, "Nr.2") == ["2"]
    assert found(2, "Mbl. (.2)") == [] and found(2, "[.2]") == []
    # Only a number before a hyphen or dash makes it a range; after a word it is a sign.
    assert found(2, "OT - 2") == [] and found(2, "OT -2") == [] and found(-2, "OT -2") == ["-2"]
    assert found(2, "Mbl. \u20132") == [] and found(1828, "Mbl. 1827 \u2013 1828") == ["1828"]
    # Exponent-sized values are printed and matched in full, never rounded to six places.
    assert found(0.00001234567, "Tiefe 0.000012") == [] and found(1e-7, "Tiefe 0.") == []
    assert found(0.00001234567, "Tiefe 0.00001234567") == ["0.00001234567"]


def test_a_match_never_takes_part_of_what_one_source_character_expands_to():
    assert found(1, "Mbl. \u00bd") == [] and found("1", "Mbl. \u00bd") == []  # ½ reads as 1⁄2
    assert found(2, "Mbl. \u00bd") == [] and found(1, "Mbl. \u00bc") == []
    assert found("flacher", "mit \ufb02acher Schale") == ["\ufb02acher"]  # a whole expansion is matched
"""Locating a quoted value in a block's own text: normalised matching, raw code-point spans back (design §2).

A block's text is its primary spans in order, joined by separators that belong to no segment. Matching is done on a
normalised view (NFKC, case folded, whitespace collapsed, soft hyphens dropped, a line-end hyphen joined) that keeps
a map to raw offsets, so every match comes back as spans of canonical segment text and never covers a separator.
"""
from kei_exp.kie.blocks import Span
from kei_exp.kie.extract.locate import BlockText, _bounded, forms, locate, nearly, printed

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
    assert found(0.6, "Wdg. 0,6") == ["0,6"] and found(1827.0, "1827 (3436)") == ["1827"]
    assert found(1.234567, "Tiefe 1.23457") == [] and found(1.23457, "Tiefe 1.23457") == ["1.23457"]
    assert found(245, "Mbl. 245.7") == [] and found(7, "Mbl. 245.7") == [] and found(245.7, "Mbl. 245,7") == ["245,7"]
    assert found(2, "Mbl. -2") == [] and found(-2, "Mbl. -2") == ["-2"] and found(1828, "Mbl. 1827-1828") == ["1828"]
    # A sign may stand apart from its number; a hyphen after a number is a range, spaced or not.
    assert found(2, "Mbl. - 2") == [] and found(2, "Mbl. \u2212 2") == [] and found(2458, "Mbl. 2457 - 2458") == ["2458"]
    # A number after a bare decimal separator is a fraction; after an abbreviation's period it is a number.
    assert found(2, "Mbl. -.2") == [] and found(2, "Tiefe .2") == [] and found(2, "Nr.2") == ["2"]
    assert found(2, "Mbl. (.2)") == [] and found(2, "[.2]") == []
    # Text extraction may space a number's separator (`0 . 02`): its parts are not printings. A comma with a space after
    # it only lists numbers; after a word, a spaced period is still an abbreviation's.
    assert found(2, "± 0 . 02 and") == [] and found(2, "0 .02") == [] and found(2, "0. 02") == []
    assert found(1, "a = 1 . 20 ×") == [] and found(20, "a = 1 . 20 ×") == [] and found(18, "18 , 20") == []
    assert found(5, "v1 . 5") == [] and found(20, "18, 20 and 22") == ["20"] and found(2, "Nr . 2") == ["2"]
    # Only a number before a hyphen or dash makes it a range; after a word it is a sign.
    assert found(2, "OT - 2") == [] and found(2, "OT -2") == [] and found(-2, "OT -2") == ["-2"]
    assert found(2, "Mbl. \u20132") == [] and found(1828, "Mbl. 1827 \u2013 1828") == ["1828"]
    # Exponent-sized values are printed and matched in full, never rounded to six places.
    assert found(0.00001234567, "Tiefe 0.000012") == [] and found(1e-7, "Tiefe 0.") == []
    assert found(0.00001234567, "Tiefe 0.00001234567") == ["0.00001234567"]


def test_a_narrow_space_after_an_ordinal_leaves_it_whole_and_a_spaced_decimal_keeps_its_fraction():
    assert found(7, "7.\u202fJahrhundert") == ["7"]  # an ordinal's period, then a narrow no-break space
    assert locate(one("error 0 . 02 b"), "02", numeric=True) == []
    assert locate(one("value 0 . 20"), "20", numeric=True) == []


def test_a_slash_between_digits_joins_them():
    assert found(2, "value 1/2 here") == [] and found(1, "value 1/2 here") == [] and found(2, "1\u20442") == []
    assert found(0.6, "Wdg. 0,6/0,7") == [] and found(0.7, "Wdg. 0,6/0,7") == []
    assert found(2, "value 1/ 2 here") == ["2"]  # a spaced slash lists them


def test_a_grouping_space_or_apostrophe_before_three_digits_may_join_them():
    for grouped in ("1 234", "1'234", "1\u2019234", "1\u202f234", "1\u2009234", "1\u00a0234", "1 234.5"):
        assert found(234, f"value {grouped} here") == [] and found(1, f"value {grouped} here") == []
    # Not 3 digits, or not one grouping character: two numbers. A marker before a 3-digit page is refused too.
    assert found(12, "Nr. 12 3456") == ["12"] and found(234, "value 1\t234 here") == ["234"]
    assert found(234, "value 1  234 here") == ["234"] and found(234, "row 1\n234") == ["234"]
    assert found(7, "SD 7 122  (ca.") == [] and found(122, "SD 7 122  (ca.") == []


def test_a_plus_before_a_number_is_its_sign():
    assert found(42, "value +42 here") == [] and found(42, "value + 42 here") == [] and found(42, "3+42") == ["42"]


def test_no_part_of_an_exponent_form_is_a_whole_number():
    for text in ("1.8e1", "1.8E+1", "1.8×10^1", "1.8 x 10^ 1", "1.8 · 10^-1"):
        assert found(1.8, f"sample {text}.") == [] and found(1, f"sample {text}.") == []
    assert found(10, "sample 1.8×10^1.") == [] and found(10, "size 3 × 10 cm") == ["10"]
    assert found(3, "size 3 × 10 cm") == ["3"]


def test_a_combining_mark_belongs_to_the_word_it_follows():
    assert not _bounded("cafe\u0301 noir", 0, 4) and not _bounded("2005\u0338 x", 0, 4)
    assert not _bounded("x\u0301abc", 2, 5) and _bounded("cafe noir", 0, 4)
    assert locate(one("caf\u0065\u0301 noir"), "cafe") == [] and found(2005, "year 2005\u0338 x") == []


def test_a_match_never_takes_part_of_what_one_source_character_expands_to():
    assert found(1, "Mbl. \u00bd") == [] and found("1", "Mbl. \u00bd") == []  # ½ reads as 1⁄2
    assert found(2, "Mbl. \u00bd") == [] and found(1, "Mbl. \u00bc") == []
    assert found("flacher", "mit \ufb02acher Schale") == ["\ufb02acher"]  # a whole expansion is matched

# --- nearly verbatim text ---------------------------------------------------------------------------------------------

NOTE = ("The lighthouse keeper logged a calm night with light rain from the west, two cargo ships passing well offshore "
        "and a small sailing boat that anchored in the bay until dawn.")


def one(text: str) -> BlockText:
    return BlockText.of([("p1_s1", text, Span(segment_id="p1_s1", start=0, end=len(text)))])


def test_a_quote_a_few_edits_off_is_found_at_its_one_place():
    view = one(f"Log. {NOTE} End.")
    (found,) = nearly(view, NOTE.replace("small ", ""), 6)
    assert view.text[found[0].start:found[-1].end] == NOTE


def test_two_places_within_the_bound_are_both_returned():
    twin = NOTE.replace("small ", "").replace("dawn", "noon")
    assert len(nearly(one(f"{NOTE} {twin}"), NOTE.replace("small ", ""), 6)) == 2


def test_a_place_inside_a_longer_word_is_not_a_place():
    text = "The reconstructed harbour wall stood on a stone footing laid in the dry summer of that year."
    assert nearly(one(text), "constructed harbour wall stood on a stone footing laid in the dry", 3) == []


def test_text_too_repetitive_to_tell_one_place_from_another_gives_none():
    rows = "\n".join(f"{n}\tTooth, human\tLevel 6\tWell preserved" for n in range(1, 40))
    assert nearly(one(rows), "Tooth, human\tLevel 6\tWell preservd", 3) == []


def test_two_copies_of_a_repetitive_passage_are_never_one_place():
    """Seeds every few characters must not chain one group across both copies, which would fit only one of them."""
    passage = ("unknown " * 100)[:799]
    quote = passage[:400] + "x" + passage[401:]
    assert len(nearly(one(f"{passage} END OF ITEM {passage}"), quote, 15)) != 1


def test_printed_text_joins_a_word_hyphenated_at_a_break_and_drops_soft_hyphens():
    assert printed("Groß-\nsteingrab mit Trag\xadsteinen, Nord-\nSüd") == "Großsteingrab mit Tragsteinen, Nord- Süd"

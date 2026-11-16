"""Source windows shared by Catalog discovery and native fields."""
from kei_exp.kie.extract.windows import Unit, windows_of

def lines(text):
    units, position = [], 0
    for raw in text.split("\n"):
        start, end = position + len(raw) - len(raw.lstrip()), position + len(raw.rstrip())
        if end > start:
            units.append(Unit("s", start, end))
        position += len(raw) + 1
    return units, {"s": text}

def words_at_most(limit: int, texts: dict):
    return lambda window: sum(len(texts[unit.segment][unit.start:unit.end].split()) for unit in window) <= limit


def shown(windows: list, texts: dict) -> list[list[str]]:
    return [[texts[unit.segment][unit.start:unit.end] for unit in window] for window in windows]


def test_windows_fit_the_predicate_and_overlap_by_one_unit_only_when_asked():
    units, texts = lines("one\n  two \nthree\n\nfour\nfive")
    assert shown([units], texts) == [["one", "two", "three", "four", "five"]]  # source lines, trimmed, blanks dropped
    assert shown(windows_of(units, texts, words_at_most(2, texts), overlap=True), texts) == [
        ["one", "two"], ["two", "three"], ["three", "four"], ["four", "five"]]
    assert shown(windows_of(units, texts, words_at_most(2, texts), overlap=False), texts) == [
        ["one", "two"], ["three", "four"], ["five"]]


def test_a_line_too_long_for_any_window_is_cut_at_whitespace_and_nothing_fits_means_no_windows():
    units, texts = lines("epsilon zeta eta")
    windows = windows_of(units, texts, words_at_most(2, texts), overlap=True)
    assert shown(windows, texts) == [["epsilon zeta"], ["eta"]]
    assert windows_of(units, texts, lambda window: False, overlap=True) is None


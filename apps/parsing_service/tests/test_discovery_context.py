"""Heading context fits around primary source; every omitted excerpt keeps its canonical identity."""
from kei_exp.kie.extract import discovery
from kei_exp.kie.extract.windows import Unit


def rendered(window, texts):
    """An exact character-counted request, with every shown source role included in the budget."""
    return "\n".join(f"{name}\n{discovery.text_of(units, texts)}" for name, units in (
        ("PRIMARY", window.primary), ("BEFORE", window.before), ("AFTER", window.after), ("HEADING", window.heading))
        if units)


def whole(segment, texts):
    return Unit(segment, 0, len(texts[segment]))


def test_heading_selection_preserves_primary_and_overlap_when_the_whole_context_cannot_fit():
    texts = {"p1_s0": "H" * 200, "p1_s1": "new", "p1_s2": "lead", "p1_s7": "trail"}
    texts.update({f"p1_s{n}": f"record {n}: " + "x" * 8 for n in range(3, 7)})
    primary = [whole(f"p1_s{n}", texts) for n in range(3, 7)]
    headings = (whole("p1_s0", texts), whole("p1_s1", texts))
    fits = lambda window: len(rendered(window, texts)) <= 100
    options = {"overlap": 1, "lead": [whole("p1_s2", texts)], "trail": [whole("p1_s7", texts)]}
    baseline = discovery.plan(primary, texts, fits, **options)
    selected = discovery.plan(primary, texts, fits, heading=headings, **options)

    assert len(baseline) > 1
    assert [(window.primary, window.before, window.after) for window in selected] == \
        [(window.primary, window.before, window.after) for window in baseline]
    assert [unit for window in selected for unit in window.primary] == primary
    for window in selected:
        assert fits(window)
        assert set(window.heading) | set(window.dropped("heading")) == set(headings)
        assert len(window.heading) + len(window.dropped("heading")) == len(headings)
        assert whole("p1_s0", texts) in window.dropped("heading")


def test_newest_first_selection_skips_an_oversized_excerpt_but_keeps_smaller_older_context():
    texts = {"p1_s0": "older small", "p2_s0": "not context " + "x" * 200 + " not context",
             "p3_s0": "new", "p4_s0": "record" * 8}
    old, new = whole("p1_s0", texts), whole("p3_s0", texts)
    oversized = Unit("p2_s0", len("not context "), len("not context ") + 200)
    primary = (whole("p4_s0", texts),)
    limit = len(rendered(discovery.Window(primary, heading=(old, new)), texts))
    fits = lambda window: len(rendered(window, texts)) <= limit

    [selected] = discovery.plan(primary, texts, fits, overlap=0, heading=(old, oversized, new))

    assert selected.primary == primary and selected.heading == (old, new)
    assert selected.omitted == (("heading", oversized),)
    assert texts[oversized.segment][oversized.start:oversized.end] == "x" * 200
    assert len(rendered(selected, texts)) == limit


def test_when_only_one_excerpt_fits_the_latest_one_is_retained():
    texts = {"p2_s0": "old", "p10_s0": "new", "p11_s0": "record"}
    old, new, record = (whole(segment, texts) for segment in texts)
    limit = len(rendered(discovery.Window((record,), heading=(new,)), texts))
    [selected] = discovery.plan([record], texts, lambda window: len(rendered(window, texts)) <= limit,
                                overlap=0, heading=(old, new))
    assert selected.heading == (new,) and selected.omitted == (("heading", old),)
    assert selected.primary == (record,)


def test_equal_printed_headings_at_different_source_locations_remain_distinct():
    texts = {"p2_s0": "Heading", "p10_s0": "Heading", "p11_s0": "record"}
    old, new, record = (whole(segment, texts) for segment in texts)
    limit = len(rendered(discovery.Window((record,), heading=(old, new)), texts))
    [selected] = discovery.plan([record], texts, lambda window: len(rendered(window, texts)) <= limit,
                                overlap=0, heading=(old, new))
    assert selected.heading == (old, new) and not selected.omitted


def test_split_reconsiders_omitted_excerpts_in_canonical_passage_and_offset_order():
    texts = {"p2_s0": "old\nsmall", "p10_s0": "new", "p11_s0": "a" * 30, "p12_s0": "b" * 30}
    first, middle = Unit("p2_s0", 0, 3), Unit("p2_s0", 4, 9)
    last = whole("p10_s0", texts)
    primary = (whole("p11_s0", texts), whole("p12_s0", texts))
    limit = len(rendered(discovery.Window(primary, heading=(first, last)), texts))
    fits = lambda window: len(rendered(window, texts)) <= limit
    [parent] = discovery.plan(primary, texts, fits, overlap=0, heading=(first, middle, last))
    assert parent.heading == (first, last) and parent.omitted == (("heading", middle),)

    children = discovery.split(parent, texts, fits, overlap=0)

    assert [window.primary for window in children] == [(primary[0],), (primary[1],)]
    for child in children:
        assert child.heading == (first, middle, last)  # source order, not lexical p10 before p2
        assert not child.omitted and fits(child)


def test_no_heading_plan_and_split_keep_the_existing_primary_and_overlap_windows():
    texts = {"p1_s0": "first", "p1_s1": "second", "p1_s2": "third"}
    first, second, third = (whole(segment, texts) for segment in texts)
    limit = len(rendered(discovery.Window((first, second), after=(third,)), texts))
    fits = lambda window: len(window.primary) <= 2 and len(rendered(window, texts)) <= limit
    planned = discovery.plan([first, second, third], texts, fits, overlap=1)
    assert planned == [discovery.Window((first, second), after=(third,)),
                       discovery.Window((third,), before=(second,))]
    assert discovery.plan([first, second, third], texts, fits, overlap=1, heading=()) == planned
    assert discovery.split(planned[0], texts, lambda _: True, overlap=1) == [
        discovery.Window((first,), after=(second,)),
        discovery.Window((second,), before=(first,), after=(third,)),
    ]

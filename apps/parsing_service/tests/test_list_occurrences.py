"""List occurrences across several readings of one document: Article's root, its document-level fields and the unified
Catalog's document-level fields are assembled by `contexts.assemble_document`.

Every item one reading returned is an occurrence, equal ones included. An equal item two readings returned is one
occurrence only when they were shown source in common (an overlap passage or line); it is joined once and named. Equal
items from readings over disjoint source stay, named as possible repeats. No schema declares set semantics, so nothing
is deduplicated by value alone. `reconcile_values`' exact union stays only for the replays of captured studies.
"""
import json
import re

from kei_exp.kie.extract import article, contexts, unified
from kei_exp.kie.extract.assembly import document_values
from kei_exp.kie.extract.contexts import Context
from kei_exp.kie.extract.method import ArticleOptions
from kei_exp.kie.extract.schema import Schema
from tests.test_extract_grounded import CountingChat, WordCounter
from tests.test_extract_stages import evidence, passages
from tests.test_unified_catalog import SCHEMA as CATALOG
from tests.test_unified_catalog import Model, candidate, extract
from tests.test_unified_catalog import evidence as catalogue


def every(first: int, second: int, item) -> bool:
    return True


def test_equal_items_of_one_reading_are_distinct_occurrences():
    readings = [{"fees": [10, 10], "refs": ["A"]}, {"fees": [5], "refs": None}]
    for shared in (contexts.assemble_document.__defaults__[0], every):
        root, conflicts, repeats, joined = contexts.assemble_document(readings, shared)
        assert root == {"fees": [10, 10, 5], "refs": ["A"]} and (conflicts, repeats, joined) == ([], [], [])
    assert contexts.reconcile_values(readings)[0]["fees"] == [10, 5]  # the legacy union this replaces


def test_the_same_occurrence_read_by_overlapping_readings_is_joined_once_and_named():
    readings = [{"fees": [10, 20]}, {"fees": [20, 30]}]
    root, _, repeats, joined = contexts.assemble_document(readings, every)
    assert root == {"fees": [10, 20, 30]} and repeats == []
    assert joined == [{"path": ["fees"], "contexts": [0, 1], "index": 1}]
    # one to one: a reading that saw two of them keeps both; the other's single one joins the first
    root, _, repeats, joined = contexts.assemble_document([{"x": ["a"]}, {"x": ["a", "a"]}], every)
    assert root == {"x": ["a", "a"]} and joined == [{"path": ["x"], "contexts": [0, 1], "index": 0}]
    assert repeats == [{"path": ["x"], "contexts": [0, 1], "indices": [0, 1]}]


def test_equal_items_of_disjoint_readings_are_kept_and_named_as_possible_repeats():
    root, _, repeats, joined = contexts.assemble_document([{"fees": [10]}, {"fees": [10]}])
    assert root == {"fees": [10, 10]} and joined == []
    assert repeats == [{"path": ["fees"], "contexts": [0, 1], "indices": [0, 1]}]


def test_sharing_is_pairwise_along_a_chain_of_overlaps():
    """0 and 1 share a passage, 1 and 2 share one, 0 and 2 none: an item all three read is one occurrence; one only
    0 and 2 read is two, named."""
    chain = {(0, 1), (1, 0), (1, 2), (2, 1)}
    readings = [{"x": ["shared", "far"]}, {"x": ["shared"]}, {"x": ["shared", "far"]}]
    root, _, repeats, joined = contexts.assemble_document(readings, lambda a, b, item: (a, b) in chain)
    assert root == {"x": ["shared", "far", "far"]}
    assert joined == [{"path": ["x"], "contexts": [0, 1, 2], "index": 0}]
    assert repeats == [{"path": ["x"], "contexts": [0, 2], "indices": [1, 2]}]


def test_nested_lists_keep_their_items_and_join_whole_items_only():
    first = {"site": {"finds": [{"kind": "urn", "materials": ["clay", "clay"]}]}}
    second = {"site": {"finds": [{"kind": "urn", "materials": ["clay", "clay"]}, {"kind": "urn", "materials": ["clay"]}]}}
    root, _, repeats, joined = contexts.assemble_document([first, second], every)
    assert root == {"site": {"finds": [{"kind": "urn", "materials": ["clay", "clay"]},
                                       {"kind": "urn", "materials": ["clay"]}]}}
    assert joined == [{"path": ["site", "finds"], "contexts": [0, 1], "index": 0}] and repeats == []
    root, *_ = contexts.assemble_document([first, second])
    assert root["site"]["finds"] == [*first["site"]["finds"], *second["site"]["finds"]]


def test_order_is_reading_order_then_reply_order_and_repeatable():
    readings = [{"x": ["c", "a"]}, {"x": ["b", "a", "d"]}, {"x": ["a"]}]
    results = {json.dumps(contexts.assemble_document(readings, every)) for _ in range(5)}
    assert len(results) == 1
    root, _, _, joined = contexts.assemble_document(readings, every)
    assert root == {"x": ["c", "a", "b", "d"]} and joined == [{"path": ["x"], "contexts": [0, 1, 2], "index": 1}]
    assert contexts.assemble_document(readings[::-1], every)[0] == {"x": ["a", "b", "d", "c"]}


def test_value_contexts_share_overlap_passages_but_not_the_repeated_heading():
    p = passages(["H", "one", "two", "three"])
    units = [Context((p[1], p[2]), (), p[0]), Context((p[3],), (p[2],), p[0]), Context((p[3],), (), p[0])]
    shared = contexts.sharing(units)
    assert shared(0, 1, "two") and not shared(0, 1, "one") and not shared(0, 2, "three") and not shared(0, 1, True)
    assert shared(1, 2, {"n": "Three", "k": None}) and not shared(0, 1, "H")  # case aside; not the heading


def test_an_item_is_printed_only_as_a_bounded_token():
    """A `10` is not printed in "2010", "100" or "x10"; "x" not in "tax"; an integral float as its integer."""
    for text in ("see 2010 annual report", "100 units", "item x10"):
        assert not contexts.printed_once_in(10, text)
    assert contexts.printed_once_in(10, "fee: 10%") and contexts.printed_once_in(1827.0, "dated 1827.")
    assert not contexts.printed_once_in({"a": "x"}, "tax") and contexts.printed_once_in({"a": "X", "b": None}, "row x.")
    p = passages(["Charge 10.", "See the 2010 report.", "Charge 10."])
    shared = contexts.sharing([Context((p[0], p[1])), Context((p[2],), (p[1],))])
    root, _, _, joined = contexts.assemble_document([{"c": [10]}, {"c": [10]}], shared)
    assert root == {"c": [10, 10]} and joined == []


def test_an_item_joins_only_where_the_shared_source_prints_it():
    """The second context's `10` is read from its own primary passage, not the overlap, so it is another occurrence."""
    p = passages(["Charge 10.", "Charge 20.", "Charge 10."])
    shared = contexts.sharing([Context((p[0], p[1])), Context((p[2],), (p[1],))])
    root, _, repeats, joined = contexts.assemble_document([{"c": [10, 20]}, {"c": [20, 10]}], shared)
    assert root == {"c": [10, 20, 10]} and joined == [{"path": ["c"], "contexts": [0, 1], "index": 1}]
    assert repeats == [{"path": ["c"], "contexts": [0, 1], "indices": [0, 2]}]


# --- through the callers -------------------------------------------------------------------------------------------

DOCUMENT_FIELDS = Schema.model_validate({"recordDescription": "One excavation report.", "schemaNodes": [
    {"id": "t", "name": "title", "type": "string"},
    {"id": "c", "name": "charges", "type": "array", "itemType": "integer", "valueSource": "document"},
    {"id": "f", "name": "finds", "type": "array", "children": [
        {"id": "k", "name": "kind", "type": "string"},
        {"id": "m", "name": "materials", "type": "array", "itemType": "string"}]},
]})
SOURCE = passages(["Charge 10. Charge 10. A sword.", "Overlap: an urn of clay, clay. Charge 20.", "Charge 10. A spear."])
OVERLAPPING = [Context((SOURCE[0], SOURCE[1])), Context((SOURCE[2],), (SOURCE[1],))]
DISJOINT = [Context((SOURCE[0], SOURCE[1])), Context((SOURCE[2],))]


def reader(system, user, schema):
    """A careful reader: every occurrence the shown text prints, in order."""
    props = schema["properties"]
    if "charges" in props:
        return {"charges": [int(m) for m in re.findall(r"Charge (\d+)", user)] or None}
    finds = [{"kind": m[1], "materials": m[2].split(", ") if m[2] else None}
             for m in re.finditer(r"(?:A|an) (sword|urn|spear)(?: of ([a-z, ]+[a-z]))?", user)]
    return {"title": None, "finds": finds or None}


def test_article_document_fields_keep_every_occurrence_and_join_an_overlap_repeat():
    document, conflicts, _, issues = document_values(evidence(SOURCE), OVERLAPPING, DOCUMENT_FIELDS,
                                                     CountingChat(reader), budget=24000, check=lambda: None)
    assert document == {"charges": [10, 10, 20, 10]} and conflicts == []  # the union kept [10, 20]
    codes = {issue.code: issue for issue in issues}
    assert json.loads(codes["overlap_items_joined"].detail) == {"path": ["charges"], "contexts": [0, 1], "index": 2}
    assert codes["overlap_items_joined"].path == ("charges",) and codes["overlap_items_joined"].record is None
    assert json.loads(codes["possible_repeated_items"].detail)["indices"] == [0, 1, 3]
    document, _, _, issues = document_values(evidence(SOURCE), DISJOINT, DOCUMENT_FIELDS, CountingChat(reader),
                                             budget=24000, check=lambda: None)
    assert document == {"charges": [10, 10, 20, 10]} and "overlap_items_joined" not in {i.code for i in issues}


def test_the_article_root_joins_a_nested_item_its_overlapping_contexts_both_read():
    counters = {role: WordCounter() for role in ("fields", "reasoning")}
    found = article.document_root(SOURCE, DOCUMENT_FIELDS, CountingChat(reader), counters=counters,
                                  record_chars=24000, check=lambda: None, method=ArticleOptions(),
                                  contexts=OVERLAPPING)
    (_, root), = found.slices
    assert root["finds"] == [{"kind": "sword", "materials": None}, {"kind": "urn", "materials": ["clay", "clay"]},
                             {"kind": "spear", "materials": None}]
    (joined,) = [issue for issue in found.issues if issue.code == "overlap_items_joined"]
    assert json.loads(joined.detail) == {"path": ["finds"], "contexts": [0, 1], "index": 1}
    assert joined.path == ("records", 0, "finds") and joined.record == 0
    found = article.document_root(SOURCE, DOCUMENT_FIELDS, CountingChat(reader), counters=counters,
                                  record_chars=24000, check=lambda: None, method=ArticleOptions(), contexts=DISJOINT)
    assert [item["kind"] for item in found.slices[0][1]["finds"]] == ["sword", "urn", "spear"]


KEYWORDS = {**CATALOG, "schemaNodes": [*CATALOG["schemaNodes"][:-1],
            {"id": "k", "name": "keywords", "type": "array", "itemType": "string", "valueSource": "document"}]}


class Careless(Model):
    """Reports a document keyword wherever it is shown, context included, as a model might."""

    def __call__(self, system, user, schema):
        if system.startswith("You extract fields that describe"):
            return {"keywords": [candidate(m[1], m[0]) for m in re.finditer(r"Keyword: (\w+)", user)] or None}
        return super().__call__(system, user, schema)


def keywords(source, **settings):
    result, _ = extract(source, Careless(source), schema=KEYWORDS, input_tokens=520, output_tokens=64, **settings)
    issues = {issue["code"]: json.loads(issue["detail"]) for issue in result["issues"]
              if issue["code"] in ("overlap_items_joined", "possible_repeated_items")}
    return result, issues


def test_unified_document_fields_keep_one_windows_equal_items():
    result, issues = keywords(catalogue("Keyword: Grab. Keyword: Grab. Keyword: Hort.", "1. Adorf. Material: Holz."))
    assert result["processing"]["document"]["windows"] == 1
    assert result["records"][0]["keywords"] == ["Grab", "Grab", "Hort"] and issues == {}  # the union kept one Grab
    assert result["document_version"] == unified.DOCUMENT_VERSION == 3


def test_unified_document_fields_join_the_overlap_line_and_keep_distant_equal_items():
    filler = " ".join(["Text"] * 300)
    result, issues = keywords(catalogue(f"{filler}\nKeyword: Grab.\n{filler}", "1. Adorf. Material: Holz."))
    assert result["processing"]["document"]["windows"] == 3
    assert result["records"][0]["keywords"] == ["Grab"]
    assert issues == {"overlap_items_joined": {"path": ["keywords"], "contexts": [0, 1, 2], "index": 0}}
    result, issues = keywords(catalogue("Keyword: Grab.\n" + " ".join(["Text"] * 700) + "\nKeyword: Grab.",
                                        "1. Adorf. Material: Holz."), overlap=0)
    assert result["records"][0]["keywords"] == ["Grab", "Grab"]
    assert issues == {"possible_repeated_items": {"path": ["keywords"], "contexts": [0, 2], "indices": [0, 1]}}


def test_a_value_the_overlap_prints_twice_is_not_joined_on_that_alone():
    """Two genuine charges of 10 lie in the overlap passage; each context returned one of them. Finding 10 in the shared
    source does not say which occurrence either context read, so both are kept and named as possible repeats."""
    p = passages(["Fees.", "Charge 10 for delivery. Charge 10 for handling.", "Totals."])
    shared = contexts.sharing([Context((p[0], p[1])), Context((p[2],), (p[1],))])
    root, _, repeats, joined = contexts.assemble_document([{"c": [10]}, {"c": [10]}], shared)
    assert root == {"c": [10, 10]} and joined == []
    assert repeats == [{"path": ["c"], "contexts": [0, 1], "indices": [0, 1]}]

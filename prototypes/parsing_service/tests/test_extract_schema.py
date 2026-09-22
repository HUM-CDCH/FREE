"""FREE's schema tree, accepted verbatim and turned into the JSON schema and field notes a model call needs."""
import pytest
from pydantic import ValidationError

from kei_exp.kie.extract.schema import Schema, conform, describe, json_schema, notes, records_schema

TREE = {
    "recordDescription": "One catalogue entry: a numbered find with its site and dating.",
    "schemaNodes": [
        {"id": "no", "name": "entry_no", "type": "verbatim-string", "description": "the printed entry number"},
        {"id": "site", "name": "site", "type": "string"},
        {"id": "sex", "name": "sex", "type": "string", "allowedValues": ["mand", "kvinde", "ukendt"]},
        {"id": "year", "name": "year", "type": "integer"},
        {"id": "finds", "name": "finds", "type": "array", "itemType": "string", "description": "one per object"},
        {"id": "dating", "name": "dating", "type": "object", "children": [
            {"id": "from", "name": "from", "type": "date"}, {"id": "to", "name": "to", "type": "date"}]},
        {"id": "refs", "name": "references", "type": "array", "children": [
            {"id": "author", "name": "author", "type": "string"}, {"id": "page", "name": "page", "type": "integer"}]},
        {"id": "title", "name": "title", "type": "string", "valueSource": "document"},
        {"id": "file", "name": "filename", "type": "string", "valueSource": "source-filename"},
    ],
}


def test_a_free_schema_round_trips_unchanged():
    schema = Schema.model_validate(TREE)
    assert schema.model_dump(by_alias=True, exclude_none=True) == TREE
    assert [n.name for n in schema.record_nodes] == ["entry_no", "site", "sex", "year", "finds", "dating", "references"]
    assert [n.name for n in schema.document_nodes] == ["title"]
    assert [n.name for n in schema.filename_nodes] == ["filename"]


@pytest.mark.parametrize("node, reason", [
    ({"id": "a", "name": "a", "type": "integer", "allowedValues": ["1"]}, "allowedValues"),
    ({"id": "a", "name": "a", "type": "array"}, "itemType or children"),
    ({"id": "a", "name": "a", "type": "object"}, "children"),
    ({"id": "a", "name": "a", "type": "string", "itemType": "string"}, "itemType"),
    ({"id": "a", "name": "a", "type": "object", "children": [
        {"id": "b", "name": "b", "type": "string", "valueSource": "document"}]}, "top-level"),
    ({"id": "a", "name": "a", "type": "string", "extra": 1}, "extra"),
    ({"id": "a", "name": "a", "type": "string", "allowedValues": ["mand"]}, "two or more"),
    ({"id": "a", "name": "a", "type": "string", "allowedValues": ["", "mand"]}, "empty value"),
    ({"id": "a", "name": "a", "type": "string", "allowedValues": ["mand", "string"]}, "field-type"),
])
def test_a_malformed_node_is_refused(node, reason):
    with pytest.raises(ValidationError, match=reason):
        Schema.model_validate({"recordDescription": "x", "schemaNodes": [node]})


@pytest.mark.parametrize("nodes, reason", [
    ([{"id": "1", "name": "a", "type": "string"}, {"id": "2", "name": "a", "type": "integer"}],
     "schema: .*'a' is used twice"),
    ([{"id": "1", "name": "b", "type": "object", "children": [
        {"id": "2", "name": "c", "type": "string"}, {"id": "3", "name": "c", "type": "date"}]}],
     "field 'b': .*'c' is used twice"),
    ([{"id": "1", "name": "b", "type": "array", "children": [
        {"id": "2", "name": "c", "type": "string"}, {"id": "3", "name": "c", "type": "string"}]}],
     "field 'b': .*'c' is used twice"),
])
def test_duplicate_sibling_names_are_refused(nodes, reason):
    """A record is a JSON object and the merge and the evidence paths address fields by name: two siblings sharing
    a name would silently lose one value while evidence still pointed at it."""
    with pytest.raises(ValidationError, match=reason):
        Schema.model_validate({"recordDescription": "x", "schemaNodes": nodes})


def test_the_same_name_at_different_levels_is_fine():
    schema = Schema.model_validate({"recordDescription": "x", "schemaNodes": [
        {"id": "1", "name": "a", "type": "string"},
        {"id": "2", "name": "b", "type": "object", "children": [{"id": "3", "name": "a", "type": "string"}]},
        {"id": "4", "name": "c", "type": "object", "children": [{"id": "5", "name": "a", "type": "string"}]}]})
    assert [node.name for node in schema.nodes] == ["a", "b", "c"]


def test_an_object_may_have_an_empty_children_list_free_has_no_minimum():
    """`children: SchemaNode[]` in FREE's union carries no `.min(1)`; only a missing `children` key is refused."""
    schema = Schema.model_validate(
        {"recordDescription": "x", "schemaNodes": [{"id": "a", "name": "a", "type": "object", "children": []}]})
    assert schema.nodes[0].children == []


def test_allowed_values_may_repeat_a_member_free_does_not_require_them_distinct():
    """FREE's `isAllowedValues` (allowed-values.ts:44-55) checks length >= 2, each member non-empty after trim,
    and none a field-type token — never uniqueness; a two-member list at that exact floor is also accepted."""
    schema = Schema.model_validate({"recordDescription": "x", "schemaNodes": [
        {"id": "a", "name": "a", "type": "string", "allowedValues": ["mand", "mand"]}]})
    assert schema.nodes[0].allowed_values == ["mand", "mand"]


def test_the_json_schema_makes_every_field_present_and_nullable_and_nothing_else_allowed():
    schema = Schema.model_validate(TREE)
    built = json_schema(schema.record_nodes)
    assert built["type"] == "object" and built["additionalProperties"] is False
    assert built["required"] == ["entry_no", "site", "sex", "year", "finds", "dating", "references"]
    assert built["properties"]["site"] == {"type": ["string", "null"]}
    assert built["properties"]["year"] == {"type": ["integer", "null"]}
    assert built["properties"]["sex"] == {"type": ["string", "null"], "enum": ["mand", "kvinde", "ukendt", None]}
    assert built["properties"]["finds"] == {"type": ["array", "null"], "items": {"type": "string"}}
    assert built["properties"]["dating"]["type"] == ["object", "null"]
    assert built["properties"]["dating"]["required"] == ["from", "to"]
    assert built["properties"]["references"]["items"]["properties"]["page"] == {"type": ["integer", "null"]}
    wrapped = records_schema(schema.record_nodes)
    assert wrapped["properties"]["records"]["items"] == built and wrapped["required"] == ["records"]


def test_notes_name_only_described_fields_with_dotted_paths():
    schema = Schema.model_validate(TREE)
    assert notes(schema.record_nodes) == ["- entry_no: the printed entry number", "- finds: one per object"]
    assert describe(schema.record_nodes, ("finds", 2)) == "finds: one per object"
    assert describe(schema.record_nodes, ("dating", "from")) == "dating.from"
    assert describe(schema.record_nodes, ("references", 0, "page")) == "references.page"


def test_conform_keeps_schema_order_drops_strangers_and_nulls_the_missing_and_empty():
    schema = Schema.model_validate(TREE)
    raw = {"site": "Hjortlund", "entry_no": "31a", "bogus": 1, "finds": ["", "spear"], "year": "",
           "dating": {"to": "1900", "junk": 2}, "references": [{"page": 3, "author": ""}, "not an object"]}
    assert conform(raw, schema.record_nodes) == {
        "entry_no": "31a", "site": "Hjortlund", "sex": None, "year": None, "finds": ["spear"],
        "dating": {"from": None, "to": "1900"}, "references": [{"author": None, "page": 3}]}
    assert conform("not an object", schema.record_nodes) == {
        "entry_no": None, "site": None, "sex": None, "year": None, "finds": None, "dating": None, "references": None}

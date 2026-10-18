"""Heading inheritance needs shown source and a separate applicability verdict; it changes no record ownership."""
import pytest

from tests.test_unified_catalog import Model, candidate, evidence, extract, text

SCHEMA = {"recordDescription": "One numbered catalogue entry.", "schemaNodes": [
    {"id": "r", "name": "region", "type": "string"},
]}


def inherited(record, user, schema):
    return {"region": candidate("Moor", "Kreis Moor")}


@pytest.mark.parametrize("nested", [False, True], ids=["root", "nested-object"])
def test_a_shown_heading_can_ground_a_verified_scalar_without_owning_the_record(nested):
    source = evidence("Kreis Moor\n1. Adorf.")
    schema = SCHEMA if not nested else {**SCHEMA, "schemaNodes": [
        {"id": "a", "name": "area", "type": "object", "children": SCHEMA["schemaNodes"]},
    ]}
    answer = inherited(None, None, None)
    if nested:
        answer = {"area": answer}
    result, chat = extract(source, Model(source, entry=lambda *_: answer), schema=schema)
    expected = {"area": {"region": "Moor"}} if nested else {"region": "Moor"}
    assert result["records"] == [expected]
    (link,) = result["evidence"]
    assert link["path"] == ["records", 0, *(["area"] if nested else []), "region"]
    assert link["raw"] == "Moor" and link["linked_by"] == "verification" and link["item"] is None
    assert link["spans"] == [{"segment": "p1_s0", "start": 6, "end": 10}]
    assert [text(source, row) for row in result["discovery"]["entries"][0]["ranges"]] == ["1. Adorf."]
    assert any(row["disposition"] == "other" and row["end"] == 10 for row in result["discovery"]["ledger"])
    verification = next(call for call in chat.calls if call["system"].startswith("You check values"))
    assert "Kreis Moor" in verification["user"] and "applies to this record" in verification["system"]


def test_a_superseded_heading_value_is_rejected_by_the_verifier():
    source = evidence("Kreis Moor\n1. Adorf.\nKreis Ried\n2. Bdorf.")
    model = Model(source, entry=inherited,
                  verdict=lambda path, value, record: "unsupported" if record.startswith("2.") else "supported")
    result, chat = extract(source, model, schema=SCHEMA)
    assert result["records"] == [{"region": "Moor"}, {"region": None}]
    assert result["rejected"][0]["reason"] == "verification_rejected"
    verification = [call for call in chat.calls if call["system"].startswith("You check values")][-1]
    assert "Kreis Moor\nKreis Ried" in verification["user"]
    for prefix in ("You extract structured data", "You check values"):
        system = next(call["system"] for call in chat.calls if call["system"].startswith(prefix))
        assert "all shown headings" in system and "source order (oldest first, latest last)" in system
        assert "supersedes a conflicting earlier value for the same field" in system
        assert "earlier higher-level headings still apply unless superseded" in system


def test_uncertain_heading_applicability_stays_a_proposal():
    source = evidence("Kreis Moor\n1. Adorf.")
    result, _ = extract(source, Model(source, entry=inherited, verdict=lambda *_: "unclear"), schema=SCHEMA)
    assert result["records"] == [{"region": None}] and result["evidence"] == []
    assert result["proposed"][0]["reason"] == "verification_unclear"
    assert result["proposed"][0]["raw"] == "Moor"


def test_heading_context_does_not_admit_a_neighbouring_records_value():
    source = evidence("Kreis Moor\n1. Adorf. Region: Stein.\n2. Bdorf.")
    result, _ = extract(source, Model(source, entry=lambda *_: {
        "region": candidate("Stein", "Region: Stein")}), schema=SCHEMA)
    assert result["records"] == [{"region": "Stein"}, {"region": None}]
    assert result["rejected"][0]["reason"] == "quote_not_in_source"


@pytest.mark.parametrize("dropped", [False, True], ids=["disabled", "budget-omitted"])
def test_a_heading_not_shown_to_the_entry_is_ineligible(dropped):
    heading = "Kreis Moor" + (" Beschreibung" * 500 if dropped else "")
    source = evidence(f"{heading}\n1. Adorf.")
    settings = {"input_tokens": 600, "output_tokens": 64} if dropped else {"headings": False}
    result, chat = extract(source, Model(source, entry=inherited), schema=SCHEMA, **settings)
    assert result["records"] == [{"region": None}]
    assert result["rejected"][0]["reason"] == "quote_not_in_source"
    assert not any("Kreis Moor" in call["user"] for call in chat.calls
                   if call["system"].startswith("You extract structured data"))
    if dropped:
        assert any(row["stage"] == "entry" and row["kind"] == "heading" for row in result["context_omitted"])


def test_inherited_values_require_verification_and_keep_their_source_when_it_is_off():
    source = evidence("Kreis Moor\n1. Adorf.")
    result, _ = extract(source, Model(source, entry=inherited), schema=SCHEMA, verification=False)
    assert result["records"] == [{"region": None}] and result["evidence"] == []
    (proposed,) = result["proposed"]
    assert proposed["reason"] == "verification_disabled" and proposed["raw"] == "Moor"
    assert proposed["path"] == ["records", 0, "region"]
    assert proposed["spans"] == [{"segment": "p1_s0", "start": 6, "end": 10}]
    assert not any(call["stage"] == "verification" for call in result["calls"])


@pytest.mark.parametrize("anchored", [False, True], ids=["heading-occurrence", "record-occurrence"])
def test_context_cannot_supply_list_identity_or_list_field_values(anchored):
    source = evidence("Kreis Moor\n1. Adorf. Find: Bowl.")
    schema = {**SCHEMA, "schemaNodes": [{"id": "f", "name": "finds", "type": "array", "children": [
        {"id": "n", "name": "name", "type": "string"},
        {"id": "r", "name": "region", "type": "string"},
    ]}]}
    answer = {"finds": [{"_item_text": "Find: Bowl." if anchored else "Kreis Moor",
                         "name": candidate("Bowl", "Bowl"), "region": candidate("Moor", "Kreis Moor")}]}
    result, _ = extract(source, Model(source, entry=lambda *_: answer), schema=schema)
    assert result["records"] == [{"finds": [{"name": "Bowl", "region": None}]}]
    (link,) = result["evidence"]
    assert link["path"] == ["records", 0, "finds", 0, "name"]
    assert bool(link["item"]) is anchored
    assert result["rejected"][0]["reason"] == "quote_not_in_source"


def test_an_inherited_value_never_creates_a_scalar_list_item():
    source = evidence("Kreis Moor\n1. Adorf.")
    schema = {**SCHEMA, "schemaNodes": [{"id": "r", "name": "regions", "type": "array", "itemType": "string"}]}
    result, _ = extract(source, Model(source, entry=lambda *_: {"regions": [candidate("Moor", "Kreis Moor")]}),
                        schema=schema)
    assert result["records"] == [{"regions": None}] and result["evidence"] == []
    assert result["rejected"][0]["reason"] == "quote_not_in_source"


@pytest.mark.parametrize("node, value", [
    ({"id": "g", "name": "gilded", "type": "boolean"}, True),
    ({"id": "c", "name": "cover", "type": "string", "allowedValues": ["bog", "field"]}, "bog"),
    ({"id": "d", "name": "era", "type": "string", "evidencePolicy": "derived"}, "iron age"),
], ids=["boolean", "allowed-label", "derived"])
def test_context_supports_no_value_it_does_not_print(node, value):
    """Inside the record an unprinted value may rest on a supporting passage; record-free text is not the
    record's to support it, so a heading grounds a value only where it prints it."""
    source = evidence("Kreis Moor\n1. Adorf.")
    schema = {**SCHEMA, "schemaNodes": [node]}
    result, _ = extract(source, Model(source, entry=lambda *_: {
        node["name"]: candidate(value, "Kreis Moor")}), schema=schema)
    assert result["records"] == [{node["name"]: None}] and result["evidence"] == []
    assert result["proposed"] == []
    assert [row["reason"] for row in result["rejected"]] == ["quote_not_in_source"]


def test_a_null_value_in_a_wrapper_declines_the_field_instead_of_mistyping_it():
    source = evidence("Kreis Moor\n1. Adorf.")
    result, _ = extract(source, Model(source, entry=lambda *_: {
        "region": candidate(None, "Kreis Moor")}), schema=SCHEMA)
    assert result["records"] == [{"region": None}] and result["evidence"] == []
    assert [(row["path"], row["reason"], row["value"]) for row in result["rejected"]] == [
        (["records", 0, "region"], "no_value", None)]


def test_arbitration_can_read_inherited_evidence_outside_the_record():
    source = evidence("Kreis Moor\n1. Adorf.\n" + "\n".join(f"Detail {n}." for n in range(250)) + "\nRegion: Stein.")

    def values(record, user, schema):
        if "Region: Stein" in record:
            return {"region": candidate("Stein", "Region: Stein")}
        return inherited(record, user, schema)

    result, chat = extract(source, Model(source, entry=values), schema=SCHEMA, input_tokens=512, output_tokens=64)
    assert len([call for call in result["calls"] if call["stage"] == "entry"]) > 1
    arbitration = next(call for call in chat.calls if call["system"].startswith("Several verified candidate"))
    assert "Kreis Moor" in arbitration["user"] and "Stein" in arbitration["user"]
    assert result["records"] == [{"region": "Moor"}]

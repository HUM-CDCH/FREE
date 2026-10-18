"""Heading inheritance needs shown source and a separate applicability verdict; it changes no record ownership."""
import pytest

from kei_exp.kie.extract import unified
from kei_exp.kie.extract.discovery import Window
from tests.test_extract_grounded import WordCounter
from tests.test_unified_catalog import Model, candidate, evidence, extract, section, text

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
    assert verification["user"].index("Kreis Moor") < verification["user"].index("Kreis Ried")
    assert "#### CONTEXT 1/2 (earlier shown; source p1_s0)\nKreis Moor" in verification["user"]
    assert "#### CONTEXT 2/2 (latest shown; source p1_s0)\nKreis Ried" in verification["user"]
    for prefix in ("You extract structured data", "You check values"):
        system = next(call["system"] for call in chat.calls if call["system"].startswith(prefix))
        assert "all shown headings" in system and "source order (oldest first, latest last)" in system
        assert "supersedes a conflicting earlier value for the same field" in system
        assert "earlier higher-level headings still apply unless superseded" in system


def test_entry_and_verifier_see_the_same_ordered_context_excerpts_with_source_identity():
    source = evidence("Kreis Moor\n1. Adorf.", "Kreis Ried\n2. Bdorf.")
    counter = WordCounter()
    result, chat = extract(source, Model(source, entry=lambda record, *_: {
        "region": candidate("Ried", "Kreis Ried") if record.startswith("2.") else candidate("Moor", "Kreis Moor")}),
        schema=SCHEMA, counter=counter, input_tokens=600, output_tokens=64)
    expected = ("### CONTEXT (not part of the record)\nExcerpt labels are metadata, not source text.\n"
                "#### CONTEXT 1/2 (earlier shown; source p1_s0)\nKreis Moor\n"
                "#### CONTEXT 2/2 (latest shown; source p2_s0)\nKreis Ried\n\n")
    calls = [call for call in chat.calls if section(call["user"], "RECORD").startswith("2.")]
    assert len(calls) == 2
    assert all(call["user"].split("### RECORD\n")[0] == expected for call in calls)
    assert result["records"] == [{"region": "Moor"}, {"region": "Ried"}]
    assert result["evidence"][1]["spans"] == [{"segment": "p2_s0", "start": 6, "end": 10}]
    for call in chat.calls:
        count = len(call["system"].split()) + len(call["user"].split()) + counter.template_tokens
        assert count <= 600 and count in counter.counted
    assert all(call["counted_input_tokens"] == call["input_tokens"] <= 600 for call in result["calls"])


def test_context_excerpt_labels_are_not_quotable_source():
    source = evidence("Kreis Moor\n1. Adorf.")
    result, _ = extract(source, Model(source, entry=lambda *_: {
        "region": candidate("Moor", "#### CONTEXT 1/1 (latest shown; source p1_s0)\nKreis Moor")}), schema=SCHEMA)
    assert result["records"] == [{"region": None}] and result["evidence"] == [] and result["proposed"] == []
    assert [row["reason"] for row in result["rejected"]] == ["quote_not_in_source"]


def test_a_standing_heading_survives_more_than_three_record_free_units():
    source = evidence("Kreis Moor\nVorwort A.\nVorwort B.\nVorwort C.\n1. Adorf.")
    result, chat = extract(source, Model(source, entry=inherited), schema=SCHEMA)
    context = result["discovery"]["entries"][0]["context"]
    assert [text(source, row) for row in context] == ["Kreis Moor", "Vorwort A.", "Vorwort B.", "Vorwort C."]
    assert result["records"] == [{"region": "Moor"}] and result["context_omitted"] == []
    assert result["evidence"][0]["spans"] == [{"segment": "p1_s0", "start": 6, "end": 10}]
    for call in chat.calls:
        if call["system"].startswith(("You extract structured data", "You check values")):
            assert "#### CONTEXT 1/4 (earlier shown; source p1_s0)\nKreis Moor" in call["user"]
            assert "#### CONTEXT 4/4 (latest shown; source p1_s0)\nVorwort C." in call["user"]


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
        assert any(row["stage"] == "entry" and row["kind"] == "heading"
                   and text(source, row).startswith("Kreis Moor") for row in result["context_omitted"])
    else:
        assert not any("#### CONTEXT" in call["user"] for call in chat.calls
                       if call["system"].startswith(("You extract structured data", "You check values")))


def test_oversized_history_does_not_hide_an_older_fitting_heading():
    source = evidence("Kreis Moor\nIndex" + " Beschreibung" * 500 + "\nVorwort kurz.\n1. Adorf.")
    result, chat = extract(source, Model(source, entry=inherited), schema=SCHEMA,
                           input_tokens=600, output_tokens=64)
    assert result["records"] == [{"region": "Moor"}]
    assert result["evidence"][0]["spans"] == [{"segment": "p1_s0", "start": 6, "end": 10}]
    entries = [call for call in chat.calls if call["system"].startswith("You extract structured data")]
    assert len(entries) == 1 and "Kreis Moor" in entries[0]["user"] and "Vorwort kurz." in entries[0]["user"]
    assert any(row["stage"] == "entry" and row["kind"] == "heading" and text(source, row).startswith("Index")
               for row in result["context_omitted"])
    verification = next(call for call in chat.calls if call["system"].startswith("You check values"))
    assert entries[0]["user"].split("### RECORD")[0] == verification["user"].split("### RECORD")[0]
    assert all(call["counted_input_tokens"] == call["input_tokens"] <= 600 for call in result["calls"])


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
], ids=["boolean", "allowed-label"])
def test_quoted_context_supports_no_value_it_does_not_print(node, value):
    source = evidence("Kreis Moor\n1. Adorf.")
    schema = {**SCHEMA, "schemaNodes": [node]}
    result, _ = extract(source, Model(source, entry=lambda *_: {
        node["name"]: candidate(value, "Kreis Moor")}), schema=schema)
    assert result["records"] == [{node["name"]: None}] and result["evidence"] == []
    assert result["proposed"] == []
    assert [row["reason"] for row in result["rejected"]] == ["quote_not_in_source"]


@pytest.mark.parametrize("nested", [False, True], ids=["explicit-policy", "inherited-object-policy"])
@pytest.mark.parametrize("quote, support", [("1750-1799", "supporting"), ("18th century", "literal")])
def test_a_derived_heading_value_keeps_its_source_as_a_proposal(quote, support, nested):
    heading = f"Kreis Moor, {quote}"
    source = evidence(f"{heading}\n1. Adorf.")
    leaf = {"id": "e", "name": "era", "type": "string"}
    node = {"id": "p", "name": "period", "type": "object", "children": [leaf]} if nested else leaf
    schema = {**SCHEMA, "schemaNodes": [{**node, "evidencePolicy": "derived"}]}
    answer = {"era": candidate("18th century", quote)}
    result, _ = extract(source, Model(source, entry=lambda *_: {"period": answer} if nested else answer), schema=schema)
    assert result["records"] == [{node["name"]: None}] and result["evidence"] == []
    assert result["rejected"] == []
    (proposed,) = result["proposed"]
    assert proposed["path"] == ["records", 0, *(["period"] if nested else []), "era"]
    assert (proposed["value"], proposed["quote"], proposed["reason"], proposed["support"]) == \
        ("18th century", quote, "evidence_policy_derived", support)
    assert proposed["raw"] == quote
    assert proposed["spans"] == [{"segment": "p1_s0", "start": 12, "end": len(heading)}]
    assert [text(source, row) for row in result["discovery"]["entries"][0]["ranges"]] == ["1. Adorf."]
    assert not any(call["stage"] == "verification" for call in result["calls"])


@pytest.mark.parametrize("value", [True, False])
def test_a_quoted_boolean_is_not_accepted_from_a_heading_even_when_printed(value):
    printed = str(value).lower()
    source = evidence(f"Kreis {printed}\n1. Adorf.")
    schema = {**SCHEMA, "schemaNodes": [
        {"id": "g", "name": "gilded", "type": "boolean", "evidencePolicy": "quoted"},
    ]}
    result, _ = extract(source, Model(source, entry=lambda *_: {"gilded": candidate(value, printed)}), schema=schema)
    assert result["records"] == [{"gilded": None}] and result["evidence"] == [] and result["proposed"] == []
    assert [row["reason"] for row in result["rejected"]] == ["quote_not_in_source"]
    assert not any(call["stage"] == "verification" for call in result["calls"])


def test_a_derived_boolean_can_remain_a_heading_supported_proposal():
    source = evidence("Kreis Gilded finds\n1. Adorf.")
    schema = {**SCHEMA, "schemaNodes": [
        {"id": "g", "name": "gilded", "type": "boolean", "evidencePolicy": "derived"},
    ]}
    result, _ = extract(source, Model(source, entry=lambda *_: {
        "gilded": candidate(True, "Gilded finds")}), schema=schema)
    assert result["records"] == [{"gilded": None}] and result["evidence"] == [] and result["rejected"] == []
    (proposed,) = result["proposed"]
    assert proposed["value"] is True and proposed["reason"] == "evidence_policy_derived"
    assert proposed["support"] == "supporting" and proposed["raw"] == "Gilded finds"
    assert proposed["spans"] == [{"segment": "p1_s0", "start": 6, "end": 18}]
    assert not any(call["stage"] == "verification" for call in result["calls"])


def test_a_pipelined_derived_heading_candidate_is_never_published_as_a_final_value():
    from kei_exp.kie.extract import run
    from tests.test_durable_extraction import MemoryLease, drive
    from tests.test_extract_grounded import CountingChat
    from tests.test_unified_catalog import request

    source = evidence(*(f"Kreis Moor, 1750-1799\n{number}. Site{number}." for number in range(1, 7)))
    schema = {**SCHEMA, "schemaNodes": [
        {"id": "e", "name": "era", "type": "string", "evidencePolicy": "derived"},
    ]}
    requested = request(schema, defaults=3)
    lease = MemoryLease(schema)
    chat = CountingChat(Model(source, entry=lambda *_: {"era": candidate("18th century", "1750-1799")}))
    result, _, _ = drive(lease, chat, lambda router, counter: run.dispatch(
        None, source, requested, router, counter=counter, chunks=1), 1)
    provisional = [value for publication in lease.publications.values()
                   if publication["coverage"].get("processingComplete") is False
                   for value in publication["values"] if value["modelValue"] is not None]
    assert provisional and all(value["grounding"] == "provisional" and value["evidence"] == [] for value in provisional)
    final = [value for publication in lease.publications.values()
             if publication["coverage"].get("processingComplete") is True for value in publication["values"]]
    assert final and all(value["modelValue"] is None and value["processing"] == "absent" and value["evidence"] == []
                         for value in final)
    assert result["records"] == [{"era": None}] * 6 and result["evidence"] == []
    assert len(result["proposed"]) == 6 and all(row["reason"] == "evidence_policy_derived" for row in result["proposed"])
    assert not any(call["stage"] == "verification" for call in result["calls"])


def test_a_printed_allowed_label_in_a_heading_can_be_verified():
    source = evidence("Kreis bog\n1. Adorf.")
    schema = {**SCHEMA, "schemaNodes": [
        {"id": "c", "name": "cover", "type": "string", "allowedValues": ["bog", "field"]},
    ]}
    result, _ = extract(source, Model(source, entry=lambda *_: {"cover": candidate("bog", "Kreis bog")}), schema=schema)
    assert result["records"] == [{"cover": "bog"}] and result["proposed"] == [] and result["rejected"] == []
    (link,) = result["evidence"]
    assert link["support"] == "literal" and link["raw"] == "bog" and link["linked_by"] == "verification"
    assert link["spans"] == [{"segment": "p1_s0", "start": 6, "end": 9}]


def test_quoted_booleans_and_allowed_labels_keep_the_records_own_supporting_passages():
    source = evidence("Kreis Moor\n1. Adorf. Golden coating. Recovered from peat.")
    schema = {**SCHEMA, "schemaNodes": [
        {"id": "g", "name": "gilded", "type": "boolean", "evidencePolicy": "quoted"},
        {"id": "c", "name": "cover", "type": "string", "allowedValues": ["bog", "field"], "evidencePolicy": "quoted"},
    ]}
    quotes = {"gilded": "Golden coating.", "cover": "Recovered from peat."}
    result, _ = extract(source, Model(source, entry=lambda *_: {
        "gilded": candidate(True, quotes["gilded"]), "cover": candidate("bog", quotes["cover"])}), schema=schema)
    assert result["records"] == [{"gilded": True, "cover": "bog"}]
    assert result["proposed"] == [] and result["rejected"] == []
    assert len(result["evidence"]) == 2
    for link in result["evidence"]:
        quote = quotes[link["path"][-1]]
        start = source.passages[0].text.index(quote)
        assert link["support"] == "supporting" and link["raw"] == quote and link["linked_by"] == "verification"
        assert link["spans"] == [{"segment": "p1_s0", "start": start, "end": start + len(quote)}]


def test_a_null_value_in_a_wrapper_declines_the_field_instead_of_mistyping_it():
    source = evidence("Kreis Moor\n1. Adorf.")
    result, _ = extract(source, Model(source, entry=lambda *_: {
        "region": candidate(None, "Kreis Moor")}), schema=SCHEMA)
    assert result["records"] == [{"region": None}] and result["evidence"] == []
    assert [(row["path"], row["reason"], row["value"]) for row in result["rejected"]] == [
        (["records", 0, "region"], "no_value", None)]


def test_arbitration_can_read_inherited_evidence_outside_the_record():
    source = evidence("Kreis Moor\n1. Adorf.\nDetail 0.\nDetail 1.\nDetail 2.\nRegion: Stein.")

    def values(record, user, schema):
        if "Detail 0." in record and "Region: Stein" in record:
            return {}  # a failed whole-entry reply is split; each half still has room for its heading
        if "Region: Stein" in record:
            return {"region": candidate("Stein", "Region: Stein")}
        return inherited(record, user, schema)

    result, chat = extract(source, Model(source, entry=values), schema=SCHEMA, input_tokens=512, output_tokens=64)
    assert len([call for call in result["calls"] if call["stage"] == "entry"]) > 1
    arbitration = next(call for call in chat.calls if call["system"].startswith("Several verified candidate"))
    assert "Kreis Moor" in arbitration["user"] and "Stein" in arbitration["user"]
    assert result["records"] == [{"region": "Moor"}]


def test_arbitration_keeps_shown_headings_in_source_order_across_partial_selections(monkeypatch):
    source = evidence("Kreis Alpha\nKreis Beta\nKreis Gamma\nKreis Omitted\n1. Adorf.\nDetail.")

    def partial_windows(units, texts, fits, *, overlap, heading):
        assert len(units) == 2 and len(heading) == 4
        windows = [
            Window((units[0],), heading=heading[1:3], omitted=(("heading", heading[0]), ("heading", heading[3]))),
            Window((units[1],), heading=heading[:3], omitted=(("heading", heading[3]),)),
        ]
        assert all(fits(window) for window in windows)
        return windows

    monkeypatch.setattr(unified, "plan", partial_windows)
    result, chat = extract(source, Model(source, entry=lambda record, *_: {
        "region": candidate("Beta", "Kreis Beta") if record.startswith("1.") else candidate("Alpha", "Kreis Alpha")}),
        schema=SCHEMA)
    arbitration = next(call for call in chat.calls if call["system"].startswith("Several verified candidate"))
    snippets = [line for line in arbitration["user"].splitlines() if line.startswith(("C1:", "C2:"))]
    assert len(snippets) == 2
    assert all("Kreis Alpha Kreis Beta Kreis Gamma" in snippet for snippet in snippets)
    assert "Kreis Omitted" not in arbitration["user"]
    assert result["records"] == [{"region": "Beta"}]

"""Attribution context must be source-backed and must not make a wrong value acceptable."""
from dataclasses import replace

import pytest

from kei_exp.kie.extract import grounding, unified
from kei_exp.kie.extract.assembly import link_json
from kei_exp.kie.extract.discovery import Unit, Window
from kei_exp.kie.extract.models import as_router
from kei_exp.kie.extract.schema import Schema
from tests.test_extract_grounded import CountingChat, WordCounter
from tests.test_extract_stages import passages
from tests.test_unified_catalog import candidate, evidence, extract, Model, PARTS, table_passage


AUTHORS = Schema.model_validate({"recordDescription": "authors", "schemaNodes": [
    {"id": "a", "name": "authors", "type": "array", "children": [
        {"id": "n", "name": "name", "type": "string"},
        {"id": "i", "name": "institution", "type": "string"}]}]})


def test_record_evidence_shares_the_source_and_reserves_the_complete_reply():
    import json
    fields = {"authors": [{"name": f"value{n}"} for n in range(96)]}
    source = passages([" ".join(author["name"] for author in fields["authors"])] + ["Other source"] * 1000)
    seen = []
    class Chat(CountingChat):
        def complete(self, **kwargs):
            seen.append(kwargs)
            return super().complete(**kwargs)
    def answer(system, user, reply_schema):
        return {key: [] if "items" in spec else "E1" for key, spec in reply_schema["properties"].items()}
    links, calls, issues = grounding.verify(source, fields, AUTHORS, Chat(answer), record=0, projected=True,
                                            counter=WordCounter())
    assert len(calls) == len(seen) == 1 and len(links) == 96 and not issues
    properties = seen[0]["schema"]["properties"]
    assert list(properties)[:4] == ["G1", "C1", "G2", "C2"]  # an item's context is asked once, before its claims
    longest = {key: ["E1001"] * 2 if "items" in spec else "E1001" for key, spec in properties.items()}
    assert seen[0]["max_tokens"] >= len(json.dumps(longest).encode("utf-8")) > 2048


@pytest.mark.parametrize("page", [2, 1], ids=["page-end", "column-end"])
def test_a_word_split_by_a_hyphen_is_cited_whole_whichever_half_the_model_chooses(page):
    # I3: the first half names the sample, the second prints the value, on the next page or in the next column of
    # the same page, with page furniture between them.
    first = passages(["For Sample A, a sig-"])
    rest = [replace(each, id=f"q{n}") for n, each in enumerate(
        passages(["Running Header", "nificant yield of 20 fragments was recorded."], page=page))]
    rest[0] = replace(rest[0], label="PageHeader")
    schema = Schema.model_validate({"recordDescription": "One sample", "schemaNodes": [
        {"id": "y", "name": "yield", "type": "number"}]})
    whole = lambda passage: {"segment": passage.id, "start": 0, "end": len(passage.text)}
    seen = {}
    for chosen in ("E1", "E3"):
        links, _, issues = grounding.verify([*first, *rest], {"yield": 20}, schema,
                                            CountingChat(lambda *_, chosen=chosen: {"C1": chosen}), record=0,
                                            projected=True, located=True)
        assert not issues
        seen[chosen] = [(link.segment, link.verbatim, link.location and link.location["raw"], link.context)
                        for link in links]
    # Either choice stays primary, verbatim and located only where it prints the value; the other half is context.
    assert seen == {"E1": [(first[0].id, False, None, (whole(rest[1]),))],
                    "E3": [(rest[1].id, True, "20", (whole(first[0]),))]}


@pytest.mark.parametrize("label", ["Text", "ListItem"])
def test_a_page_end_never_moves_the_models_evidence_to_another_subject_on_the_next_page(label):
    # I1: the next page's first text of the same kind prints the value, but for Sample B; the model chose Sample A.
    schema = Schema.model_validate({"recordDescription": "One sample", "schemaNodes": [
        {"id": "f", "name": "fragments", "type": "number"}]})
    whole = lambda passage: {"segment": passage.id, "start": 0, "end": len(passage.text)}
    def grounded(end, start):
        first = [replace(passages([end])[0], label=label)]
        rest = passages(["Running Header", start], page=2)
        rest = [replace(rest[0], label="PageHeader"), replace(rest[1], label=label)]
        links, _, issues = grounding.verify([*first, *rest], {"fragments": 20}, schema,
                                            CountingChat(lambda *_: {"C1": "E1"}), record=0, projected=True,
                                            located=True)
        assert not issues
        return [(link.segment, link.verbatim, link.location, link.context) for link in links], first[0], rest[1]
    # A page end without a hyphen joins nothing: Sample B's sentence is neither primary nor context.
    links, first, _ = grounded("Sample A contained twenty fragments", "Sample B contained 20 fragments.")
    assert links == [(first.id, False, None, ())]
    # A hyphen joins the word's other half as context; the half printing the value still does not become primary.
    links, first, rest = grounded("Sample A contained twenty frag-", "ments; Sample B contained 20.")
    assert links == [(first.id, False, None, (whole(rest),))]


def test_a_word_break_never_crosses_content_or_a_heading_to_move_the_models_evidence():
    # Sample B's lower-case sentence prints the value, but Sample A's own text sits between: E1 stays primary.
    other = [replace(each, page=2) for each in passages(["DNA antibodies.", "Sample B", "there are 2 antibodies in Sample B."])]
    record = [*passages(["Sample A contains two anti-"]), *other]
    schema = Schema.model_validate({"recordDescription": "One sample", "schemaNodes": [
        {"id": "a", "name": "antibodies", "type": "number"}]})
    answer = lambda *_: {"C1": "E1"}
    links, _, issues = grounding.verify(record, {"antibodies": 2}, schema, CountingChat(answer), record=0, projected=True)
    assert not issues and [(link.segment, link.verbatim, link.location, link.context) for link in links] == [
        (record[0].id, False, None, ())]
    # A heading between the halves is not the word's end either, even in lower case.
    source = passages(["The RF group was signifi-", "foods", "cantly higher than the CF group (34.51)."])
    source[1] = replace(source[1], label="SectionHeader")
    cf = Schema.model_validate({"recordDescription": "One study", "schemaNodes": [
        {"id": "c", "name": "cf", "type": "number"}]})
    links, _, issues = grounding.verify(source, {"cf": 34.51}, cf, CountingChat(answer), record=0, projected=True)
    assert not issues and [(link.segment, link.context) for link in links] == [(source[0].id, ())]
    # Nor is the second half, chosen itself, joined back across a heading or other content to the hyphen before them.
    for between in ("SectionHeader", "Text"):
        source[1] = replace(source[1], label=between)
        links, _, issues = grounding.verify(source, {"cf": 34.51}, cf, CountingChat(lambda *_: {"C1": "E3"}),
                                            record=0, projected=True)
        assert not issues and [(link.segment, link.context) for link in links] == [(source[2].id, ())]


def test_a_cells_table_named_again_as_its_items_context_is_cited_once():
    table = table_passage([["Sample", "Yield"], ["A", "20"]])
    schema = Schema.model_validate({"recordDescription": "One study", "schemaNodes": [
        {"id": "t", "name": "title", "type": "string"},
        {"id": "s", "name": "samples", "type": "array", "children": [
            {"id": "n", "name": "name", "type": "string"}, {"id": "y", "name": "yield", "type": "number"}]}]})
    # E1 is the whole table (offered for the title, which no cell prints), E4 and E5 the item's cells.
    reply = {"C1": "E1", "G1": ["E1"], "C2": "E4", "C3": "E5"}
    links, _, issues = grounding.verify([table], {"title": "Yields", "samples": [{"name": "A", "yield": 20}]},
                                        schema, CountingChat(lambda *_: reply), record=0, projected=True)
    whole = {"segment": table.id, "start": 0, "end": len(table.text)}
    assert not issues and [(link.cell, link.context) for link in links] == [
        (None, ()), ("r1_c0", (whole,)), ("r1_c1", (whole,))]


def test_article_retains_an_items_identity_evidence_on_its_claims_and_no_context_for_the_record_itself():
    source = passages(["Author A¹", "¹ Institute B, Country C"])
    fields = {"authors": [{"name": "Author A", "institution": "Institute B"}]}
    def answer(system, user, reply_schema):
        assert "attribute its claims to THIS list item" in system and 'G1 Within authors[0]: {"name": "Author A"' in user
        return {"G1": ["E1"], "C1": "E1", "C2": "E2"}
    links, _, issues = grounding.verify(source, fields, AUTHORS, CountingChat(answer), record=0, projected=True,
                                        located=True)
    # The item's context is kept on each claim it is not already the evidence of.
    assert not issues and [link_json(link).get("context") for link in links] == [
        None, [{"segment": source[0].id, "start": 0, "end": len(source[0].text)}]]
    assert links[1].location["raw"] == "Institute B"
    def record_only(system, user, reply_schema):
        assert list(reply_schema["properties"]) == ["C1"] and "G1" not in user
        return {"C1": "E1"}
    links, _, issues = grounding.verify(source, {"name": "Author A"}, Schema.model_validate({
        "recordDescription": "One author", "schemaNodes": [{"id": "n", "name": "name", "type": "string"}]}),
        CountingChat(record_only), record=0, projected=True)
    assert not issues and links[0].context == ()


def test_unanswered_record_claim_remains_incomplete():
    schema = Schema.model_validate({"recordDescription": "One record", "schemaNodes": [
        {"id": "n", "name": "name", "type": "string"}]})
    links, _, issues = grounding.verify(passages(["Name A"]), {"name": "Name A"}, schema,
                                       CountingChat(lambda *_: {}), record=0, projected=True)
    assert not links
    assert [(issue.code, issue.path) for issue in issues] == [("missing_claim", ("records", 0, "name"))]


@pytest.mark.parametrize("reply,reason", [
    ({"C1": "E2"}, "missing_claim"),
    ({"G1": "E1", "C1": "E2"}, "missing_claim"),
    ({"G1": ["E1"] * 3, "C1": "E2"}, "missing_claim"),
    ({"G1": ["E99"], "C1": "E2"}, "missing_claim"),
    ({"G1": ["E1"], "C1": "NONE"}, None),
])
def test_article_context_reply_distinguishes_incomplete_checks_from_rejections(reply, reason):
    from kei_exp.kie.extract.assembly import grounding_accounting
    path = ("records", 0, "authors", 0, "institution")
    links, _, issues = grounding.verify(
        passages(["Author A¹", "¹ Institute B"]), {"authors": [{"name": "Author A", "institution": "Institute B"}]},
        AUTHORS, CountingChat(lambda *_: reply), record=0, projected=True,
        skip_paths=frozenset({("records", 0, "authors", 0, "name")}))
    assert not links
    result = grounding_accounting({path}, set(), issues)
    assert (result["not_completed"], result["unsupported"]) == ((1, 0) if reason else (0, 1))
    assert result["reasons"] == ({reason: 1} if reason else {})


@pytest.mark.parametrize("reading,accepted", [(candidate("North", "Jail North"), True),
                                              (candidate("South", "Jail South"), False), (None, False)])
def test_heading_recovery_checks_intervening_source_even_when_discovery_misassigns_it(reading, accepted):
    text = "Jail North\n1. First.\nJail South\n2. Second, owner lives in North."
    source = evidence(text)
    schema = Schema.model_validate({"recordDescription": "One prisoner", "schemaNodes": [
        {"id": "j", "name": "jail", "type": "string"}]})
    seen = []
    def answer(system, user, reply_schema):
        seen.append(user)
        assert user.index("Jail North") < user.index("Jail South") < user.index("### RECORD")
        assert 'replaces an earlier value only when it changes the same field' in system
        assert ' = "North"' not in user  # the independent reading cannot copy the candidate
        return {"C1": reading}
    chat = as_router(CountingChat(answer))
    options = unified.UnifiedOptions(defaults=11)
    counters = dict.fromkeys(("fields", "reasoning"), WordCounter())
    effective = unified._execution(source, schema, options, chat, counters)["effective"]
    runner = unified._Run(schema, unified._Budget(chat, counters, effective["stages"]), {"p1_s0": text}, effective)
    start = text.index("2.")
    entry = {"ranges": [{"segment": "p1_s0", "start": start, "end": len(text)}],
             "context": [{"segment": "p1_s0", "start": 0, "end": 10}]}
    units = [Unit("p1_s0", start, len(text))]
    work = unified._Work(found=[unified._Found(("jail",), "North", "Jail North", 0,
                                               kind="rejected", reason="quote_not_in_source")])
    replies = runner._record_evidence(entry, [(Window(tuple(units)), {})], work, unified._view(units, runner.texts))
    runner._verify(0, replies, work, owned=units, context=tuple(Unit(each["segment"], each["start"], each["end"])
                                                for each in entry["context"]))
    assert seen and (work.found[0].kind == "accepted") == accepted
    assert work.found[0].value == "North"
    if accepted:
        link = unified._link(work.found[0], 0, {p.id: p for p in source.passages})
        assert link["context"] == entry["ranges"] and link["linked_by"] == "verification"


def test_new_catalog_defaults_run_attachment_through_the_real_entry_path():
    source = evidence("Kreis Moor\n1. Adorf.")
    schema = {"recordDescription": "One numbered entry", "schemaNodes": [{"id": "r", "name": "region", "type": "string"}]}
    model = Model(source, entry=lambda *_: {"region": candidate("Moor", "Kreis Moor")})
    def answer(system, user, reply_schema):
        if system.startswith("Read the source independently"):
            return {"C1": candidate("Moor", "Kreis Moor")}
        return model(system, user, reply_schema)
    result, _ = extract(source, answer, schema=schema, defaults=11)
    assert result["records"] == [{"region": "Moor"}]
    assert result["evidence"][0]["context"] == result["discovery"]["entries"][0]["ranges"]
    assert result["evidence"][0]["linked_by"] == "verification"


def record_runner(monkeypatch, source, reads, answer, *, headings=True, field="region"):
    schema = Schema.model_validate({"recordDescription": "One numbered entry", "schemaNodes": [
        {"id": "r", "name": field, "type": "string"}]})
    chat = as_router(CountingChat(answer))
    counters = dict.fromkeys(("fields", "reasoning"), WordCounter())
    effective = unified._execution(source, schema, unified.UnifiedOptions(defaults=11, headings=headings),
                                   chat, counters)["effective"]
    runner = unified._Run(schema, unified._Budget(chat, counters, effective["stages"]),
                         {p.id: p.text for p in source.passages}, effective)
    monkeypatch.setattr(runner, "_read", lambda *args, **kwargs: reads)
    return runner


@pytest.mark.parametrize("context", [False, True], ids=["no-admitted-heading", "intervening-record"])
def test_other_records_cannot_supply_inherited_evidence_even_if_the_verifier_agrees(monkeypatch, context):
    text = "Group North\n1. Owner lives in West.\n2. Second."
    start = text.index("2.")
    entry = {"ranges": [{"segment": "p1_s0", "start": start, "end": len(text)}],
             "context": [{"segment": "p1_s0", "start": 0, "end": 11}] if context else []}
    window = Window((Unit("p1_s0", start, len(text)),))
    wrong = candidate("West", "Owner lives in West")
    seen = []
    def answer(system, user, schema):
        seen.append(user)
        return {"C1": wrong}
    runner = record_runner(monkeypatch, evidence(text), [(window, {"region": wrong})], answer)
    work = runner.entry(0, entry)
    assert seen and not any(found.kind == "accepted" for found in work.found)
    assert all(found.value == "West" for found in work.found)
    assert ("Owner lives in West" in seen[0]) == context  # intervening text is for judging supersession only


@pytest.mark.parametrize("reading,accepted", [(candidate("metres", "Units: metres"), True),
                                              (candidate("feet", "Units: feet"), False)])
def test_following_shared_table_qualification_remains_available(monkeypatch, reading, accepted):
    source = evidence("1. Sample.", "Units: metres")
    entry = {"ranges": [{"segment": "p1_s0", "start": 0, "end": 10}],
             "context": [{"segment": "p2_s0", "start": 0, "end": 13}]}
    window = Window((Unit("p1_s0", 0, 10),), heading=(Unit("p2_s0", 0, 13),))
    def answer(system, user, schema):
        assert "Units: metres" in user
        return {"C1": reading}
    runner = record_runner(monkeypatch, source,
                           [(window, {"unit": candidate("metres", "Units: metres")})], answer, field="unit")
    work = runner.entry(0, entry)
    assert any(found.kind == "accepted" for found in work.found) == accepted
    assert all(found.value == "metres" for found in work.found)


@pytest.mark.parametrize("headings", [False, True])
def test_child_keeps_only_its_parent_context_including_text_after_it(monkeypatch, headings):
    text = "Earlier unrelated West.\nGrave North.\n1. Bead.\nAll finds: gold."
    start, end = text.index("1."), text.index("\nAll")
    entry = {"ranges": [{"segment": "p1_s0", "start": start, "end": end}], "parent": 0,
             "context": [{"segment": "p1_s0", "start": text.index("Grave"), "end": start},
                         {"segment": "p1_s0", "start": end + 1, "end": len(text)}]}
    window = Window((Unit("p1_s0", start, end),),
                    heading=tuple(Unit(each["segment"], each["start"], each["end"]) for each in entry["context"]))
    def answer(system, user, schema):
        assert "Earlier unrelated West" not in user
        assert "All finds: gold" in user and "Grave North" in user
        return {"C1": candidate("gold", "All finds: gold")}
    runner = record_runner(monkeypatch, evidence(text),
                           [(window, {"material": candidate("gold", "All finds: gold")})], answer,
                           headings=headings, field="material")
    work = runner.entry(0, entry)
    assert work.record == {"material": "gold"} and work.found[0].verified


def test_disagreeing_inherited_values_reach_arbitration_with_their_source(monkeypatch):
    text = "Group North\nGroup South\n1. First part.\nContinued."
    start, middle = text.index("1."), text.index("Continued")
    entry = {"ranges": [{"segment": "p1_s0", "start": start, "end": len(text)}],
             "context": [{"segment": "p1_s0", "start": 0, "end": start}]}
    reads = [(Window((Unit("p1_s0", a, b),)), {"region": candidate(value, f"Group {value}")})
             for a, b, value in [(start, middle, "North"), (middle, len(text), "South")]]
    def answer(system, user, schema):
        if "choice" in schema["properties"]:
            assert "Group North" in user and "Group South" in user
            return {"choice": "NONE"}
        value = "North" if "### RECORD\n1." in user else "South"
        return {"C1": candidate(value, f"Group {value}")}
    runner = record_runner(monkeypatch, evidence(text), reads, answer)
    work = runner.entry(0, entry)
    assert work.contest[0]["outcome"] == "unresolved"
    assert not any(found.kind == "accepted" for found in work.found)


@pytest.mark.parametrize("defaults", [10, 11])
@pytest.mark.parametrize("verdict", ["supported", "unsupported"])
def test_local_table_values_keep_single_pass_outside_the_item_identity_cell(defaults, verdict):
    table = replace(table_passage([["A-1", "Skull"], ["A-2", "Tibia"]]), id="p1_s1", index=1)
    source = evidence("1. Remains.")
    source = replace(source, passages=(*source.passages, table))
    parts = [{"number": number, "description": description} for number, description in [("A-1", "Skull"), ("A-2", "Tibia")]]
    model = Model(source, entry=lambda *_: {"parts": [
        {"_item_text": row["number"], **{key: candidate(value, value) for key, value in row.items()}}
        for row in parts]})
    def answer(system, user, schema):
        if system.startswith("Read the source independently"):
            return {key: verdict for key in schema["properties"]}
        return model(system, user, schema)
    result, _ = extract(source, answer, schema=PARTS, defaults=defaults, verification=False)
    assert not any(call["stage"] == "verification" for call in result["calls"])
    assert result["records"] == [{"parts": parts}]
    descriptions = [link for link in result["evidence"] if link["path"][-1] == "description"]
    assert [link["cell"] for link in descriptions] == ["r0_c1", "r1_c1"]
    assert [link["item"] for link in descriptions] == [link["spans"] for link in result["evidence"] if link["path"][-1] == "number"]

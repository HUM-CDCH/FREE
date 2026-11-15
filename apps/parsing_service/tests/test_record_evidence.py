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


def test_evidence_cut_inside_a_word_is_cited_with_the_passage_that_finishes_it():
    source = passages(["The RF group was signifi-", "Running Header", "cantly higher than the CF group (34.51)."])
    source[1] = replace(source[1], label="PageHeader")
    schema = Schema.model_validate({"recordDescription": "One study", "schemaNodes": [
        {"id": "c", "name": "cf", "type": "number"}, {"id": "s", "name": "significant", "type": "string"}]})
    links, _, issues = grounding.verify(source, {"cf": 34.51, "significant": "yes"}, schema,
                                        CountingChat(lambda *_: {"C1": "E1", "C2": "E1"}), record=0, projected=True)
    whole = lambda passage: {"segment": passage.id, "start": 0, "end": len(passage.text)}
    # The half printing the value is primary; a value neither half prints keeps the model's choice.
    assert not issues and [(link.segment, link.context) for link in links] == [
        (source[2].id, (whole(source[0]),)), (source[0].id, (whole(source[2]),))]


def test_evidence_a_page_end_cuts_mid_sentence_is_cited_with_the_next_pages_first_text():
    # No hyphen marks it, and the parser glued the page number to the rest: the page end alone says it continues.
    first = passages(["Higher than snapper (39.57), silver"])
    rest = passages(["Running Header", "10 of 16 pomfret (40.89) and sole.", "A new paragraph."], page=2)
    rest[0] = replace(rest[0], label="PageHeader")
    schema = Schema.model_validate({"recordDescription": "One study", "schemaNodes": [
        {"id": "p", "name": "pomfret", "type": "number"}, {"id": "s", "name": "species", "type": "string"}]})
    fields = {"pomfret": 40.89, "species": "silver pomfret"}
    answer = lambda *_: {"C1": "E1", "C2": "E1"}
    links, _, issues = grounding.verify([*first, *rest], fields, schema, CountingChat(answer), record=0, projected=True)
    whole = lambda passage: {"segment": passage.id, "start": 0, "end": len(passage.text)}
    assert not issues and [(link.segment, link.context) for link in links] == [
        (rest[1].id, (whole(first[0]),)), (first[0].id, (whole(rest[1]),))]
    # On one page nothing says the next text continues it, nor does a finished sentence at a page end.
    for source in ([*first, *passages(["pomfret (40.89) and sole."])[:1]],
                   [*passages(["Higher than snapper (39.57)."]), *rest]):
        source[1:] = [replace(each, id=f"q{n}") for n, each in enumerate(source[1:])]
        links, _, _ = grounding.verify(source, fields, schema, CountingChat(answer), record=0, projected=True)
        assert [(link.segment, link.context) for link in links] == [(source[0].id, ())] * 2


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
    links, _, issues = grounding.verify(source, {"cf": 34.51}, Schema.model_validate({
        "recordDescription": "One study", "schemaNodes": [{"id": "c", "name": "cf", "type": "number"}]}),
        CountingChat(answer), record=0, projected=True)
    assert not issues and [(link.segment, link.context) for link in links] == [(source[0].id, ())]


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


def record_runner(monkeypatch, source, reads, answer, *, headings=True, field="region", entries=()):
    schema = Schema.model_validate({"recordDescription": "One numbered entry", "schemaNodes": [
        {"id": "r", "name": field, "type": "string"}]})
    chat = as_router(CountingChat(answer))
    counters = dict.fromkeys(("fields", "reasoning"), WordCounter())
    effective = unified._execution(source, schema, unified.UnifiedOptions(defaults=11, headings=headings),
                                   chat, counters)["effective"]
    runner = unified._Run(schema, unified._Budget(chat, counters, effective["stages"]),
                         {p.id: p.text for p in source.passages}, effective, entries=entries)
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


SHARED = "Read the source independently for each marked record"
ALONE = "Read the source independently of any shown candidate value, for one record"


def heading_group(monkeypatch, text, candidates, answer):
    """A runner over `text`, whose first line is the heading discovery admitted for every numbered line after it
    (its other lines belong to no record), with each record's entry reply for `region`."""
    lines, at = [], 0
    for line in text.split("\n"):
        lines.append((at, at + len(line), line))
        at += len(line) + 1
    heading = {"segment": "p1_s0", "start": 0, "end": lines[0][1]}
    entries = [{"ranges": [{"segment": "p1_s0", "start": start, "end": end}], "context": [heading]}
               for start, end, line in lines if line[0].isdigit()]
    reads = [[(Window((Unit("p1_s0", entry["ranges"][0]["start"], entry["ranges"][0]["end"]),)), {"region": each})]
             for entry, each in zip(entries, candidates, strict=True)]
    runner = record_runner(monkeypatch, evidence(text), None, answer, entries=entries)
    monkeypatch.setattr(runner, "_read", lambda stage, number, *args, **kwargs: reads[number])
    return runner, entries


def test_records_under_one_heading_share_one_reading_that_sees_a_heading_between_them(monkeypatch):
    north = candidate("North", "Group North")
    seen = []
    def answer(system, user, schema):
        seen.append(user)
        assert system.startswith(SHARED) and list(schema["properties"]) == ["R1", "R2", "R3"]
        assert "North\"" not in user  # the readings cannot copy a candidate
        places = [user.index(each) for each in ("### CONTEXT (not part of the records)\nGroup North",
                                                "### RECORD R1\n1. First.\n### END RECORD R1", "### RECORD R2",
                                                "### CONTEXT (not part of the records)\nGroup South", "### RECORD R3")]
        assert places == sorted(places) and user.endswith("### FIELD\nregion\n\nReturn the JSON object now.")
        return {"R1": north, "R2": north, "R3": candidate("South", "Group South")}
    runner, entries = heading_group(monkeypatch, "Group North\n1. First.\n2. Second.\nGroup South\n3. Third.",
                                    [north] * 3, answer)
    works = [runner.entry(number, entry) for number, entry in enumerate(entries)]
    assert len(seen) == 1
    assert [(work.found[0].kind, work.found[0].reason) for work in works] == [
        ("accepted", None), ("accepted", None), ("rejected", "verification_rejected")]
    assert works[0].found[0].verified and works[0].record == {"region": "North"}
    # The one call is every sharing record's, under one key, and no record's own.
    assert not any(work.calls for work in works) and len({key for work in works for key in work.shared}) == 1
    assert all(len(calls) == 1 and not issues for work in works for calls, issues in work.shared.values())


@pytest.mark.parametrize("reading,kind", [
    (candidate("North", "Group North"), "accepted"),
    (candidate("South", "Group North"), "rejected"),            # an unequal reading
    (candidate("North", "Owner lives in North"), "proposed"),   # only another record prints the quote
    (None, "rejected")])
def test_a_shared_reading_is_accepted_only_equal_and_located_in_the_record_or_its_heading(monkeypatch, reading, kind):
    north = candidate("North", "Group North")
    runner, entries = heading_group(monkeypatch, "Group North\n1. Owner lives in North.\n2. Second.", [north] * 2,
                                    lambda *_: {"R1": north, "R2": reading})
    assert runner.entry(1, entries[1]).found[0].kind == kind
    assert runner.entry(0, entries[0]).found[0].kind == "accepted"


def test_a_local_or_uncited_value_is_not_read_with_the_records_sharing_the_heading(monkeypatch):
    seen = []
    def answer(system, user, schema):
        seen.append(system)
        return {"C1": candidate("West", "Lives in West")}
    runner, entries = heading_group(monkeypatch, "Group North\n1. Lives in West.\n2. Second.",
                                    [candidate("West", "Lives in West")] * 2, answer)
    assert runner.entry(0, entries[0]).found[0].kind == "accepted" and not seen  # local: the single pass
    work = runner.entry(1, entries[1])  # cited nowhere it may be: read alone, and never from another record
    assert [each.startswith(ALONE) for each in seen] == [True] and not work.shared
    assert work.found[0].kind != "accepted"


def test_a_shared_reading_without_a_valid_reply_leaves_each_record_its_own_reading(monkeypatch):
    north = candidate("North", "Group North")
    seen = []
    def answer(system, user, schema):
        seen.append(system)
        return {} if system.startswith(SHARED) else {"C1": north}
    runner, entries = heading_group(monkeypatch, "Group North\n1. First.\n2. Second.", [north] * 2, answer)
    works = [runner.entry(number, entry) for number, entry in enumerate(entries)]
    assert [each.startswith(SHARED) for each in seen] == [True, False, False]  # asked once, then one call each
    assert all(work.found[0].kind == "accepted" and len(work.calls) == 1 for work in works)
    assert works[0].shared == works[1].shared
    assert [issue.code for _, issues in works[0].shared.values() for issue in issues] == ["reply_malformed"]


def test_a_shared_reading_that_waits_is_asked_once_for_all_its_records(monkeypatch):
    class Waiting(BaseException):
        """As durable planning's `NeedsCall`: the call is captured, its reply comes in a later round."""
    north = candidate("North", "Group North")
    seen = []
    def answer(system, user, schema):
        seen.append(system)
        raise Waiting
    runner, entries = heading_group(monkeypatch, "Group North\n1. First.\n2. Second.", [north] * 2, answer)
    for number, entry in enumerate(entries):
        with pytest.raises(Waiting):
            runner.entry(number, entry)
    assert len(seen) == 1


def test_a_heading_value_waits_for_complete_discovery_to_know_the_records_sharing_it(monkeypatch):
    north = candidate("North", "Group North")
    seen = []
    def answer(system, user, schema):
        seen.append(system)
        return {"R1": north, "R2": north}
    runner, entries = heading_group(monkeypatch, "Group North\n1. First.\n2. Second.", [north] * 2, answer)
    work = runner.entry(0, entries[0], verify=False)  # discovery still reads: later records may share the heading
    assert not seen and (work.found[0].kind, work.found[0].reason) == ("proposed", "verification_pending")
    assert work.record == {"region": "North"} and not work.undecided and not work.failed
    assert runner.entry(0, entries[0]).found[0].kind == "accepted" and len(seen) == 1


def test_a_catalog_counts_the_reading_its_records_share_once():
    source = evidence("Kreis Moor\n1. Adorf.\n2. Bedorf.")
    schema = {"recordDescription": "One numbered entry", "schemaNodes": [{"id": "r", "name": "region", "type": "string"}]}
    moor = candidate("Moor", "Kreis Moor")
    model = Model(source, entry=lambda *_: {"region": moor})
    def answer(system, user, reply_schema):
        if system.startswith(SHARED):
            return dict.fromkeys(reply_schema["properties"], moor)
        return model(system, user, reply_schema)
    result, _ = extract(source, answer, schema=schema, defaults=11)
    assert result["records"] == [{"region": "Moor"}] * 2
    assert [link["linked_by"] for link in result["evidence"]] == ["verification"] * 2
    assert [call["record"] for call in result["calls"] if call["stage"] == "verification"] == [0]


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


@pytest.mark.parametrize("shared", [False, True], ids=["individual", "shared"])
@pytest.mark.parametrize("quote", ["This record is North.", "Other record is North.", "Unadmitted North."])
def test_verification_locates_only_the_source_shown_for_its_own_record(monkeypatch, shared, quote):
    text = "Group North\n1. First part.\nThis record is North.\nUnadmitted North.\n2. Other record is North."
    start, middle, gap, sibling = (text.index(each) for each in ("1.", "This record", "Unadmitted", "2."))
    heading = {"segment": "p1_s0", "start": 0, "end": len("Group North")}
    entries = [{"ranges": [{"segment": "p1_s0", "start": start, "end": middle},
                           {"segment": "p1_s0", "start": middle, "end": gap}], "context": [heading]},
               {"ranges": [{"segment": "p1_s0", "start": sibling, "end": len(text)}], "context": [heading]}]
    reads = [(Window((Unit("p1_s0", start, middle),)), {"region": candidate("North", "Group North")}),
             (Window((Unit("p1_s0", middle, gap),)), {"region": None})]
    def answer(system, user, schema):
        assert system.startswith(SHARED if shared else ALONE)
        assert (quote in user) == shared
        return dict.fromkeys(schema["properties"], candidate("North", quote))
    runner = record_runner(monkeypatch, evidence(text), reads, answer, entries=entries if shared else entries[:1])
    work = runner.entry(0, entries[0])
    found, = work.found
    accepted = shared and quote == "This record is North."
    assert work.record == {"region": "North"}
    assert (found.kind, found.reason) == (("accepted", None) if accepted else
                                         ("proposed", "verification_unresolved"))
    if accepted:
        assert [(span.segment_id, span.start, span.end) for span in found.spans] == [
            ("p1_s0", middle + quote.index("North"), middle + quote.index("North") + len("North"))]
        assert found.verified


def test_heading_group_members_are_stored_once(monkeypatch):
    north = candidate("North", "Group North")
    runner, entries = heading_group(monkeypatch, "Group North\n" + "\n".join(
        f"{number}. Record." for number in range(1, 2001)), [north] * 2000, lambda *_: None)
    group = runner.groups[0]
    assert group[1] == tuple(range(len(entries)))
    assert all(each is group for each in runner.groups.values())


@pytest.mark.parametrize("fields,shared_calls", [(1, 1), (3, 3), (8, 8)])
def test_small_heading_group_call_count_depends_on_inherited_fields(monkeypatch, fields, shared_calls):
    source = evidence("Kreis Moor\n1. Adorf.\n2. Bedorf.")
    schema = {"recordDescription": "One numbered entry", "schemaNodes": [
        {"id": f"f{n}", "name": f"field{n}", "type": "string"} for n in range(fields)]}
    values = {node["name"]: candidate("Moor", "Kreis Moor") for node in schema["schemaNodes"]}
    model = Model(source, entry=lambda *_: values)
    def answer(system, user, reply_schema):
        if system.startswith((SHARED, ALONE)):
            return dict.fromkeys(reply_schema["properties"], candidate("Moor", "Kreis Moor"))
        return model(system, user, reply_schema)
    counts = []
    # One member per call reaches the unchanged individual fallback, which batches the record's fields.
    for size in (1, 16):
        monkeypatch.setattr(unified, "SHARED", size)
        result, _ = extract(source, answer, schema=schema, defaults=11)
        assert result["records"] == [dict.fromkeys(values, "Moor")] * 2
        assert len(result["evidence"]) == fields * 2
        assert all(link["linked_by"] == "verification" for link in result["evidence"])
        counts.append(sum(call["stage"] == "verification" for call in result["calls"]))
    assert counts == [2, shared_calls]

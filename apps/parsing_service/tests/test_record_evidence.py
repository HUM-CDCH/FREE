"""Attribution context must be source-backed and must not make a wrong value acceptable."""
from dataclasses import replace

import pytest

from kei_exp.kie.extract import grounding, unified
from kei_exp.kie.extract.assembly import link_json
from kei_exp.kie.extract.discovery import Unit, Window
from kei_exp.kie.extract.models import as_router
from kei_exp.kie.extract.schema import Schema
from tests.helpers.extraction import CountingChat, WordCounter
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
    links, calls, issues = grounding.verify(source, fields, AUTHORS, Chat(answer), record=0,
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
                                            counter=WordCounter())
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
                                            CountingChat(lambda *_: {"C1": "E1"}), record=0,
                                            counter=WordCounter())
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
    links, _, issues = grounding.verify(record, {"antibodies": 2}, schema, CountingChat(answer), record=0,
                                        counter=WordCounter())
    assert not issues and [(link.segment, link.verbatim, link.location, link.context) for link in links] == [
        (record[0].id, False, None, ())]
    # A heading between the halves is not the word's end either, even in lower case.
    source = passages(["The RF group was signifi-", "foods", "cantly higher than the CF group (34.51)."])
    source[1] = replace(source[1], label="SectionHeader")
    cf = Schema.model_validate({"recordDescription": "One study", "schemaNodes": [
        {"id": "c", "name": "cf", "type": "number"}]})
    links, _, issues = grounding.verify(source, {"cf": 34.51}, cf, CountingChat(answer), record=0,
                                        counter=WordCounter())
    assert not issues and [(link.segment, link.context) for link in links] == [(source[0].id, ())]
    # Nor is the second half, chosen itself, joined back across a heading or other content to the hyphen before them.
    for between in ("SectionHeader", "Text"):
        source[1] = replace(source[1], label=between)
        links, _, issues = grounding.verify(source, {"cf": 34.51}, cf, CountingChat(lambda *_: {"C1": "E3"}),
                                            record=0, counter=WordCounter())
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
                                        schema, CountingChat(lambda *_: reply), record=0, counter=WordCounter())
    whole = {"segment": table.id, "start": 0, "end": len(table.text)}
    assert not issues and [(link.cell, link.context) for link in links] == [
        (None, ()), ("r1_c0", (whole,)), ("r1_c1", (whole,))]


def test_article_retains_an_items_identity_evidence_on_its_claims_and_no_context_for_the_record_itself():
    source = passages(["Author A¹", "¹ Institute B, Country C"])
    fields = {"authors": [{"name": "Author A", "institution": "Institute B"}]}
    def answer(system, user, reply_schema):
        assert "attribute its claims to THIS list item" in system and 'G1 Within authors[0]: {"name": "Author A"' in user
        return {"G1": ["E1"], "C1": "E1", "C2": "E2"}
    links, _, issues = grounding.verify(source, fields, AUTHORS, CountingChat(answer), record=0,
                                        counter=WordCounter())
    # The item's context is kept on each claim it is not already the evidence of.
    assert not issues and [link_json(link).get("context") for link in links] == [
        None, [{"segment": source[0].id, "start": 0, "end": len(source[0].text)}]]
    assert links[1].location["raw"] == "Institute B"
    def record_only(system, user, reply_schema):
        assert list(reply_schema["properties"]) == ["C1"] and "G1" not in user
        return {"C1": "E1"}
    links, _, issues = grounding.verify(source, {"name": "Author A"}, Schema.model_validate({
        "recordDescription": "One author", "schemaNodes": [{"id": "n", "name": "name", "type": "string"}]}),
        CountingChat(record_only), record=0, counter=WordCounter())
    assert not issues and links[0].context == ()


def test_unanswered_record_claim_remains_incomplete():
    schema = Schema.model_validate({"recordDescription": "One record", "schemaNodes": [
        {"id": "n", "name": "name", "type": "string"}]})
    links, _, issues = grounding.verify(passages(["Name A"]), {"name": "Name A"}, schema,
                                       CountingChat(lambda *_: {}), record=0, counter=WordCounter())
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
        AUTHORS, CountingChat(lambda *_: reply), record=0, counter=WordCounter(),
        skip_paths=frozenset({("records", 0, "authors", 0, "name")}))
    assert not links
    result = grounding_accounting({path}, set(), issues)
    assert (result["not_completed"], result["unsupported"]) == ((1, 0) if reason else (0, 1))
    assert result["reasons"] == ({reason: 1} if reason else {})


@pytest.mark.parametrize("reading,accepted", [("North", True), ("South", False), (None, False)])
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
        assert "is to be judged" in system  # kept as measured: see the note on `VERIFY_RECORD`
        assert ' = "North"' not in user  # the independent reading cannot copy the candidate
        assert "source quote" not in system and reply_schema["properties"] == {  # it answers with the value alone
            "C1": {"type": ["string", "null"], "x-free-type": "string"}}
        return {"C1": reading}
    chat = as_router(CountingChat(answer))
    options = unified.UnifiedOptions(defaults=12)
    counters = dict.fromkeys(("fields", "reasoning"), WordCounter())
    effective = unified._execution(source, schema, options, chat, counters)["effective"]
    runner = unified._Run(schema, unified._Budget(chat, counters, effective["stages"]), {"p1_s0": text}, effective)
    start = text.index("2.")
    ranges = [{"segment": "p1_s0", "start": start, "end": len(text)}]
    units = [Unit("p1_s0", start, len(text))]
    heading = (Unit("p1_s0", 0, 10),)  # "Jail North", the context discovery admitted for the second record
    work = unified._Work(found=[unified._Found(("jail",), "North", "Jail North", 0,
                                               kind="rejected", reason="quote_not_in_source")])
    replies = runner._record_evidence(units, heading, False, [(Window(tuple(units)), {})], work,
                                      unified._view(units, runner.texts))
    runner._verify(0, replies, work, owned=units)
    assert seen and (work.found[0].kind == "accepted") == accepted
    assert work.found[0].value == "North"
    if accepted:
        link = unified._link(work.found[0], 0, {p.id: p for p in source.passages}, ranges)
        assert link["context"] == ranges and link["linked_by"] == "verification"


def test_new_catalog_defaults_run_attachment_through_the_real_entry_path():
    source = evidence("Kreis Moor\n1. Adorf.")
    schema = {"recordDescription": "One numbered entry", "schemaNodes": [{"id": "r", "name": "region", "type": "string"}]}
    model = Model(source, entry=lambda *_: {"region": candidate("Moor", "Kreis Moor")})
    def answer(system, user, reply_schema):
        if system.startswith("Read the source independently"):
            return {"C1": "Moor"}
        return model(system, user, reply_schema)
    result, _ = extract(source, answer, schema=schema, defaults=12)
    assert result["records"] == [{"region": "Moor"}]
    assert result["evidence"][0]["context"] == result["discovery"]["entries"][0]["ranges"]
    assert result["evidence"][0]["linked_by"] == "verification"


def record_runner(monkeypatch, source, reads, answer, *, headings=True, field="region", entries=()):
    schema = Schema.model_validate({"recordDescription": "One numbered entry", "schemaNodes": [
        {"id": "r", "name": field, "type": "string"}]})
    chat = as_router(CountingChat(answer))
    counters = dict.fromkeys(("fields", "reasoning"), WordCounter())
    effective = unified._execution(source, schema, unified.UnifiedOptions(defaults=12, headings=headings),
                                   chat, counters)["effective"]
    runner = unified._Run(schema, unified._Budget(chat, counters, effective["stages"]),
                         {p.id: p.text for p in source.passages}, effective, entries=entries)
    monkeypatch.setattr(runner, "_read", lambda *args, **kwargs: reads)
    return runner


@pytest.mark.parametrize("context", [False, True], ids=["no-admitted-heading", "admitted-heading"])
def test_other_records_cannot_supply_inherited_evidence_even_if_the_verifier_agrees(monkeypatch, context):
    text = "Group North\n1. Owner lives in North.\n2. Second."
    start = text.index("2.")
    entry = {"ranges": [{"segment": "p1_s0", "start": start, "end": len(text)}],
             "context": [{"segment": "p1_s0", "start": 0, "end": 11}] if context else []}
    window = Window((Unit("p1_s0", start, len(text)),))
    seen = []
    def answer(system, user, schema):
        seen.append(user)
        return {"C1": "North"}  # agrees: the value alone, which names no place
    runner = record_runner(monkeypatch, evidence(text), [(window, {"region": candidate("North", "Group North")})],
                           answer)
    work = runner.entry(0, entry)
    found, = work.found
    assert work.record == {"region": "North"}
    # Without an admitted heading the quote is located nowhere it may be: nothing reads it again, a proposal for
    # review without Evidence.
    assert len(seen) == context and found.kind == ("accepted" if context else "proposed")
    assert all("Owner lives in North" in user for user in seen)  # intervening text is for judging supersession only
    if context:  # linked at the admitted heading the entry quoted, never where the other record prints the value
        assert [(span.start, span.end) for span in found.spans] == [(6, 11)] and not found.alternatives


def tight_runner(text, reads, answer, input_tokens, **entries):
    """A defaults 12 runner over `text` whose verification input budget is `input_tokens` (WordCounter words)."""
    schema = Schema.model_validate({"recordDescription": "One numbered entry", "schemaNodes": [
        {"id": "r", "name": "region", "type": "string"}]})
    chat = as_router(CountingChat(answer))
    counters = dict.fromkeys(("fields", "reasoning"), WordCounter())
    effective = unified._execution(evidence(text), schema, unified.UnifiedOptions(
        defaults=12, input_tokens=input_tokens), chat, counters)["effective"]
    runner = unified._Run(schema, unified._Budget(chat, counters, effective["stages"]), {"p1_s0": text}, effective,
                          **entries)
    runner._read = lambda stage, number, *args, **kwargs: reads[number]
    return runner


@pytest.mark.parametrize("words,reply,reason,undecided", [
    (1000, {"C1": None}, "verification_over_budget", 0),  # the source up to the record never fits: final
    (5, {}, "verification_unresolved", 1),                # an invalid reply: another attempt may decide it
    (5, {"C1": {}}, "verification_unresolved", 1)])       # so is a reading that is no value, never a rejection
def test_an_inherited_value_whose_own_check_cannot_fit_is_a_final_proposal(words, reply, reason, undecided):
    text = "Group North\n1. " + "word " * words + "\n2. Last."
    start = text.index("2.")
    entry = {"ranges": [{"segment": "p1_s0", "start": start, "end": len(text)}],
             "context": [{"segment": "p1_s0", "start": 0, "end": 11}]}
    seen = []
    def answer(system, user, schema):
        seen.append(user)
        return reply
    runner = tight_runner(text, [[(Window((Unit("p1_s0", start, len(text)),)),
                                   {"region": candidate("North", "Group North")})]], answer, 1024)
    work = runner.entry(0, entry)
    assert [(found.kind, found.reason) for found in work.found] == [("proposed", reason)]
    assert work.undecided == undecided and len(seen) == undecided and not work.failed
    assert work.record == {"region": "North"}
    assert ("verification_over_budget" in [issue.code for issue in work.issues]) == (not undecided)


def test_an_invalid_reading_of_a_records_inherited_fields_is_asked_again_in_halves(monkeypatch):
    text = "Kreis Moor\n1. Adorf."
    start = text.index("1.")
    entry = {"ranges": [{"segment": "p1_s0", "start": start, "end": len(text)}],
             "context": [{"segment": "p1_s0", "start": 0, "end": 10}]}
    schema = Schema.model_validate({"recordDescription": "One numbered entry", "schemaNodes": [
        {"id": "r", "name": "region", "type": "string"}, {"id": "d", "name": "district", "type": "string"}]})
    asked = []
    def answer(system, user, reply_schema):
        asked.append(list(reply_schema["properties"]))
        return {} if len(asked) == 1 else {"C1": "Moor"}
    chat = as_router(CountingChat(answer))
    counters = dict.fromkeys(("fields", "reasoning"), WordCounter())
    effective = unified._execution(evidence(text), schema, unified.UnifiedOptions(defaults=12), chat,
                                   counters)["effective"]
    runner = unified._Run(schema, unified._Budget(chat, counters, effective["stages"]), {"p1_s0": text}, effective)
    read = {"region": candidate("Moor", "Kreis Moor"), "district": candidate("Moor", "Kreis Moor")}
    monkeypatch.setattr(runner, "_read", lambda *args, **kwargs: [(Window((Unit("p1_s0", start, len(text)),)), read)])
    work = runner.entry(0, entry)
    assert asked == [["C1", "C2"], ["C1"], ["C1"]]  # one record alone: its fields read together, then each alone
    assert [(found.kind, found.verified) for found in work.found] == [("accepted", True)] * 2 and not work.undecided


@pytest.mark.parametrize("quote", ["Lives in West", "nowhere printed"], ids=["local-beside", "alone"])
def test_a_value_cited_nowhere_stays_in_the_record_without_a_second_reading(monkeypatch, quote):
    text = "Group North\n1. Lives in West.\nContinued."
    start, middle = text.index("1."), text.index("Continued")
    entry = {"ranges": [{"segment": "p1_s0", "start": start, "end": len(text)}],
             "context": [{"segment": "p1_s0", "start": 0, "end": 11}]}
    # One record read in two windows; the second quotes the same field where it is printed nowhere.
    reads = [(Window((Unit("p1_s0", start, middle),)), {"region": candidate("West", quote)}),
             (Window((Unit("p1_s0", middle, len(text)),)), {"region": candidate("West", "nowhere printed")})]
    seen = []
    runner = record_runner(monkeypatch, evidence(text), reads, lambda *args: seen.append(args) or {})
    work = runner.entry(0, entry)
    assert not seen and work.record == {"region": "West"}
    assert {(found.kind, found.reason) for found in work.found} == {("proposed", "quote_not_in_source")} | (
        {("accepted", None)} if quote == "Lives in West" else set())


@pytest.mark.parametrize("reading,accepted", [("metres", True), ("feet", False)])
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
        return {"C1": "gold"}
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
        return {"C1": "North" if "### RECORD\n1." in user else "South"}
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
        assert "quote" not in system and schema["properties"]["R1"] == {  # each reading is the value alone
            "type": ["string", "null"], "x-free-type": "string"}
        return {"R1": "North", "R2": "North", "R3": "South"}
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


@pytest.mark.parametrize("reading,kind", [("North", "accepted"), ("South", "rejected"), (None, "rejected")])
def test_a_shared_reading_is_accepted_only_when_it_equals_the_candidate(monkeypatch, reading, kind):
    north = candidate("North", "Group North")
    runner, entries = heading_group(monkeypatch, "Group North\n1. Owner lives in North.\n2. Second.", [north] * 2,
                                    lambda *_: {"R1": "North", "R2": reading})
    assert runner.entry(1, entries[1]).found[0].kind == kind
    assert runner.entry(0, entries[0]).found[0].kind == "accepted"


def test_a_local_or_uncited_value_is_not_read_with_the_records_sharing_the_heading(monkeypatch):
    seen = []
    def answer(system, user, schema):
        seen.append(system)
        return {"C1": "West"}
    runner, entries = heading_group(monkeypatch, "Group North\n1. Lives in West.\n2. Second.",
                                    [candidate("West", "Lives in West")] * 2, answer)
    assert runner.entry(0, entries[0]).found[0].kind == "accepted" and not seen  # local: the single pass
    work = runner.entry(1, entries[1])  # cited nowhere it may be: never read, nor from another record
    assert not seen and not work.shared
    assert (work.found[0].kind, work.found[0].reason) == ("proposed", "quote_not_in_source")


def test_a_shared_reading_without_a_valid_reply_leaves_each_record_its_own_reading(monkeypatch):
    north = candidate("North", "Group North")
    seen = []
    def answer(system, user, schema):
        seen.append(system)
        return {} if system.startswith(SHARED) else {"C1": "North"}
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
        return {"R1": "North", "R2": "North"}
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
            return dict.fromkeys(reply_schema["properties"], "Moor")
        return model(system, user, reply_schema)
    result, _ = extract(source, answer, schema=schema, defaults=12)
    assert result["records"] == [{"region": "Moor"}] * 2
    assert [link["linked_by"] for link in result["evidence"]] == ["verification"] * 2
    assert [call["record"] for call in result["calls"] if call["stage"] == "verification"] == [0]


@pytest.mark.parametrize("verdict", ["supported", "unsupported"])
def test_local_table_values_keep_single_pass_outside_the_item_identity_cell(verdict):
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
    result, _ = extract(source, answer, schema=PARTS)
    assert not any(call["stage"] == "verification" for call in result["calls"])
    assert result["records"] == [{"parts": parts}]
    descriptions = [link for link in result["evidence"] if link["path"][-1] == "description"]
    assert [link["cell"] for link in descriptions] == ["r0_c1", "r1_c1"]
    assert [link["item"] for link in descriptions] == [link["spans"] for link in result["evidence"] if link["path"][-1] == "number"]


@pytest.mark.parametrize("shared", [False, True], ids=["individual", "shared"])
def test_an_agreed_reading_keeps_the_place_code_located_for_the_entrys_quote(monkeypatch, shared):
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
        return dict.fromkeys(schema["properties"], "North")
    runner = record_runner(monkeypatch, evidence(text), reads, answer, entries=entries if shared else entries[:1])
    work = runner.entry(0, entries[0])
    found, = work.found
    assert work.record == {"region": "North"} and (found.kind, found.reason, found.verified) == ("accepted", None, True)
    # The reading names no place: the link stays on the heading the entry quoted, wherever else the value prints
    # (later in the record, in unadmitted text, in the next record).
    assert [(span.segment_id, span.start, span.end) for span in found.spans] == [("p1_s0", 6, 11)]
    assert (found.support, found.alternatives) == ("literal", [])


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
            return dict.fromkeys(reply_schema["properties"], "Moor")
        return model(system, user, reply_schema)
    counts = []
    # One member per call reaches the unchanged individual fallback, which batches the record's fields.
    for size in (1, 16):
        monkeypatch.setattr(unified, "SHARED", size)
        result, _ = extract(source, answer, schema=schema, defaults=12)
        assert result["records"] == [dict.fromkeys(values, "Moor")] * 2
        assert len(result["evidence"]) == fields * 2
        assert all(link["linked_by"] == "verification" for link in result["evidence"])
        counts.append(sum(call["stage"] == "verification" for call in result["calls"]))
    assert counts == [2, shared_calls]


def test_readings_of_different_headings_are_asked_at_once_and_each_once(monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor
    text = "Group North\n1. First.\n2. Second.\nGroup South\n3. Third.\n4. Fourth."
    entries, reads = [], []
    for number, name in enumerate(("North", "North", "South", "South")):
        start = text.index(f"{number + 1}.")
        end = text.find("\n", start) if number < 3 else len(text)
        heading = text.index(f"Group {name}")
        entries.append({"ranges": [{"segment": "p1_s0", "start": start, "end": end}],
                        "context": [{"segment": "p1_s0", "start": heading, "end": heading + len(f"Group {name}")}]})
        reads.append([(Window((Unit("p1_s0", start, end),)), {"region": candidate(name, f"Group {name}")})])
    both = threading.Barrier(2, timeout=5)  # a third call, or one heading's call held behind the other's, breaks it
    seen = []
    def answer(system, user, schema):
        seen.append(user)
        both.wait()
        return dict.fromkeys(schema["properties"], "North" if "Group North" in user else "South")
    runner = record_runner(monkeypatch, evidence(text), None, answer, entries=entries)
    monkeypatch.setattr(runner, "_read", lambda stage, number, *args, **kwargs: reads[number])
    with ThreadPoolExecutor(max_workers=4) as pool:
        works = list(pool.map(lambda number: runner.entry(number, entries[number]), range(4)))
    assert len(seen) == 2
    assert [work.found[0].kind for work in works] == ["accepted"] * 4
    assert len({key for work in works for key in work.shared}) == 2


@pytest.mark.parametrize("stop,asked", [("NeedsCall", ["a", "b", "c"]), ("Boundary", ["a"])])
def test_one_planning_round_captures_the_shared_reading_of_every_inherited_field(stop, asked):
    from kei_exp.kie.extract import durable
    stop = getattr(durable, stop)  # a call captured for later, or no call may start: the round ends at once
    text = "Group North\n1. First.\n2. Second."
    schema = Schema.model_validate({"recordDescription": "One numbered entry", "schemaNodes": [
        {"id": name, "name": name, "type": "string"} for name in ("a", "b", "c")]})
    seen = []
    def answer(system, user, reply_schema):
        seen.append(user.rsplit("### FIELD\n", 1)[1].split("\n", 1)[0])
        raise stop
    chat = as_router(CountingChat(answer))
    counters = dict.fromkeys(("fields", "reasoning"), WordCounter())
    effective = unified._execution(evidence(text), schema, unified.UnifiedOptions(defaults=12), chat,
                                   counters)["effective"]
    heading = {"segment": "p1_s0", "start": 0, "end": len("Group North")}
    units = [Unit("p1_s0", text.index(line), text.index(line) + len(line)) for line in ("1. First.", "2. Second.")]
    entries = [{"ranges": [{"segment": "p1_s0", "start": unit.start, "end": unit.end}], "context": [heading]}
               for unit in units]
    runner = unified._Run(schema, unified._Budget(chat, counters, effective["stages"]), {"p1_s0": text}, effective,
                          entries=entries)
    north = candidate("North", "Group North")
    runner._read = lambda stage, number, *args, **kwargs: [(Window((units[number],)), dict.fromkeys("abc", north))]
    for number, entry in enumerate(entries):
        with pytest.raises(stop):
            runner.entry(number, entry)
    assert seen == asked


def test_a_group_halves_its_shared_reading_and_leaves_the_records_no_check_can_fit_final():
    from collections import Counter
    text = "Group North\n" + "\n".join(f"{n}. {' '.join(['word'] * 60)}." for n in range(1, 17))
    lines = text.split("\n")
    heading = {"segment": "p1_s0", "start": 0, "end": len(lines[0])}
    units = [Unit("p1_s0", text.index(line), text.index(line) + len(line)) for line in lines[1:]]
    entries = [{"ranges": [{"segment": "p1_s0", "start": unit.start, "end": unit.end}], "context": [heading]}
               for unit in units]
    north = candidate("North", "Group North")
    seen = []
    def answer(system, user, schema):
        seen.append(system)
        return dict.fromkeys(schema["properties"], "North")
    runner = tight_runner(text, [[(Window((unit,)), {"region": north})] for unit in units], answer, 1024,
                          entries=entries)
    works = [runner.entry(number, entry) for number, entry in enumerate(entries)]
    # The 16 records do not fit one reading: its halves read the first 12, two calls; the source up to each of the
    # last 4 is too long for any reading of theirs, which leaves them final proposals, not undecided.
    assert Counter((work.found[0].kind, work.found[0].reason) for work in works) == {
        ("accepted", None): 12, ("proposed", "verification_over_budget"): 4}
    assert [each.startswith(SHARED) for each in seen] == [True, True]
    assert not any(work.undecided or work.failed for work in works)


def test_durable_planning_asks_every_inherited_fields_shared_reading_in_the_same_round():
    from dataclasses import asdict
    from kei_exp.kie.extract import calls, run
    from kei_exp.kie.extract.durable import CapturePlanner, NeedsCall
    from kei_exp.kie.extract.models import Router
    from tests.test_durable_extraction import Counter, MemoryLease
    from tests.test_unified_catalog import request

    def rounds(fields):
        """Planning rounds to the result, every call captured in a round answered before the next."""
        source = evidence("Kreis Moor\n1. Adorf.\n2. Bedorf.")
        schema = {"recordDescription": "One numbered entry", "schemaNodes": [
            {"id": f"f{n}", "name": f"field{n}", "type": "string"} for n in range(fields)]}
        moor = candidate("Moor", "Kreis Moor")
        model = Model(source, entry=lambda *_: {node["name"]: moor for node in schema["schemaNodes"]})
        def answer(system, user, reply_schema):
            if system.startswith(SHARED):
                return dict.fromkeys(reply_schema["properties"], "Moor")
            return model(system, user, reply_schema)
        chat, asked = CountingChat(answer), request(schema, defaults=12)
        lease = MemoryLease(asked.schema_.model_dump(by_alias=True, exclude_none=True))
        for count in range(1, 40):
            counter = Counter()
            planner = CapturePlanner(lease, {"fields": counter, "reasoning": counter})
            try:
                result = run.dispatch(None, source, asked, Router(chat, chat, planner), counter=counter)
            except NeedsCall:
                for unit in lease.units.values():
                    if unit["id"] in planner.pending:
                        body = dict(unit["input"]["request"]["body"])
                        body.pop("max_whitespace")
                        parsed, attempts = calls.complete(chat, **body, counter=counter)
                        unit["checkpoint"] = {"output": {"parsed": parsed, "calls": [asdict(c) for c in attempts]}}
                continue
            assert result["records"] == [{node["name"]: "Moor" for node in schema["schemaNodes"]}] * 2
            assert sum(each.startswith(SHARED) for each in (call["system"] for call in chat.calls)) == fields
            return count
        raise AssertionError("planning never completed")
    assert rounds(3) == rounds(1)


def test_a_catalog_whose_later_checks_cannot_fit_completes_processing_and_keeps_their_values_for_review():
    text = "Kreis Moor\n" + "\n".join(f"{n}. Fund {' '.join(['wort'] * 60)}." for n in range(1, 17))
    source = evidence(text)
    schema = {"recordDescription": "One numbered entry", "schemaNodes": [{"id": "r", "name": "region", "type": "string"}]}
    moor = candidate("Moor", "Kreis Moor")
    model = Model(source, entry=lambda *_: {"region": moor})
    def answer(system, user, reply_schema):
        if system.startswith(SHARED):
            return dict.fromkeys(reply_schema["properties"], "Moor")
        return model(system, user, reply_schema)
    result, _ = extract(source, answer, schema=schema, defaults=12, input_tokens=1024)
    # The source from the heading to each of the last 4 records is longer than any check of theirs can show.
    over = [issue["path"][1] for issue in result["issues"] if issue["code"] == "verification_over_budget"]
    assert result["records"] == [{"region": "Moor"}] * 16 and over == [12, 13, 14, 15]
    assert sorted({link["path"][1] for link in result["evidence"]}) == list(range(12))
    assert result["completeness"]["processing"] and not result["completeness"]["evidence"]


def test_a_value_cited_nowhere_is_not_read_again_because_another_window_inherits_the_field(monkeypatch):
    text = "Group North\n1. Lives somewhere.\nContinued."
    start, middle = text.index("1."), text.index("Continued")
    entry = {"ranges": [{"segment": "p1_s0", "start": start, "end": len(text)}],
             "context": [{"segment": "p1_s0", "start": 0, "end": 11}]}
    # One record read in two windows: the first inherits North from the heading, the second cites West nowhere.
    reads = [(Window((Unit("p1_s0", start, middle),)), {"region": candidate("North", "Group North")}),
             (Window((Unit("p1_s0", middle, len(text)),)), {"region": candidate("West", "nowhere printed")})]
    seen = []
    def answer(system, user, schema):
        seen.append(user)
        return dict.fromkeys(schema["properties"], "South")
    work = record_runner(monkeypatch, evidence(text), reads, answer).entry(0, entry)
    assert len(seen) == 1 and work.record == {"region": "West"}  # the reading contradicts the inherited value only
    assert [(found.value, found.kind, found.reason) for found in work.found] == [
        ("North", "rejected", "verification_rejected"), ("West", "proposed", "quote_not_in_source")]


@pytest.mark.parametrize("padding_words,expected_checks", [(5, 1), (1000, 0)])
def test_local_evidence(padding_words, expected_checks):
    text = "Group North\n1. " + "word " * padding_words + "\n2. Lives in West.\nContinued."
    start, middle = text.index("2."), text.index("Continued")
    entry = {"ranges": [{"segment": "p1_s0", "start": start, "end": len(text)}],
             "context": [{"segment": "p1_s0", "start": 0, "end": 11}]}
    reads = [
        (Window((Unit("p1_s0", start, middle),)), {"region": candidate("West", "Lives in West")}),
        (Window((Unit("p1_s0", middle, len(text)),)), {"region": candidate("North", "Group North")}),
    ]
    seen = []

    def answer(system, user, schema):
        seen.append(user)
        return {"C1": None}

    work = tight_runner(text, [reads], answer, 1024).entry(0, entry)
    # Only the inherited candidate depends on this check, whether it rejects or never fits the budget.
    local, inherited = work.found
    assert (local.value, local.kind, local.reason, local.verified) == ("West", "accepted", None, False)
    expected_reason = "verification_rejected" if expected_checks else "verification_over_budget"
    assert inherited.reason == expected_reason
    assert work.record == {"region": "West"} and len(seen) == expected_checks


def test_a_shared_reading_without_a_records_value_is_asked_again_never_a_rejection(monkeypatch):
    north = candidate("North", "Group North")
    seen = []
    def answer(system, user, schema):
        seen.append(system)
        return {"R1": "North", "R2": {}} if system.startswith(SHARED) else {"C1": "North"}
    runner, entries = heading_group(monkeypatch, "Group North\n1. First.\n2. Second.", [north] * 2, answer)
    works = [runner.entry(number, entry) for number, entry in enumerate(entries)]
    assert [each.startswith(SHARED) for each in seen] == [True, False, False]  # then each record alone
    assert all(work.record == {"region": "North"} and work.found[0].kind == "accepted" for work in works)

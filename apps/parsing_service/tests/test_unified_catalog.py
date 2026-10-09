"""The unified Catalog, end to end with a scripted model: discovery, source accounting, complete windows, evidence,
merging, document fields and the write-once execution and discovery records.

The model answers from the text in its own prompt, as a careful model would: records start at a printed number
(`12.`), a `第3号` label or a `◆` mark; `Kreis`, `Index` and `Vorwort` lines belong to no record. Discovery sees the
whole document only to answer honestly whether its window begins or ends inside a record. The counter counts words, so
budgets are easy to reason about; the chat reports the same count, as an honest server does.
"""
import json
import os
import re
from dataclasses import replace
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
import requests
from pydantic import ValidationError

from kei_exp.kie.extract import discovery, run, unified
from kei_exp.kie.extract.llm import Reply
from kei_exp.kie.extract.models import as_router
from kei_exp.kie.passages import Evidence, Passage, load
from kei_exp.pagefile import PageTable, TableCell
from tests.helpers import catalogue
from tests.helpers.contracts import FIXTURES
from tests.test_extract_grounded import CountingChat, WordCounter

SCHEMA = {"recordDescription": "One entry of a catalogue of finds.", "schemaNodes": [
    {"id": "l", "name": "label", "type": "string", "description": "the printed number or mark"},
    {"id": "s", "name": "site", "type": "string"},
    {"id": "m", "name": "material", "type": "string"},
    {"id": "g", "name": "gilded", "type": "boolean"},
    {"id": "f", "name": "finds", "type": "array", "children": [
        {"id": "fn", "name": "name", "type": "string"}, {"id": "fc", "name": "count", "type": "integer"}]},
    {"id": "t", "name": "title", "type": "string", "valueSource": "document"},
]}
START = re.compile(r"(?<!\S)(\d+[a-z]?\.|第\d+号|◆)(?=\s)")
OTHER = re.compile(r"^(Kreis|Index|Vorwort)\b.*$", re.M)


def passage(pid: str, text: str, *, label: str = "Text", table: PageTable | None = None, status: str = "ok") -> Passage:
    page, index = (int(part) for part in pid[1:].split("_s"))
    return Passage(id=pid, page=page, index=index, text=text, label=label, bbox_pt=(0.0, 0.0, 1.0, 1.0),
                   extent="block", table=table, status=status)


def evidence(*texts: str, withheld: tuple[Passage, ...] = ()) -> Evidence:
    return Evidence(run_id="run-u", generation="g1", digest="d1", source_name="catalogue.pdf", page_count=len(texts),
                    passages=tuple(passage(f"p{n + 1}_s0", text) for n, text in enumerate(texts)), withheld=withheld)


def section(user: str, name: str) -> str:
    match = re.search(rf"### {name}\n(.*?)(?:\n### END {name}|\n\n### |\n\nReturn the JSON)", user, re.S)
    return match[1] if match else ""


def marks(text: str) -> list[tuple[int, str, str | None]]:
    """Record starts and record-free lines in `text`: (position, kind, printed label)."""
    return sorted([(m.start(), "record", m[1]) for m in START.finditer(text)]
                  + [(m.start(), "other", None) for m in OTHER.finditer(text)])


class Model:
    """A careful scripted model; each stage's answer can be replaced by a test."""

    def __init__(self, source: Evidence, *, discovery=None, entry=None, verdict=None, choice="C1", document=None):
        self.full = "\n".join(each.text for each in source.passages)
        self.discovery, self.entry_fields, self.verdict, self.choice = discovery, entry, verdict, choice
        self.document_fields = document

    def __call__(self, system: str, user: str, schema: dict):
        if system.startswith("You find where records begin"):
            return (self.discovery or self.discover)(user)
        if system.startswith("You extract structured data from one record"):
            return (self.entry_fields or fields)(section(user, "RECORD"), user, schema)
        if system.startswith("You check values"):
            candidates = re.findall(r"^(C\d+): (\S+) = (.*) \(quoted: (.*)\)$", user, re.M)
            return {label: (self.verdict or (lambda *_: "supported"))(path, json.loads(value), section(user, "RECORD"))
                    for label, path, value, _ in candidates}
        if system.startswith("Several verified candidate"):
            return {"choice": self.choice}
        if system.startswith("You extract fields that describe"):
            return (self.document_fields or title)(section(user, "SOURCE"))
        raise AssertionError(system)

    def discover(self, user: str) -> dict:
        lines = re.findall(r"^\[(L\d+)\] (.*)$", section(user, "WINDOW"), re.M)
        places = [[label, kind, printed, *([text[at:at + 12]] if at else [])]
                  for label, text in lines for at, kind, printed in marks(text)]
        first = self.full.find(lines[0][1])
        last = self.full.find(lines[-1][1]) + len(lines[-1][1])
        before = marks(self.full[:first])
        opens = bool(places) and places[0][0] == "L1" and len(places[0]) == 3
        inside_at_end = ([mark[1] for mark in marks(self.full[:last])] or ["other"])[-1] == "record"
        rest = self.full[last:].lstrip()
        return {"places": places,
                "begins_inside_record": not opens and bool(before) and before[-1][1] == "record",
                "ends_inside_record": inside_at_end and bool(rest) and not marks(rest[:40]) or
                (inside_at_end and bool(rest) and marks(rest[:40])[0][0] > 0)}


def candidate(value, quote):
    return {"value": value, "quote": quote}


def fields(record: str, user: str, schema: dict) -> dict:
    """Reads a record like a careful model: its mark, the site after it, `Material:`, `Gilded` and each `Find:`."""
    answer = dict.fromkeys(schema["properties"])
    if mark := START.match(record):
        answer["label"] = candidate(mark[1].rstrip("."), mark[1])
        if site := re.match(r"\S+\s+([^.]+)\.", record):
            answer["site"] = candidate(site[1], site[1])
    if material := re.search(r"Material: (\w+)", record):
        answer["material"] = candidate(material[1], material[0])
    if "Gilded" in record:
        answer["gilded"] = candidate(True, "Gilded")
    shown = "\n".join(section(user, name) for name in ("EARLIER TEXT", "RECORD", "LATER TEXT"))  # items crossing a cut
    finds = [{"name": candidate(m[1], m[1]), "count": candidate(int(m[2]), f"({m[2]})"), unified.ITEM: m[0]}
             for m in re.finditer(r"Find: (\w+) \((\d+)\)", shown)]
    answer["finds"] = finds or None
    return answer


def title(source: str) -> dict:
    found = re.search(r"Title: ([^.\n]+)", source)
    return {"title": candidate(found[1], found[0]) if found else None}


def request(schema=SCHEMA, start_page: int | None = None, **settings) -> run.ExtractRequest:
    return run.ExtractRequest.model_validate({"schema": schema, "options": {
        "strategy": "catalog", "unified": {"defaults": 1, **settings},
        **({"start_page": start_page} if start_page is not None else {})}})


def extract(source: Evidence, model=None, *, schema=SCHEMA, counter=None, run_dir=None,
            start_page: int | None = None, **settings):
    chat = CountingChat(model or Model(source))
    result = unified.extract(run_dir, source, request(schema, start_page, **settings), as_router(chat),
                             counter=counter or WordCounter())
    assert_links_resolve(result)
    return result, chat


def assert_links_resolve(result: dict) -> None:
    """Every evidence link names a populated value of the records, at exactly its path."""
    for link in result["evidence"]:
        value = {"records": result["records"]}
        for step in link["path"]:
            value = value[step] if isinstance(value, dict) or (isinstance(step, int) and step < len(value)) else None
            assert value is not None, link["path"]


def ranges(result: dict, disposition: str) -> list[tuple[str, int, int]]:
    return [(row["segment"], row["start"], row["end"]) for row in result["discovery"]["ledger"]
            if row["disposition"] == disposition]


def text(source: Evidence, row: dict) -> str:
    return next(each.text for each in (*source.passages, *source.withheld)
                if each.id == row["segment"])[row["start"]:row["end"]]


def assert_accounted(source: Evidence, result: dict) -> None:
    """Every nonblank character has exactly one ledger disposition; only White_Space lies outside the ledger."""
    owned: dict[str, list[int]] = {}
    for row in result["discovery"]["ledger"]:
        owned.setdefault(row["segment"], []).extend(range(row["start"], row["end"]))
    for each in (*source.passages, *source.withheld):
        positions = owned.get(each.id, [])
        assert len(positions) == len(set(positions)), each.id
        blank = [at for at, char in enumerate(each.text) if at not in set(positions)]
        assert all(each.text[at] in discovery.WHITE_SPACE for at in blank), each.id


def paths(result: dict, key: str = "evidence") -> list[list]:
    return [item["path"] for item in result[key]]


# --- discovery and accounting ------------------------------------------------------------------------------------

def test_records_sharing_one_line_and_segment_are_distinct_entries():
    source = evidence("Vorwort des Herausgebers.\n12. Adorf. Material: Bronze. 13. Bdorf. Material: Eisen.\n"
                      "14. Cdorf. Material: Gold. Gilded.")
    result, _ = extract(source)
    entries = result["discovery"]["entries"]
    assert [entry["label"] for entry in entries] == ["12.", "13.", "14."]
    assert [text(source, entry["ranges"][0]) for entry in entries] == [
        "12. Adorf. Material: Bronze.", "13. Bdorf. Material: Eisen.", "14. Cdorf. Material: Gold. Gilded."]
    assert [record["material"] for record in result["records"]] == ["Bronze", "Eisen", "Gold"]
    assert ranges(result, "other") == [("p1_s0", 0, 25)]
    assert result["complete"] is True and result["completeness"]["recall"] == "unmeasured"
    assert_accounted(source, result)


def test_unnumbered_and_non_latin_records_use_the_same_method():
    source = evidence("◆ Adorf. Material: Bronze.\n◆ Bdorf. Material: Eisen.", "第3号 北京出土 Material: Jade.")
    result, _ = extract(source)
    assert len(result["records"]) == 3
    assert [entry["label"] for entry in result["discovery"]["entries"]] == ["◆", "◆", "第3号"]
    assert [entry["id"] for entry in result["discovery"]["entries"]] == ["p1_s0@0", "p1_s0@27", "p2_s0@0"]
    assert result["records"][2]["material"] == "Jade"
    assert_accounted(source, result)


def test_the_evidence_of_a_value_in_an_unspaced_script_is_its_exact_span():
    source = evidence("第3号 北京出土的玉器。")

    def entry(record, user, schema):
        return {**dict.fromkeys(schema["properties"]), "site": candidate("北京", "北京出土的玉器")}
    result, _ = extract(source, Model(source, entry=entry))
    (link,) = result["evidence"]
    assert link["path"] == ["records", 0, "site"] and link["support"] == "literal"
    assert link["raw"] == "北京" and link["spans"] == [{"segment": "p1_s0", "start": 4, "end": 6}]


def test_a_record_continues_across_windows_only_on_both_sides_explicit_observations():
    records = [f"{n}. Ort{n}. " + " ".join(["Beschreibung"] * 60) + f" Material: M{n}." for n in range(1, 7)]
    source = evidence("\n".join(sum(([record[:300], record[300:]] for record in records), [])))
    for overlap in (0, 1):
        result, _ = extract(source, overlap=overlap, input_tokens=520, output_tokens=64)
        assert result["processing"]["discovery"]["windows"] > 1
        assert [record["material"] for record in result["records"]] == [f"M{n}" for n in range(1, 7)]
        assert result["completeness"]["boundaries"] is True
        assert_accounted(source, result)


CUT = [f"{n}. Ort{n}. " + " ".join(["Beschreibung"] * 60) + f" Material: M{n}." for n in range(1, 7)]


def test_a_record_cut_by_the_end_of_the_supplied_source_ends_at_the_source_end():
    """An excerpt whose last record continues past it: nothing was left unread, so the boundaries are settled."""
    source = evidence("\n".join(sum(([record[:300], record[300:]] for record in CUT), [])) + "\nund weiter")
    model = Model(source)

    def excerpt(user):
        answer = model.discover(user)
        return {**answer, "ends_inside_record": True} if "und weiter" in section(user, "WINDOW") else answer
    result, _ = extract(source, Model(source, discovery=excerpt), overlap=0, input_tokens=520, output_tokens=64)
    assert result["processing"]["discovery"]["windows"] > 1 and result["discovery"]["version"] == discovery.VERSION
    ends = [entry["end"] for entry in result["discovery"]["entries"]]
    assert ends == ["validated"] * 5 + ["source_end"]
    assert result["completeness"]["boundaries"] is True and result["complete"] is True
    assert result["records"][-1]["material"] == "M6"
    assert_accounted(source, result)


def excerpt_ending_inside_a_record(withheld: tuple[Passage, ...]) -> dict:
    source = replace(evidence("\n".join(sum(([record[:300], record[300:]] for record in CUT), []))),
                     withheld=withheld)
    model = Model(source)

    def excerpt(user):
        answer = model.discover(user)
        return {**answer, "ends_inside_record": True} if "Material: M6" in section(user, "WINDOW") else answer
    result, _ = extract(source, Model(source, discovery=excerpt), overlap=0, input_tokens=520, output_tokens=64)
    assert_accounted(source, result)
    return result


def test_a_record_continuing_into_withheld_text_is_unresolved_not_at_the_source_end():
    """Unread text follows the last record: it may continue there, so its end is not settled."""
    result = excerpt_ending_inside_a_record((passage("p1_s1", "unreadable scan", status="failed"),))
    assert [entry["end"] for entry in result["discovery"]["entries"]] == ["validated"] * 5 + ["unresolved"]
    assert result["completeness"]["boundaries"] is False and result["complete"] is False
    assert ranges(result, "withheld") == [("p1_s1", 0, 15)]


def test_only_nonblank_withheld_text_after_the_last_record_unsettles_its_end():
    """A skipped picture has no text to continue the record; withheld text before the last record is not after it."""
    result = excerpt_ending_inside_a_record((passage("p0_s5", "unreadable scan", status="failed"),
                                             passage("p1_s1", " \n", label="Picture", status="skipped")))
    assert [entry["end"] for entry in result["discovery"]["entries"]] == ["validated"] * 5 + ["source_end"]
    assert result["completeness"]["boundaries"] is True and result["complete"] is True


def test_a_middle_window_continuation_the_next_window_denies_stays_unresolved():
    source = evidence("\n".join(sum(([record[:300], record[300:]] for record in CUT), [])))
    model = Model(source)

    def denying(user):
        answer = model.discover(user)
        return {**answer, "begins_inside_record": False} if answer["begins_inside_record"] else answer
    result, _ = extract(source, Model(source, discovery=denying), overlap=0, input_tokens=520, output_tokens=64)
    ends = [entry["end"] for entry in result["discovery"]["entries"]]
    assert "unresolved" in ends and "source_end" not in ends and ends[-1] == "validated"
    assert result["completeness"]["boundaries"] is False and result["complete"] is False
    assert_accounted(source, result)


def test_silence_or_disagreement_at_a_window_boundary_leaves_the_head_unresolved():
    lines = [f"{n}. Ort{n}. " + " ".join(["Text"] * 100) for n in range(1, 4)] + ["more of three " * 33] * 2
    source = evidence("\n".join(lines))
    model = Model(source)

    def unsure(user):
        answer = model.discover(user)
        return {**answer, "begins_inside_record": None} if not answer["places"] else answer
    result, _ = extract(source, Model(source, discovery=unsure), overlap=0, input_tokens=520, output_tokens=64)
    unresolved = ranges(result, "unresolved")
    assert unresolved and text(source, result["discovery"]["ledger"][-1]).startswith("more of three")
    assert result["discovery"]["entries"][-1]["end"] == "unresolved"
    assert result["completeness"]["boundaries"] is False and result["complete"] is False
    assert_accounted(source, result)


def test_a_failed_discovery_window_never_extends_the_previous_record():
    lines = [f"{n}. Ort{n}. Material: M{n}. " + " ".join(["Text"] * 60) for n in range(1, 7)]
    source = evidence("\n".join(lines))
    model = Model(source)

    def failing(user):
        if "4. Ort4" in section(user, "WINDOW"):
            return Reply('{"places": [', 50, 4096, "length", 0.0)
        return model.discover(user)
    result, _ = extract(source, Model(source, discovery=failing), overlap=0, input_tokens=520, output_tokens=64)
    assert "4. Ort4" in "".join(text(source, row) for row in result["discovery"]["ledger"]
                                if row["disposition"] == "unresolved")
    assert all("Ort4" not in (record["site"] or "") for record in result["records"])
    before = next(entry for entry in result["discovery"]["entries"] if entry["label"] == "3.")
    assert before["end"] == "unresolved"
    assert [record["material"] for record in result["records"]] == ["M1", "M2", "M3", "M5", "M6"]
    assert result["processing"]["discovery"]["failed"] == 1 and result["completeness"]["processing"] is False
    assert result["complete"] is False
    assert_accounted(source, result)


def test_a_cut_off_discovery_reply_is_retried_on_halves():
    lines = [f"{n}. Ort{n}. Material: M{n}." for n in range(1, 9)]
    source = evidence("\n".join(lines))
    model = Model(source)

    def crowded(user):
        shown = re.findall(r"^\[L\d+\]", section(user, "WINDOW"), re.M)
        return Reply("{", 50, 4096, "length", 0.0) if len(shown) > 2 else model.discover(user)
    result, _ = extract(source, Model(source, discovery=crowded))
    assert [record["material"] for record in result["records"]] == [f"M{n}" for n in range(1, 9)]
    assert result["processing"]["discovery"]["failed"] == 0
    assert any(call["stage"] == "discovery" and not call["ok"] for call in result["calls"])


@pytest.mark.parametrize("by", ["budget", "page", "column"])
def test_a_record_continues_across_columns_and_page_furniture(by):
    source = replace(evidence(""), passages=(
        passage("p1_s0", "Index: running header", label="PageHeader"),
        replace(passage("p1_s1", "1. Ort. Body A had"), crop=1),
        replace(passage("p1_s2", "short hair and"), crop=2),
        passage("p1_s3", "Index: running footer", label="PageFooter"),
        passage("p2_s0", "38", label="PageHeader"),  # a page of furniture alone
        passage("p3_s0", "Index: running header", label="PageHeader"),
        passage("p3_s1", "Material: Stein."),
        passage("p3_s2", "Kreis Süd", label="SectionHeader"),
        passage("p3_s3", "2. Dorf. Material: Holz."),
    ))
    model = Model(replace(source, passages=tuple(each for each in source.passages
                                                 if each.label not in ("PageHeader", "PageFooter"))))

    def ask(record, system, user, schema, calls, issues):
        assert "running" not in user and "38" not in user
        return model.discover(user)
    result = discovery.discover(source, "entry", lambda *_: True, ask, overlap=3, splits=0, by=by)
    first, second = result["entries"]
    assert [row["segment"] for row in first["ranges"]] == ["p1_s1", "p1_s2", "p3_s1"] and first["end"] == "validated"
    assert [row["segment"] for row in second["context"]] == ["p3_s2"]
    assert {row["segment"] for row in result["ledger"] if row["disposition"] == "other"} == {
        "p1_s0", "p1_s3", "p2_s0", "p3_s0", "p3_s2"}
    assert_accounted(source, {"discovery": result})


def test_discovery_windows_group_a_cut_by_its_columns_and_a_native_page_whole():
    passages = [replace(passage("p1_s0", "a"), crop=1), replace(passage("p1_s1", "b"), crop=1),
                replace(passage("p1_s2", "c"), crop=2), passage("p2_s0", "d"), passage("p2_s1", "e")]
    units = discovery.units_of(passages)

    def groups(by):
        return [[unit.segment for unit in group] for group in discovery.groups_of(units, passages, by)]
    assert groups("column") == [["p1_s0", "p1_s1"], ["p1_s2"], ["p2_s0", "p2_s1"]]
    assert groups("page") == [["p1_s0", "p1_s1", "p1_s2"], ["p2_s0", "p2_s1"]]
    assert groups("budget") == [["p1_s0", "p1_s1", "p1_s2", "p2_s0", "p2_s1"]]


def test_version_2_discovery_windows_never_cross_a_printed_page_but_show_its_neighbours():
    """Each page is its own discovery window, its neighbours' lines its context; a record continued over a page still
    joins, both windows saying so."""
    source = evidence("1. Adorf. Material: Holz.\n2. Bdorf.", "Material: Stein.\n3. Cdorf. Material: Glas.")
    result, chat = extract(source, defaults=2)
    asked = {section(call["user"], "WINDOW"): section(call["user"], "CONTEXT AFTER") for call in chat.calls
             if call["system"].startswith("You find where records begin")}
    assert asked == {"[L1] 1. Adorf. Material: Holz.\n[L2] 2. Bdorf.": "Material: Stein.\n3. Cdorf. Material: Glas.",
                     "[L1] Material: Stein.\n[L2] 3. Cdorf. Material: Glas.": ""}
    assert [record["material"] for record in result["records"]] == ["Holz", "Stein", "Glas"]
    assert result["execution"]["effective"]["windows"] == "page" and result["execution"]["effective"]["overlap"] == 3
    assert "windows" not in extract(source)[0]["execution"]["effective"]  # version 1's records are unchanged


def test_once_a_slice_of_discovery_windows_raises_no_later_window_is_asked_and_the_first_is_raised():
    """A durable planning round yields at most `workers` discovery calls, as the entry pool does."""
    class Yielded(BaseException):
        pass
    asked = []

    def ask(record, system, user, schema, calls, issues):
        asked.append(section(user, "WINDOW"))
        raise Yielded(section(user, "WINDOW"))
    with pytest.raises(Yielded) as raised:
        discovery.discover(evidence(*(f"{n}. Ort{n}." for n in range(1, 9))), "entry", lambda *_: True, ask,
                           overlap=0, splits=6, by="page", workers=2)
    assert sorted(asked) == ["[L1] 1. Ort1.", "[L1] 2. Ort2."]  # the first slice of `workers` windows, nothing after
    assert raised.value.args == ("[L1] 1. Ort1.",)


def test_discovery_asks_for_places_as_one_line_line_ids_and_reads_them():
    """A place is its line's id, kind and label on one line; start text is copied only for a place inside a line."""
    source = evidence("Kreis Nord\n1. Adorf. Material: Holz. 2. Bdorf. Material: Stein.")

    def compact(user):
        return {"places": [["L1", "other", None], ["L2", "record", "1."], ["L2", "record", "2.", "2. Bdorf"]],
                "begins_inside_record": False, "ends_inside_record": False}
    result, chat = extract(source, Model(source, discovery=compact))
    asked = next(call for call in chat.calls if call["system"].startswith("You find where records begin"))
    assert "on one line, without indentation" in asked["system"]
    place = asked["schema"]["properties"]["places"]["items"]
    assert [item.get("enum") for item in place["prefixItems"]] == [["L1", "L2"], ["record", "other"], None, None]
    assert (place["minItems"], place["maxItems"]) == (3, 4)
    assert [(entry["label"], text(source, {**entry["ranges"][0]})) for entry in result["discovery"]["entries"]] == \
        [("1.", "1. Adorf. Material: Holz."), ("2.", "2. Bdorf. Material: Stein.")]
    assert result["prompt_version"] == 3
    assert_accounted(source, result)


def test_a_boundary_text_that_is_not_unique_in_its_line_stays_unresolved():
    source = evidence("1. Ort. Teil A. 2. Ort. Teil B.")

    def repeated(user):
        return {"places": [["L1", "record", None, "Ort."]],
                "begins_inside_record": False, "ends_inside_record": False}
    result, _ = extract(source, Model(source, discovery=repeated))
    assert result["records"] == [] and ranges(result, "unresolved") == [("p1_s0", 0, 31)]
    assert any(issue["code"] == "boundary_unplaced" for issue in result["issues"])


def test_restarted_labels_stay_distinct_and_an_entry_continues_across_pages():
    source = evidence("Kreis Nord\n1. Adorf. Material: Holz.\n2. Bdorf. Material: Stein, und", "weiter Glas.\n"
                      "Kreis Süd\n1. Cdorf. Material: Gold.")
    result, _ = extract(source)
    entries = result["discovery"]["entries"]
    assert [entry["label"] for entry in entries] == ["1.", "2.", "1."] and len({entry["id"] for entry in entries}) == 3
    assert [row["segment"] for row in entries[1]["ranges"]] == ["p1_s0", "p2_s0"]  # the entry crosses the page
    assert text(source, entries[1]["ranges"][1]) == "weiter Glas." and entries[1]["end"] == "validated"
    assert_accounted(source, result)


def test_all_discovery_windows_failing_leaves_everything_unresolved_and_no_record():
    source = evidence("1. Adorf. Material: Holz.\n2. Bdorf. Material: Stein.")
    result, _ = extract(source, Model(source, discovery=lambda user: Reply("{", 5, 4096, "length", 0.0)))
    assert result["records"] == [] and ranges(result, "unresolved") == [("p1_s0", 0, len(source.passages[0].text))]
    assert result["processing"]["discovery"]["failed"] >= 1 and result["complete"] is False
    assert_accounted(source, result)


def test_withheld_source_and_reading_order_issues_stay_visible():
    source = replace(evidence("1. Ort. Material: Holz."),
                     withheld=(passage("p1_s1", "unreadable scan", status="failed"),),
                     order_issues=("p1_s2 follows p1_s1",))
    result, _ = extract(source)
    assert ranges(result, "withheld") == [("p1_s1", 0, 15)]
    assert any(issue["code"] == "reading_order" for issue in result["issues"])
    assert_accounted(source, result)


def test_no_records_is_an_honest_empty_result():
    source = evidence("Vorwort. Keine Einträge.")
    result, chat = extract(source)
    assert result["records"] == [] and ranges(result, "other") == [("p1_s0", 0, 24)]
    assert [call["stage"] for call in result["calls"]] == ["discovery", "document"]
    assert result["complete"] is True


# --- complete windows ----------------------------------------------------------------------------------------------

def test_a_value_only_past_24000_characters_is_read_and_located_exactly():
    body = " ".join(["Beschreibung"] * 2_200)
    source = evidence(f"1. Adorf. {body}\nMaterial: Bernstein.")
    result, chat = extract(source, input_tokens=900, output_tokens=64)
    assert len(source.passages[0].text) > 24_000
    assert result["records"][0]["material"] == "Bernstein"
    (link,) = [link for link in result["evidence"] if link["path"] == ["records", 0, "material"]]
    assert text(source, link["spans"][0]) == "Bernstein" and link["support"] == "literal"
    assert result["processing"]["entries"]["windows"] > 1 and result["complete"] is True


def test_an_oversized_single_line_is_cut_at_its_own_offsets():
    body = "x" * 12_000
    source = evidence(f"1. Adorf. Material: Blei. {body}")
    result, _ = extract(source, input_tokens=600, output_tokens=64)
    assert result["records"][0]["material"] == "Blei"
    assert_accounted(source, result)
    assert result["processing"]["discovery"]["failed"] == 0


def test_a_table_cell_value_keeps_its_cell_geometry():
    row = "1. Adorf | Material: Zinn"
    table = PageTable(rows=1, columns=2, producer="docling", cells=[
        TableCell(cell_id="r0_c0", row=0, column=0, rowspan=1, colspan=1, role=None, text="1. Adorf", start=0, end=8,
                  bbox_pt=(0.0, 0.0, 1.0, 1.0)),
        TableCell(cell_id="r0_c1", row=0, column=1, rowspan=1, colspan=1, role=None, text="Material: Zinn", start=11,
                  end=25, bbox_pt=(1.0, 0.0, 2.0, 1.0))])
    source = replace(evidence(row), passages=(passage("p1_s0", row, label="Table", table=table),))
    result, _ = extract(source)
    (link,) = [link for link in result["evidence"] if link["path"] == ["records", 0, "material"]]
    assert link["cell"] == "r0_c1" and link["precision"] == "cell"


def test_a_cut_off_entry_reply_is_retried_on_halves_of_the_entry():
    source = evidence("1. Adorf.\n" + "\n".join(f"Find: F{n} ({n})." for n in range(1, 7)))
    model = Model(source)

    def crowded(system, user, schema):
        if system.startswith("You extract structured data") and section(user, "RECORD").count("Find:") > 3:
            return Reply('{"finds": [', 50, 4096, "length", 0.0)  # a list too long for its reply reserve
        return model(system, user, schema)
    result, _ = extract(source, crowded, overlap=0)
    assert any(call["stage"] == "entry" and not call["ok"] for call in result["calls"])
    assert result["processing"]["entries"]["failed"] == 0
    seen = {item["name"] for item in result["records"][0]["finds"] or []} | {
        item["value"] for item in result["proposed"] if item["path"][-1] == "name"}
    assert seen == {f"F{n}" for n in range(1, 7)}  # every item was read; none was dropped for the cut-off reply


def test_heading_context_that_does_not_fit_is_left_out_and_reported():
    heading = "Kreis " + " ".join(["Beschreibung"] * 500)
    source = evidence(f"{heading}\n1. Adorf. Material: Holz.")
    result, chat = extract(source, input_tokens=600, output_tokens=64)
    assert result["records"][0]["material"] == "Holz"
    omitted = [row for row in result["context_omitted"] if row["stage"] == "entry"]
    assert omitted and {row["kind"] for row in omitted} == {"heading"} and omitted[0]["record"] == 0
    assert not any("Beschreibung" in call["user"] for call in chat.calls if call["system"].startswith("You extract structured"))


def table_passage(rows: list[list[str]]) -> Passage:
    """A table whose rows are lines and whose cells are separated by " | ", every cell with its own box."""
    lines, cells, offset = [], [], 0
    for row, values in enumerate(rows):
        for column, value in enumerate(values):
            cells.append(TableCell(cell_id=f"r{row}_c{column}", row=row, column=column, rowspan=1, colspan=1, role=None,
                                   text=value, start=offset, end=offset + len(value),
                                   bbox_pt=(float(column), float(row), column + 1.0, row + 1.0)))
            offset += len(value) + 3
        offset += 1 - 3
        lines.append(" | ".join(values))
    text = "\n".join(lines)
    table = PageTable(rows=len(rows), columns=max(map(len, rows)), producer="docling", cells=cells)
    return passage("p1_s0", text, label="Table", table=table)


def test_a_dense_table_gives_one_entry_per_row_and_each_value_its_own_cell():
    table = table_passage([[f"{n}. Ort{n}", f"Material: M{n}"] for n in range(1, 6)])
    source = replace(evidence(table.text), passages=(table,))
    result, _ = extract(source)
    assert [record["material"] for record in result["records"]] == [f"M{n}" for n in range(1, 6)]
    cells = [link["cell"] for link in result["evidence"] if link["path"][2] == "material"]
    assert cells == [f"r{n}_c1" for n in range(5)] and all(
        link["precision"] == "cell" for link in result["evidence"] if link["path"][2] == "material")
    assert_accounted(source, result)


def test_a_value_in_the_quoted_table_row_is_literal_in_its_own_cell():
    """A model quoting a row's key cell ("2.") for a value printed in another cell of that row: the value is located
    in its own cell of the same row. A value printed only in another row stays refused."""
    table = table_passage([[f"{n}.", f"Ort{n}", f"Material: M{n}"] for n in range(1, 4)])
    source = replace(evidence(table.text), passages=(table,))

    def keyed(record: str, user: str, schema: dict) -> dict:
        answer = fields(record, user, schema)
        number = START.match(record)[1]
        site = re.search(r"Ort(\d)", record)
        answer["site"] = candidate(f"Ort{site[1]}", number)
        answer["material"] = candidate("M9" if number == "3." else f"M{site[1]}", number)
        return answer
    result, _ = extract(source, Model(source, entry=keyed))
    assert [record["site"] for record in result["records"]] == ["Ort1", "Ort2", "Ort3"]
    assert [record["material"] for record in result["records"]] == ["M1", "M2", None]
    sites = [link for link in result["evidence"] if link["path"][2] == "site"]
    assert [link["cell"] for link in sites] == ["r0_c1", "r1_c1", "r2_c1"] and all(link["verbatim"] for link in sites)
    assert [row["reason"] for row in result["rejected"] if row["path"][2] == "material"] == ["value_not_in_quote"]


def printed_table(lines: list[list[tuple[str, int, int, int]]]) -> Passage:
    """A table printed line by line, cells separated by " | ": each cell (text, row, column, rowspan) where printed."""
    cells, texts, offset = [], [], 0
    for printed in lines:
        for text, row, column, rowspan in printed:
            cells.append(TableCell(cell_id=f"r{row}_c{column}", row=row, column=column, rowspan=rowspan, colspan=1,
                                   role=None, text=text, start=offset, end=offset + len(text),
                                   bbox_pt=(float(column), float(row), column + 1.0, row + rowspan + 0.0)))
            offset += len(text) + 3
        offset += 1 - 3
        texts.append(" | ".join(each[0] for each in printed))
    table = PageTable(rows=max(cell.row + cell.rowspan for cell in cells), columns=3, producer="docling", cells=cells)
    return passage("p1_s0", "\n".join(texts), label="Table", table=table)


def keyed_to(site: tuple[str, str], material: tuple[str, str]):
    def answer(record: str, user: str, schema: dict) -> dict:
        return {**fields(record, user, schema), "site": candidate(*site), "material": candidate(*material)}
    return answer


def test_a_merged_cell_never_widens_the_quoted_row_to_the_rows_it_spans():
    """Row 2's cells are the merged first cell and its own two: a value printed only in row 0 is not in row 2, even
    though the merged cell lies in row 0's line. The merged cell's own value is in every row it spans."""
    table = printed_table([[("1. Adorf", 0, 0, 3), ("Fund: A", 0, 1, 1), ("Material: Holz", 0, 2, 1)],
                           [("Fund: B", 1, 1, 1), ("Material: Stein", 1, 2, 1)],
                           [("Fund: C", 2, 1, 1), ("Material: Zinn", 2, 2, 1)]])
    source = replace(evidence(table.text), passages=(table,))
    result, _ = extract(source, Model(source, entry=keyed_to(("Adorf", "Fund: C"), ("Holz", "Fund: C"))))
    assert len(result["records"]) == 1 and result["records"][0]["material"] is None
    assert [row["reason"] for row in result["rejected"] if row["path"][2] == "material"] == ["value_not_in_quote"]
    (site,) = [link for link in result["evidence"] if link["path"][2] == "site"]
    assert (result["records"][0]["site"], site["cell"], site["verbatim"]) == ("Adorf", "r0_c0", True)


def test_the_row_rule_applies_only_to_a_quote_found_in_one_place():
    """A quote printed in two rows names no one row, so a value printed in either is not literal through it."""
    table = printed_table([[("1. Adorf", 0, 0, 1), ("Typ A", 0, 1, 1), ("Material: Holz", 0, 2, 1)],
                           [("Teil", 1, 0, 1), ("Typ A", 1, 1, 1), ("Material: Stein", 1, 2, 1)]])
    source = replace(evidence(table.text), passages=(table,))
    result, _ = extract(source, Model(source, entry=keyed_to(("Adorf", "Adorf"), ("Holz", "Typ A"))))
    assert len(result["records"]) == 1 and result["records"][0]["material"] is None
    assert [row["reason"] for row in result["rejected"] if row["path"][2] == "material"] == ["value_not_in_quote"]


def test_a_cell_larger_than_any_window_keeps_its_cell_after_the_cut():
    table = table_passage([["1. Adorf", "Beschreibung " * 900 + "Material: Zinn"]])
    source = replace(evidence(table.text), passages=(table,))
    result, _ = extract(source, input_tokens=600, output_tokens=64)
    assert result["processing"]["entries"]["windows"] > 1
    (link,) = [link for link in result["evidence"] if link["path"][2] == "material"]
    assert (link["cell"], link["precision"], link["raw"]) == ("r0_c1", "cell", "Zinn")
    assert_accounted(source, result)


def test_an_unfittable_minimum_request_is_refused():
    source = evidence("1. Adorf. Material: Blei.")
    with pytest.raises(unified.BudgetRefused, match="discovery"):
        extract(source, input_tokens=512, output_tokens=64, schema={**SCHEMA, "recordDescription": "x " * 499})


def test_an_input_ceiling_beyond_the_served_context_is_refused_not_clamped():
    with pytest.raises(unified.BudgetRefused, match="exceed"):
        extract(evidence("1. Adorf."), input_tokens=16_384, output_tokens=64)


# --- evidence --------------------------------------------------------------------------------------------------------

def test_a_value_quoted_from_a_neighbouring_record_is_rejected():
    source = evidence("1. Adorf. Material: Holz.\n2. Bdorf. Material: Stein.")

    def neighbour(record, user, schema):
        answer = fields(record, user, schema)
        if record.startswith("2."):
            answer["material"] = candidate("Holz", "Material: Holz")
        return answer
    result, _ = extract(source, Model(source, entry=neighbour))
    assert result["records"][1]["material"] is None
    (rejected,) = [item for item in result["rejected"] if item["path"] == ["records", 1, "material"]]
    assert rejected["reason"] == "quote_not_in_source"


def test_a_yes_no_value_has_a_supporting_passage_never_a_literal_span():
    source = evidence("1. Adorf. Material: Gold. Gilded.")
    result, _ = extract(source)
    (link,) = [link for link in result["evidence"] if link["path"] == ["records", 0, "gilded"]]
    assert link["support"] == "supporting" and link["verbatim"] is False and link["raw"] == "Gilded"


def test_verification_decides_acceptance_and_off_leaves_proposals():
    source = evidence("1. Adorf. Material: Holz.")

    def verdict(path, value, record):
        return "unsupported" if path == "site" else "unclear" if path == "label" else "supported"
    result, _ = extract(source, Model(source, verdict=verdict))
    assert result["records"][0]["material"] == "Holz" and result["records"][0]["site"] is None
    assert [(item["path"], item["reason"]) for item in result["rejected"]] == [
        (["records", 0, "site"], "verification_rejected")]
    assert [(item["path"], item["reason"]) for item in result["proposed"]] == [
        (["records", 0, "label"], "verification_unclear")]
    off, chat = extract(source, verification=False)
    assert all(value is None for value in off["records"][0].values() if value != "catalogue.pdf")
    assert {item["reason"] for item in off["proposed"]} == {"verification_disabled"}
    assert not any(call["stage"] == "verification" for call in off["calls"]) and off["proposed"][0]["spans"]


def test_candidates_are_verified_in_counted_batches_halved_on_overflow():
    source = evidence("1. Adorf. Material: Holz. Find: Nadel (2). Find: Fibel (1). Gilded.")
    model = Model(source)

    def fussy(system, user, schema):
        if system.startswith("You check values") and len(schema["properties"]) > 2:
            return Reply("{", 10, 64, "length", 0.0)
        return model(system, user, schema)
    result, _ = extract(source, fussy)
    verification = [call for call in result["calls"] if call["stage"] == "verification"]
    assert any(not call["ok"] for call in verification) and result["records"][0]["finds"] == [
        {"name": "Nadel", "count": 2}, {"name": "Fibel", "count": 1}]
    assert result["processing"]["verification"]["undecided"] == 0


def test_evidence_eligibility_does_not_depend_on_field_names():
    source = evidence("1. Adorf. Material: Holz.")
    renamed = {**SCHEMA, "schemaNodes": [{**node, "name": f"x_{node['name']}"} for node in SCHEMA["schemaNodes"]]}

    def entry(record, user, schema):
        return {f"x_{name}": value for name, value in fields(record, user, {"properties": {
            name.removeprefix("x_"): None for name in schema["properties"]}}).items()}
    original, _ = extract(source)
    result, _ = extract(source, Model(source, entry=entry, document=lambda s: {"x_title": None}), schema=renamed)
    assert [link["spans"] for link in result["evidence"]] == [link["spans"] for link in original["evidence"]]
    assert result["records"][0]["x_material"] == "Holz"


def test_disagreeing_values_are_arbitrated_or_left_unresolved():
    lines = "1. Adorf. Material: Holz. " + " ".join(["Text"] * 700) + " Material: Stein."
    source = evidence(lines)

    def entry(record, user, schema):
        answer = fields(record, user, schema)
        if material := re.findall(r"Material: (\w+)", record):
            answer["material"] = candidate(material[-1], f"Material: {material[-1]}")
        return answer
    chosen, _ = extract(source, Model(source, entry=entry, choice="C2"), input_tokens=520, output_tokens=64)
    assert chosen["records"][0]["material"] == "Stein" and chosen["competitors"][0]["outcome"] == "arbitrated"
    undecided, _ = extract(source, Model(source, entry=entry, choice="NONE"), input_tokens=520, output_tokens=64)
    assert undecided["records"][0]["material"] is None
    contest = undecided["competitors"][0]
    assert contest["outcome"] == "unresolved" and {c["value"] for c in contest["candidates"]} == {"Holz", "Stein"}
    assert undecided["complete"] is False


# --- lists ---------------------------------------------------------------------------------------------------------

def test_an_item_seen_whole_by_two_windows_under_overlap_is_one_item():
    source = evidence("1. Adorf.\n" + "\n".join(f"Find: F{n} ({n}). " + "filler " * 60 for n in range(1, 7)))
    result, _ = extract(source, input_tokens=520, output_tokens=64, overlap=1)
    assert result["processing"]["entries"]["windows"] >= 2
    assert result["records"][0]["finds"] == [{"name": f"F{n}", "count": n} for n in range(1, 7)]
    (counts,) = result["items"]
    assert counts["observed"] > counts["resolved"] == 6 and counts["partial"] == 0


def test_without_overlap_an_item_at_a_cut_stays_a_partial_proposal():
    source = evidence("1. Adorf.\n" + "\n".join(f"Find: F{n} ({n}). " + "filler " * 60 for n in range(1, 7)))
    result, _ = extract(source, input_tokens=520, output_tokens=64, overlap=0)
    (counts,) = result["items"]
    placed = [item["name"] for item in result["records"][0]["finds"]]
    partial = sorted({item["value"] for item in result["proposed"] if item["reason"] == "partial_item"
                      and item["path"][-1] == "name"})
    assert counts["observed"] == 6 and counts["partial"] == len(partial) > 0
    assert sorted(placed + partial) == [f"F{n}" for n in range(1, 7)]
    assert all(item["path"][3] is None and item["item"] is not None for item in result["proposed"]
               if item["reason"] == "partial_item")
    assert result["completeness"]["evidence"] is False


def _observation(window: int, index: int, anchor, *leaves) -> list:
    """One observed list item: its leaves (name, value, span) at `finds[index]` of `window`."""
    return [unified._Found(("finds", index, name), value, value, window,
                           spans=[unified.Span(segment_id="p1_s0", start=start, end=start + 4)], support="literal",
                           item=(("finds",), window, index), anchor=anchor) for name, value, start in leaves]


def merged(*observations, edges=None):
    issues = []
    view = unified._view([unified.Unit("p1_s0", 0, 400)], {"p1_s0": "x" * 400})
    found, counts = unified._merged([leaf for each in observations for leaf in each], view, edges or {}, issues, 0)
    return found, counts[0], issues


def test_equal_items_merge_only_with_one_located_occurrence_in_distinct_windows():
    anchor = (("p1_s0", 10, 30),)
    found, counts, issues = merged(_observation(0, 0, anchor, ("name", "Nadel", 10)),
                                   _observation(1, 0, anchor, ("name", "Nadel", 10)))
    assert (counts["observed"], counts["resolved"], counts["partial"]) == (2, 1, 0) and not issues
    assert [leaf.path for leaf in found] == [("finds", 0, "name")]
    found, counts, issues = merged(_observation(0, 0, None, ("name", "Nadel", 10)),
                                   _observation(1, 0, None, ("name", "Nadel", 10)))
    assert counts["resolved"] == 2 and issues[0].code == "item_identity_ambiguous"  # kept apart, and said so


def test_items_sharing_a_heading_or_first_leaf_span_stay_distinct():
    shared = ("name", "Nadel", 10)  # both items quote one inherited name
    found, counts, issues = merged(_observation(0, 0, (("p1_s0", 40, 50),), shared, ("count", 2, 60)),
                                   _observation(0, 1, (("p1_s0", 70, 80),), shared, ("count", 3, 90)))
    assert counts["resolved"] == 2 and not issues
    assert sorted(leaf.path for leaf in found) == [("finds", 0, "count"), ("finds", 0, "name"),
                                                   ("finds", 1, "count"), ("finds", 1, "name")]


def test_one_windows_identical_items_are_both_kept_and_flagged():
    anchor = (("p1_s0", 10, 30),)
    _, counts, issues = merged(_observation(0, 0, anchor, ("name", "Nadel", 10)),
                               _observation(0, 1, anchor, ("name", "Nadel", 10)))
    assert counts["resolved"] == 2 and [issue.code for issue in issues] == ["item_identity_ambiguous"]


def test_an_item_whose_values_were_all_refused_leaves_no_gap_in_the_list():
    source = evidence("1. Adorf. Find: Nadel (2). Find: Fibel (1). Find: Perle (3).")

    def verdict(path, value, record):
        return "unsupported" if value in ("Nadel", 2) else "supported"
    result, _ = extract(source, Model(source, verdict=verdict))
    assert result["records"][0]["finds"] == [{"name": "Fibel", "count": 1}, {"name": "Perle", "count": 3}]
    assert sorted(link["path"][3] for link in result["evidence"] if link["path"][2] == "finds") == [0, 0, 1, 1]
    assert {tuple(item["path"]) for item in result["rejected"]} == {
        ("records", 0, "finds", None, "name"), ("records", 0, "finds", None, "count")}


def test_complementary_halves_at_a_cut_are_never_joined():
    edges = {0: [unified.Unit("p1_s0", 100, 200)], 1: [unified.Unit("p1_s0", 100, 200)]}
    found, counts, _ = merged(_observation(0, 3, None, ("name", "Nadel", 150)),
                              _observation(1, 0, None, ("count", 2, 160)), edges=edges)
    assert (counts["observed"], counts["resolved"], counts["partial"]) == (2, 0, 2)
    assert {(leaf.path, leaf.kind, leaf.reason) for leaf in found} == {
        (("finds", None, "name"), "proposed", "partial_item"), (("finds", None, "count"), "proposed", "partial_item")}


# --- document fields -----------------------------------------------------------------------------------------------

def test_late_document_fields_are_read_from_their_own_windows_and_stay_unverified():
    source = evidence("Vorwort. " + " ".join(["Einleitung"] * 700), "1. Adorf. Material: Holz.",
                      "Index. Title: Fundkatalog Nord.")
    result, _ = extract(source, input_tokens=520, output_tokens=64)
    assert result["processing"]["document"]["windows"] > 1
    assert result["records"][0]["title"] == "Fundkatalog Nord"
    assert result["unverified"] == ["title"] and result["document"]["status"] == "unverified"
    (found,) = [item for item in result["document"]["candidates"] if item["path"] == ["title"]]
    assert found["reason"] == "document_unverified" and found["raw"] == "Fundkatalog Nord"


def test_conflicting_document_values_are_kept_and_not_chosen():
    source = evidence("Title: Erster.", " ".join(["Text"] * 700), "Title: Zweiter.")
    result, _ = extract(source, input_tokens=520, output_tokens=64)
    assert result["records"] == [] and result["document"]["conflicts"] == [
        {"path": ["title"], "candidates": ["Erster", "Zweiter"]}]


def test_a_failed_document_window_is_not_hidden_by_successful_entries():
    source = evidence("1. Adorf. Material: Holz.")
    model = Model(source)

    def failing(system, user, schema):
        if system.startswith("You extract fields that describe"):
            return Reply("{", 10, 2048, "length", 0.0)
        return model(system, user, schema)
    result, _ = extract(source, failing)
    assert result["records"][0]["material"] == "Holz"
    assert result["processing"]["document"]["failed"] == 1 and result["complete"] is False


# --- failed calls --------------------------------------------------------------------------------------------------

def server_error(status: int) -> requests.HTTPError:
    response = requests.Response()
    response.status_code = status
    return requests.HTTPError(f"{status} Server Error", response=response)


def test_a_server_error_on_one_entry_is_contained_in_that_entry():
    source = evidence("1. Adorf. Material: Holz.\n2. Bdorf. Bericht.\nMaterial: Stein.\nFind: Nadel (2).\n"
                      "3. Cdorf. Material: Gold.")
    model = Model(source)

    def failing(system, user, schema):
        if system.startswith(("You extract structured data", "You check values")) and \
                re.search(r"Bdorf|Bericht|Stein|Nadel", section(user, "RECORD")):
            raise server_error(500)  # the server fails on this entry's requests, every half of them too
        return model(system, user, schema)
    result, _ = extract(source, failing)
    assert [record["material"] for record in result["records"]] == ["Holz", None, "Gold"]
    assert result["processing"]["entries"]["failed"] > 0 and result["complete"] is False
    failed = [call for call in result["calls"] if call["stage"] == "entry" and not call["ok"]]
    assert len(failed) > 1 and all(call["record"] == 1 and call["error"] == "HTTPError: HTTP 500" for call in failed)
    assert all(call["input_tokens"] is None and call["output_tokens"] is None for call in failed)
    codes = {(issue["code"], issue["record"]) for issue in result["issues"]}
    assert {("call_failed", 1), ("entry_window_failed", 1)} <= codes


def test_a_transient_backend_error_ends_the_extraction_for_the_step_retry():
    source = evidence("1. Adorf. Material: Holz.\n2. Bdorf. Material: Stein.")
    model = Model(source)

    def unreachable(system, user, schema):
        if system.startswith("You extract structured data") and "Bdorf" in section(user, "RECORD"):
            raise requests.ConnectionError("connection refused")
        return model(system, user, schema)
    with pytest.raises(requests.ConnectionError):
        extract(source, unreachable)
    for status in (429, 502, 503, 504):
        def not_ready(system, user, schema, status=status):
            if system.startswith("You extract structured data"):
                raise server_error(status)  # the server is not ready rather than refusing this request
            return model(system, user, schema)
        with pytest.raises(requests.HTTPError):
            extract(source, not_ready)


# --- options, records and recovery ---------------------------------------------------------------------------------

def test_unified_options_refuse_legacy_limits_and_record_no_character_limits():
    with pytest.raises(ValueError, match="character limits"):
        run.ExtractRequest.model_validate({"schema": SCHEMA, "options": {
            "strategy": "catalog", "record_chars": 24_000, "unified": {"defaults": 1}}})
    with pytest.raises(ValueError, match="recipe"):
        run.ExtractRequest.model_validate({"schema": SCHEMA, "options": {
            "strategy": "catalog", "catalog": {"recipe": "numbered-catalogue-de@1"}, "unified": {"defaults": 1}}})
    assert request(overlap=0).options.dumped() == {"strategy": "catalog", "models": None,
                                                   "unified": {"defaults": 1, "overlap": 0}}


def test_a_start_page_is_a_strict_one_based_integer_that_the_artifact_never_records():
    """The start page orders the work (service README, start_page); the artifact and its fingerprint are those of the
    request without it."""
    with_page = run.Options.model_validate({"strategy": "catalog", "unified": {"defaults": 1}, "start_page": 6})
    assert with_page.start_page == 6
    assert "start_page" not in with_page.dumped()
    assert with_page.dumped() == run.Options.model_validate({"strategy": "catalog", "unified": {"defaults": 1}}).dumped()
    assert run.Options.model_validate({"strategy": "article", "start_page": 400}).start_page == 400  # beyond the document: an order from its end
    for refused in (0, -1, "6", 6.0, True):  # strict, as UnifiedOptions is: a page is an integer, never coerced
        with pytest.raises(ValidationError):
            run.Options.model_validate({"strategy": "article", "start_page": refused})


def untimed(result: dict) -> str:
    calls = [{key: value for key, value in call.items() if key != "seconds"} for call in result["calls"]]
    rest = {key: value for key, value in result.items() if key not in ("started", "seconds", "calls")}
    return json.dumps({**rest, "calls": calls}, ensure_ascii=False, indent=2)


def test_entries_are_read_nearest_the_start_page_first_and_assembled_in_source_order():
    source = evidence("1. Adorf. Material: Holz.", "2. Bdorf. Material: Stein.", "3. Cdorf. Material: Gold.")
    plain, _ = extract(source)
    ordered, chat = extract(source, start_page=3)
    asked = [section(call["user"], "RECORD")[:8] for call in chat.calls
             if call["system"].startswith("You extract structured data")]
    assert asked == ["3. Cdorf", "2. Bdorf", "1. Adorf"]  # distance from page 3, then source order
    assert [record["label"] for record in ordered["records"]] == ["1", "2", "3"]  # assembled in source order
    assert untimed(ordered) == untimed(plain)  # the same artifact, whatever the order of work
    assert unified.work_order([{"ranges": [{"segment": "p1_s0"}]}, {"ranges": [{"segment": "p3_s0"}]},
                               {"ranges": [{"segment": "p2_s0"}]}, {"ranges": []}],
                              {"p1_s0": 1, "p2_s0": 2, "p3_s0": 3}, 2) == [2, 0, 1, 3]  # unknown page last
    assert unified.work_order([{"ranges": [{"segment": "p3_s0"}]}, {"ranges": [{"segment": "p1_s0"}]}],
                              {"p1_s0": 1, "p3_s0": 3}, None) == [0, 1]  # no start page: source order


def test_a_persistent_server_error_ends_with_its_entry_failed_and_visible():
    source = evidence("1. Adorf. Material: Holz.\n2. Bdorf. Material: Stein.")
    model = Model(source)

    def refusing(system, user, schema):
        if system.startswith("You extract structured data") and "Bdorf" in section(user, "RECORD"):
            raise server_error(500)
        return model(system, user, schema)
    for _ in range(2):  # each execution returns; nothing loops waiting for the entry to succeed
        result, _ = extract(source, refusing)
        assert [record["material"] for record in result["records"]] == ["Holz", None]
        assert result["processing"]["entries"]["failed"] == 1 and result["complete"] is False
        assert ("entry_window_failed", 1) in {(issue["code"], issue["record"]) for issue in result["issues"]}


def test_entries_run_concurrently_assemble_in_source_order():
    source = evidence("\n".join(f"{n}. Ort{n}. Material: M{n}." for n in range(1, 9)))
    chat = CountingChat(Model(source))
    result = unified.extract(None, source, request(), as_router(chat), counter=WordCounter(), chunks=4)
    assert [record["material"] for record in result["records"]] == [f"M{n}" for n in range(1, 9)]


def test_cancellation_is_observed_before_each_call():
    source = evidence("1. Adorf. Material: Holz.\n2. Bdorf. Material: Stein.")
    checks = []

    def check():
        checks.append(1)
        if len(checks) > 3:
            raise KeyboardInterrupt  # stands in for the worker's cancellation
    with pytest.raises(KeyboardInterrupt):
        unified.extract(None, source, request(), as_router(CountingChat(Model(source))), counter=WordCounter(),
                        before_entry=check)
    assert len(checks) == 4


def test_the_unified_modules_know_no_recipe():
    for module in (unified, discovery):
        imported = {line.split()[1] for line in open(module.__file__, encoding="utf-8")
                    if line.startswith(("import ", "from "))}
        assert not imported & {"kei_exp.kie.recipe", "kei_exp.kie.segmentation", "kei_exp.kie.segmentation_run",
                               "kei_exp.kie.extract.grounded", "kei_exp.kie.extract.catalog"}


# --- the cross-language contract ------------------------------------------------------------------------------------

def test_the_version_3_contract_fixture_is_what_the_service_produces(tmp_path, monkeypatch):
    """A unified artifact over a written canonical result, with the manifest and page files it was read from, so
    digests over non-ASCII text and evidence anchors stay pinned. Set `FREE_UPDATE_GOLDEN=1` to rewrite it after a
    reviewed contract change."""
    case = {"transcriber": "native", "source_name": "katalog.pdf", "pages": [{"page": 1, "units": [{"index": 0, "segments": [
        "Vorwort: Funde aus Schäfers Grabung. Title: Fundkatalog Süd.", "12. Adorf. Material: Bronze. Find: Nadel (2).",
        "第3号 北京出土 Material: Jade. Gilded."]}]}]}
    run_dir = catalogue.write(case, tmp_path / "run-contract")
    monkeypatch.setattr(unified, "datetime", SimpleNamespace(now=lambda tz=None: datetime(2026, 9, 29, 12, tzinfo=UTC)))
    monkeypatch.setattr(unified, "time", SimpleNamespace(monotonic=lambda: 100.0))
    source = load(run_dir)
    scoped = {**SCHEMA, "recordScope": "records"}  # as Studio sends a revision's declared scope, echoed and digested
    produced = unified.extract(run_dir, source, request(scoped), as_router(CountingChat(Model(source))),
                               counter=WordCounter())
    assert produced["complete"] is True and len(produced["records"]) == 2
    assert produced["execution"]["extraction_id"] is None and not (run_dir / "extractions").exists()
    fixture = {"source": {"run_id": source.run_id, "generation": source.generation},
               "request": {"schema": scoped, "options": {"strategy": "catalog", "unified": {"defaults": 1}}},
               "manifest": json.loads((run_dir / "result" / "result.json").read_text(encoding="utf-8")),
               "pages": [json.loads((run_dir / "result" / "pages" / "1.json").read_text(encoding="utf-8"))],
               "artifact": produced}
    text = json.dumps(fixture, ensure_ascii=False, indent=2) + "\n"
    path = FIXTURES / "extract.result.v3.json"
    if os.environ.get("FREE_UPDATE_GOLDEN") == "1":
        path.write_text(text, encoding="utf-8")
    assert text == path.read_text(encoding="utf-8")


def test_the_defaults_and_option_bounds_match_the_shared_fixture():
    shared = json.loads((FIXTURES / "unified-catalog-options.json").read_text(encoding="utf-8"))
    assert {int(version): defaults for version, defaults in shared["defaults"].items()} == unified.DEFAULTS
    for options in shared["valid"]:
        assert unified.UnifiedOptions.model_validate(options).dumped() == options
    for options in shared["invalid"]:
        with pytest.raises(ValueError):
            unified.UnifiedOptions.model_validate(options)


def test_record_starts_name_the_segment_and_label_of_each_record_a_read_window_found():
    from kei_exp.kie.extract.discovery import Window, _Seen, record_starts
    from kei_exp.kie.extract.windows import Unit
    window = Window((Unit("p1_s0", 0, 10), Unit("p1_s1", 0, 8)))
    seen = [_Seen(window, True, [(0, 0, "record", "1"), (1, 3, "other", None), (1, 4, "record", None)]),
            _Seen(window, False, [])]
    assert record_starts(seen) == [{"segment": "p1_s0", "label": "1"}, {"segment": "p1_s1", "label": None}]

"""The experiment must reject counts that hide wrong, duplicate or unresolved record starts."""
import json
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from experiments.extraction.table_discovery import assemble, cases, score
from experiments.extraction.table_discovery_full import assess_records, capture_http


def entry(segment="L4", start=0, end=10, *, status="validated", parent=None):
    return {"id": f"{segment}@{start}", "ranges": [{"segment": segment, "start": start, "end": end}],
            "end": status, **({"parent": parent} if parent else {})}


def test_correct_count_with_wrong_boundary_fails():
    result = score([entry("L3"), entry("L5")], [entry("L4"), entry("L5")])
    assert not result["pass"]
    assert result["missing"] == ["L4@0"]
    assert result["extra"] == ["L3@0"]


def test_duplicate_start_does_not_replace_a_missing_record():
    result = score([entry(), entry()], [entry(), entry("L5")])
    assert not result["pass"]
    assert result["matched"] == 1


def test_unplaceable_boundary_or_unread_source_fails():
    assert not score([entry()], [entry()], ["boundary_unplaced"])["pass"]
    assert not score([entry()], [entry()], ledger=[{"disposition": "withheld"}])["pass"]


def test_equal_starts_do_not_hide_missing_text_or_parent_relationship():
    assert not score([entry(end=8)], [entry()])["pass"]
    assert not score([entry(parent="L2@0")], [entry()])["pass"]


def test_source_end_is_valid_only_when_reference_marks_an_excerpt():
    assert score([entry(status="source_end")], [entry(status="source_end")])["pass"]
    assert not score([entry(status="source_end")], [entry()])["pass"]


def test_exact_records_and_record_free_sources_pass():
    assert score([entry()], [entry()])["pass"]
    assert score([], [], ledger=[{"disposition": "other"}])["pass"]


def test_record_order_is_part_of_the_reference():
    assert not score([entry("L5"), entry()], [entry(), entry("L5")])["pass"]


CAPTURED = {"system": "A record is a site. BASELINE_SCOPE", "user":
            "### WINDOW\n[L1 table row] Site\tYear\n[L2 table row] Site A\t1800\n\nReturn JSON."}
SPAN = {"attributes": {"input.value": json.dumps(CAPTURED)}}


def test_capture_source_and_prompt_are_preserved_in_baseline():
    case = cases(SPAN, "{description}", "BASELINE_SCOPE", {"entries": [entry("L2", end=11)]})[0]
    assert case["system"] == CAPTURED["system"]
    assert case["user"] == CAPTURED["user"]


def test_a_different_deployed_scope_refuses_approximate_replay():
    with pytest.raises(ValueError):
        cases(SPAN, "{description}", "DIFFERENT_SCOPE", {"entries": [entry("L2", end=11)]})


@pytest.mark.parametrize("expected", [[entry("L3")], [entry("L2", start=-1)], [entry("L2", end=100)],
                                      [entry("L2"), entry("L2")], [entry("L2", status="unresolved")]])
def test_invalid_reference_cannot_silently_be_scored(expected):
    with pytest.raises(ValueError):
        cases(SPAN, "{description}", "BASELINE_SCOPE", {"entries": expected})


def test_unresolved_record_end_fails_even_with_no_unresolved_ledger_rows():
    case = {"name": "uncertain-end", "user": "[L1] Port A\n[L2] Region: West"}
    answer = {"places": [["L1", "record", None]], "begins_inside_record": False, "ends_inside_record": None}
    body = assemble(case, answer)
    assert all(r["disposition"] != "unresolved" for r in body["ledger"])
    expected = [{**entry("L1", end=6), "ranges": [
        {"segment": "L1", "start": 0, "end": 6}, {"segment": "L2", "start": 0, "end": 12}]}]
    assert not score(body["entries"], expected, body["issues"], body["ledger"])["pass"]


def test_missing_end_boundary_cannot_hide_footer_owned_by_last_record():
    case = {"name": "footer", "user": "[L1] Port A\n[L2] Port B\n[L3] Bibliography"}
    expected = [entry("L1", end=6), entry("L2", end=6)]
    answer = {"places": [["L1", "record", None], ["L2", "record", None], ["L3", "other", None]],
              "begins_inside_record": False, "ends_inside_record": False}
    body = assemble(case, answer)
    assert score(body["entries"], expected, body["issues"], body["ledger"])["pass"]
    answer["places"].pop()
    body = assemble(case, answer)
    result = score(body["entries"], expected, body["issues"], body["ledger"])
    assert not result["pass"]
    assert result["ownership_errors"] == ["L2@0"]


EXPECTED = entry("p1_s0", start=10, end=25)


@pytest.fixture
def reference():
    return {"entries": [EXPECTED], "records": [{"port": "Port A (Island)", "region": "West", "year": "1700"}]}


def full_result(record_entry, records):
    return {"discovery": {"entries": [record_entry], "ledger": [], "issues": []}, "records": records}


@pytest.mark.parametrize(("status", "stop"), [("unresolved", 25), ("validated", 100)])
def test_unresolved_or_extended_full_record_is_not_a_successful_assessment(reference, status, stop):
    result = full_result(entry("p1_s0", start=10, end=stop, status=status), reference["records"])
    assessment = assess_records(result, reference)
    assert not assessment["structure"]["pass"]
    assert assessment["field_result"] is None


def test_correct_values_at_wrong_canonical_boundaries_are_not_scored_as_correct_rows(reference):
    assessment = assess_records(full_result(entry("p1_s0", end=25), reference["records"]), reference)
    assert not assessment["structure"]["pass"]
    assert assessment["field_result"] is None


def test_correct_structure_does_not_hide_a_truncated_name_or_wrong_year(reference):
    result = full_result(EXPECTED, [{"port": "Port A", "region": "West", "year": None}])
    assessment = assess_records(result, reference)
    assert assessment["structure"]["pass"]
    assert assessment["field_result"]["rows_correct"] == 0
    assert assessment["field_result"]["cells_correct"] == 1


def test_string_comparison_does_not_strip_meaningful_punctuation(reference):
    reference["records"][0]["port"] = "Port A*"
    result = full_result(EXPECTED, [{"port": "Port A", "region": "West", "year": "1700"}])
    assert assess_records(result, reference)["field_result"]["cells_correct"] == 2


def test_field_errors_name_their_row_whatever_the_reference_fields():
    reference = {"entries": [EXPECTED], "records": [{"site": "Site A", "year": "1800"}]}
    errors = assess_records(full_result(EXPECTED, [{"site": "Site B", "year": "1800"}]), reference)[
        "field_result"]["errors"]
    assert errors == [{"row": 1, "fields": {"site": {"expected": "Site A", "actual": "Site B"}}}]


def test_capture_records_actual_fallback_attempts_without_headers_urls_or_error_bodies():
    import requests
    from kei_exp.kie.extract.llm import OpenAIChat
    chat = OpenAIChat(url='http://model.invalid/v1/chat/completions?key=PRIVATE', model='model',
                      headers={'Authorization': 'Bearer PRIVATE'})
    clients = SimpleNamespace(chats=lambda: {'fields': chat, 'reasoning': chat})
    def response(session, request, **kwargs):
        result = requests.Response()
        if 'response_format' in json.loads(request.body):
            result.status_code = 400
            result._content = b'response_format unsupported; PRIVATE'
        else:
            result.status_code = 200
            result._content = json.dumps({'choices': [{'message': {'content': '{}'}, 'finish_reason': 'stop'}],
                                         'usage': {'prompt_tokens': 10, 'completion_tokens': 2}}).encode()
        return result
    emitted = []
    with patch.object(requests.Session, 'send', response), capture_http(clients, emitted.append):
        reply = chat.complete(system='Read the source.', user='A value.', schema={'type': 'object'})
    assert reply.text == '{}'
    attempts = [i['capture'] for i in emitted]
    assert [a['status'] for a in attempts] == [400, 200]
    assert 'response_format' in attempts[0]['request']
    assert 'response_format' not in attempts[1]['request']
    assert 'Reply JSON schema:' in attempts[0]['request']['messages'][0]['content']
    assert attempts[0]['roles'] == ['fields', 'reasoning']
    assert 'PRIVATE' not in json.dumps(emitted)

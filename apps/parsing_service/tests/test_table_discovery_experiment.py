"""The experiment must reject counts that hide wrong, duplicate or unresolved record starts."""
import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from experiments.extraction.table_discovery import assemble, cases, score
from experiments.extraction.table_discovery_full import assess_records, capture_http


def entry(segment="L4", start=0, end=10, *, status="validated", parent=None):
    return {"id": f"{segment}@{start}", "ranges": [{"segment": segment, "start": start, "end": end}],
            "end": status, **({"parent": parent} if parent else {})}


class BoundaryScoringTests(unittest.TestCase):
    def test_correct_count_with_wrong_boundary_fails(self):
        result = score([entry("L3"), entry("L5")], [entry("L4"), entry("L5")])
        self.assertFalse(result["pass"])
        self.assertEqual(result["missing"], ["L4@0"])
        self.assertEqual(result["extra"], ["L3@0"])

    def test_duplicate_start_does_not_replace_a_missing_record(self):
        result = score([entry(), entry()], [entry(), entry("L5")])
        self.assertFalse(result["pass"])
        self.assertEqual(result["matched"], 1)

    def test_unplaceable_boundary_or_unread_source_fails(self):
        self.assertFalse(score([entry()], [entry()], ["boundary_unplaced"])["pass"])
        self.assertFalse(score([entry()], [entry()], ledger=[{"disposition": "withheld"}])["pass"])

    def test_equal_starts_do_not_hide_missing_text_or_parent_relationship(self):
        self.assertFalse(score([entry(end=8)], [entry()])["pass"])
        self.assertFalse(score([entry(parent="L2@0")], [entry()])["pass"])

    def test_source_end_is_valid_only_when_reference_marks_an_excerpt(self):
        self.assertTrue(score([entry(status="source_end")], [entry(status="source_end")])["pass"])
        self.assertFalse(score([entry(status="source_end")], [entry()])["pass"])

    def test_exact_records_and_record_free_sources_pass(self):
        self.assertTrue(score([entry()], [entry()])["pass"])
        self.assertTrue(score([], [], ledger=[{"disposition": "other"}])["pass"])

    def test_record_order_is_part_of_the_reference(self):
        self.assertFalse(score([entry("L5"), entry()], [entry(), entry("L5")])["pass"])


class CapturedRequestTests(unittest.TestCase):
    def setUp(self):
        self.captured = {"system": "A record is a site. BASELINE_SCOPE", "user":
                         "### WINDOW\n[L1 table row] Site\tYear\n[L2 table row] Site A\t1800\n\nReturn JSON."}
        self.span = {"attributes": {"input.value": json.dumps(self.captured)}}

    def test_capture_source_and_prompt_are_preserved_in_baseline(self):
        case = cases(self.span, "{description}", "BASELINE_SCOPE", {"entries": [entry("L2", end=11)]})[0]
        self.assertEqual(case["system"], self.captured["system"])
        self.assertEqual(case["user"], self.captured["user"])

    def test_a_different_deployed_scope_refuses_approximate_replay(self):
        with self.assertRaises(ValueError):
            cases(self.span, "{description}", "DIFFERENT_SCOPE", {"entries": [entry("L2", end=11)]})

    def test_invalid_reference_cannot_silently_be_scored(self):
        for expected in ([entry("L3")], [entry("L2", start=-1)], [entry("L2", end=100)],
                         [entry("L2"), entry("L2")], [entry("L2", status="unresolved")]):
            with self.subTest(expected=expected), self.assertRaises(ValueError):
                cases(self.span, "{description}", "BASELINE_SCOPE", {"entries": expected})


class RealAssemblyTests(unittest.TestCase):
    def test_unresolved_record_end_fails_even_with_no_unresolved_ledger_rows(self):
        case = {"name": "uncertain-end", "user": "[L1] Port A\n[L2] Region: West"}
        answer = {"places": [["L1", "record", None]], "begins_inside_record": False, "ends_inside_record": None}
        body = assemble(case, answer)
        self.assertTrue(all(r["disposition"] != "unresolved" for r in body["ledger"]))
        expected = [{**entry("L1", end=6), "ranges": [
            {"segment": "L1", "start": 0, "end": 6}, {"segment": "L2", "start": 0, "end": 12}]}]
        self.assertFalse(score(body["entries"], expected, body["issues"], body["ledger"])["pass"])

    def test_missing_end_boundary_cannot_hide_footer_owned_by_last_record(self):
        case = {"name": "footer", "user": "[L1] Port A\n[L2] Port B\n[L3] Bibliography"}
        expected = [entry("L1", end=6), entry("L2", end=6)]
        answer = {"places": [["L1", "record", None], ["L2", "record", None], ["L3", "other", None]],
                  "begins_inside_record": False, "ends_inside_record": False}
        body = assemble(case, answer)
        self.assertTrue(score(body["entries"], expected, body["issues"], body["ledger"])["pass"])
        answer["places"].pop()
        body = assemble(case, answer)
        result = score(body["entries"], expected, body["issues"], body["ledger"])
        self.assertFalse(result["pass"])
        self.assertEqual(result["ownership_errors"], ["L2@0"])


class FullRecordScoringTests(unittest.TestCase):
    def setUp(self):
        self.expected = entry("p1_s0", start=10, end=25)
        self.reference = {"entries": [self.expected], "records": [
            {"port": "Port A (Island)", "region": "West", "year": "1700"}]}

    def result(self, record_entry, fields=None):
        return {"discovery": {"entries": [record_entry], "ledger": [], "issues": []},
                "records": fields or self.reference["records"]}

    def test_unresolved_or_extended_full_record_is_not_a_successful_assessment(self):
        for status, stop in (("unresolved", 25), ("validated", 100)):
            with self.subTest(status=status, stop=stop):
                result = self.result(entry("p1_s0", start=10, end=stop, status=status))
                assessment = assess_records(result, self.reference)
                self.assertFalse(assessment["structure"]["pass"])
                self.assertIsNone(assessment["field_result"])

    def test_correct_values_at_wrong_canonical_boundaries_are_not_scored_as_correct_rows(self):
        assessment = assess_records(self.result(entry("p1_s0", end=25)), self.reference)
        self.assertFalse(assessment["structure"]["pass"])
        self.assertIsNone(assessment["field_result"])

    def test_correct_structure_does_not_hide_a_truncated_name_or_wrong_year(self):
        result = self.result(self.expected, [{"port": "Port A", "region": "West", "year": None}])
        assessment = assess_records(result, self.reference)
        self.assertTrue(assessment["structure"]["pass"])
        self.assertEqual(assessment["field_result"]["rows_correct"], 0)
        self.assertEqual(assessment["field_result"]["cells_correct"], 1)

    def test_string_comparison_does_not_strip_meaningful_punctuation(self):
        self.reference["records"][0]["port"] = "Port A*"
        result = self.result(self.expected, [{"port": "Port A", "region": "West", "year": "1700"}])
        self.assertEqual(assess_records(result, self.reference)["field_result"]["cells_correct"], 2)


class WireCaptureTests(unittest.TestCase):
    def test_capture_records_actual_fallback_attempts_without_headers_urls_or_error_bodies(self):
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
        self.assertEqual(reply.text, '{}')
        attempts = [i['capture'] for i in emitted]
        self.assertEqual([a['status'] for a in attempts], [400, 200])
        self.assertIn('response_format', attempts[0]['request'])
        self.assertNotIn('response_format', attempts[1]['request'])
        self.assertIn('Reply JSON schema:', attempts[0]['request']['messages'][0]['content'])
        self.assertEqual(attempts[0]['roles'], ['fields', 'reasoning'])
        self.assertNotIn('PRIVATE', json.dumps(emitted))

import copy
import json
import unittest
from pathlib import Path

from app.parsing.continuation import (
    ProducerReviewDecision,
    evaluate_reviewed_continuation,
)


FIXTURE = Path(__file__).parent / "fixtures" / "producer_review_observations.json"


class TestProducerReview(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
        cls.cases = {case["name"]: case for case in cls.fixture["cases"]}

    def boundary(self, name):
        fixture_boundary = self.cases[name]["boundary"]
        return copy.deepcopy(
            {
                "doctags": fixture_boundary["_fixture_doctags"],
                "interstitial": fixture_boundary["_fixture_interstitial"],
                "following_content": fixture_boundary["following_content"],
            }
        )

    def review(self, name):
        case = self.cases[name]
        records = self.fixture["record_sets"][case["_fixture_record_set"]]
        return evaluate_reviewed_continuation(
            records,
            boundary=self.boundary(name),
        )

    def test_fixture_is_raw_observation_not_v2_output(self):
        self.assertTrue(self.fixture["_fixture"]["not_a_v2_contract"])
        self.assertNotIn("logical_table", self.fixture)
        for records in self.fixture["record_sets"].values():
            for record in records:
                self.assertIn("self_ref", record)
                self.assertIn("prov", record)
                self.assertIn("data", record)
                self.assertNotIn("table_id", record)

    def test_fixture_positive_contains_actual_body_only_otsl_observation(self):
        doctags = self.cases["positive_6_to_7"]["boundary"]["_fixture_doctags"]
        self.assertIn("<ched>", doctags[0]["otsl"])
        self.assertIn("<fcel>", doctags[1]["otsl"])
        self.assertNotIn("<ched>", doctags[1]["otsl"])
        self.assertEqual(
            self.cases["positive_6_to_7"]["boundary"]["_fixture_interstitial"],
            [{"tag": "<page_break>"}],
        )

    def test_reviewed_6_to_7_is_one_group_but_retains_page_local_records(self):
        decision = self.review("positive_6_to_7")
        records = decision.records

        self.assertTrue(decision.continue_table)
        self.assertEqual(decision.groups, (records,))
        self.assertEqual(decision.pages, (4, 5))
        self.assertEqual(
            decision.observed_provenance,
            (tuple(records[0]["prov"]), tuple(records[1]["prov"])),
        )
        self.assertEqual(decision.observed_provenance[0][0]["page_no"], 4)
        self.assertEqual(decision.observed_provenance[1][0]["page_no"], 5)
        self.assertIsNotNone(decision.observed_provenance[0][0]["bbox"])
        self.assertEqual(
            decision.following_content[0]["text"],
            (
                "Tolkning: Jordfæstegrav. Vurderet på baggrund af perlerne fra "
                "graven kan der være tale om en kvindegrav."
            ),
        )

        self.assertEqual(len(records[0]["data"]["table_cells"]), 30)
        self.assertEqual(len(records[1]["data"]["table_cells"]), 24)
        self.assertEqual(
            self.cell_facts(records[0])[:3],
            [
                (0, 0, "Fundnummer", True, False, False, 1, 1),
                (0, 1, "Beskrivelse", True, False, False, 1, 1),
                (0, 2, "Bemærkninger", True, False, False, 1, 1),
            ],
        )
        self.assertEqual(
            self.cell_facts(records[1])[-3:],
            [
                (7, 0, "26-27", False, False, False, 1, 1),
                (7, 1, "Lerkar", False, False, False, 1, 1),
                (7, 2, "Hankekop. Niv. 6", False, False, False, 1, 1),
            ],
        )

    def test_capture_local_refs_are_not_a_hidden_digest_allowlist(self):
        records = copy.deepcopy(self.fixture["record_sets"]["6_7"])
        records[0]["self_ref"], records[1]["self_ref"] = "#/tables/8", "#/tables/9"
        decision = evaluate_reviewed_continuation(
            records,
            boundary=self.boundary("positive_6_to_7"),
        )
        self.assertTrue(decision.continue_table)

    def test_structural_matrix_mismatch_rejects_but_following_text_is_not_a_digest(self):
        records = copy.deepcopy(self.fixture["record_sets"]["6_7"])
        boundary = self.boundary("positive_6_to_7")
        records[0]["data"]["table_cells"][0]["text"] = "unrelated"
        self.assertFalse(
            evaluate_reviewed_continuation(records, boundary=boundary).continue_table
        )

        records = copy.deepcopy(self.fixture["record_sets"]["6_7"])
        boundary = self.boundary("positive_6_to_7")
        boundary["following_content"][0]["text"] = "changed narrative"
        self.assertTrue(
            evaluate_reviewed_continuation(records, boundary=boundary).continue_table
        )

    def test_positive_rejects_mismatched_otsl_content(self):
        boundary = self.boundary("positive_6_to_7")
        boundary["doctags"][1]["otsl"] = boundary["doctags"][1]["otsl"].replace(
            "26-11", "not-26-11", 1
        )
        decision = evaluate_reviewed_continuation(
            self.fixture["record_sets"]["6_7"],
            boundary=boundary,
        )
        self.assertFalse(decision.continue_table)
        self.assertEqual(decision.reason, "insufficient_continuation_observation")

    def test_positive_rejects_reordered_otsl_cells(self):
        boundary = self.boundary("positive_6_to_7")
        boundary["doctags"][0]["otsl"] = boundary["doctags"][0]["otsl"].replace(
            "<ched>Fundnummer<ched>Beskrivelse",
            "<ched>Beskrivelse<ched>Fundnummer",
            1,
        )
        decision = evaluate_reviewed_continuation(
            self.fixture["record_sets"]["6_7"],
            boundary=boundary,
        )
        self.assertFalse(decision.continue_table)
        self.assertEqual(decision.reason, "insufficient_continuation_observation")

    def test_positive_rejects_corrupted_non_sentinel_middle_cell(self):
        boundary = self.boundary("positive_6_to_7")
        boundary["doctags"][0]["otsl"] = boundary["doctags"][0]["otsl"].replace(
            "Små fragmenter. Niv. 1", "CORRUPTED MIDDLE CELL", 1
        )
        decision = evaluate_reviewed_continuation(
            self.fixture["record_sets"]["6_7"],
            boundary=boundary,
        )
        self.assertFalse(decision.continue_table)
        self.assertEqual(decision.reason, "insufficient_continuation_observation")

    def test_positive_requires_ordered_distinct_reviewed_pages(self):
        records = copy.deepcopy(self.fixture["record_sets"]["6_7"])
        boundary = self.boundary("positive_6_to_7")

        records[1]["prov"][0]["page_no"] = 4
        same_page = evaluate_reviewed_continuation(records, boundary=boundary)
        self.assertFalse(same_page.continue_table)
        self.assertEqual(same_page.reason, "insufficient_continuation_observation")

        records = copy.deepcopy(self.fixture["record_sets"]["6_7"])
        boundary = self.boundary("positive_6_to_7")
        records[0]["prov"][0]["page_no"], records[1]["prov"][0]["page_no"] = 5, 4
        for item, page in zip(boundary["doctags"], (5, 4), strict=True):
            item["page_no"] = page
        reversed_pages = evaluate_reviewed_continuation(records, boundary=boundary)
        self.assertFalse(reversed_pages.continue_table)
        self.assertEqual(reversed_pages.reason, "insufficient_continuation_observation")

        records = copy.deepcopy(self.fixture["record_sets"]["6_7"])
        boundary = self.boundary("positive_6_to_7")
        records[1]["prov"][0]["page_no"] = 6
        mismatched_pages = evaluate_reviewed_continuation(records, boundary=boundary)
        self.assertFalse(mismatched_pages.continue_table)
        self.assertEqual(
            mismatched_pages.reason, "insufficient_continuation_observation"
        )

    def test_arbitrary_row_zero_header_is_not_the_10_to_11_anomaly(self):
        records = copy.deepcopy(self.fixture["record_sets"]["6_7"])
        boundary = self.boundary("positive_6_to_7")
        records[1]["data"]["table_cells"][0]["column_header"] = True
        boundary["doctags"][1]["otsl"] = boundary["doctags"][1]["otsl"].replace(
            "<fcel>26-11", "<ched>Other header<ched><fcel>26-11", 1
        )
        decision = evaluate_reviewed_continuation(records, boundary=boundary)
        self.assertFalse(decision.continue_table)
        self.assertNotEqual(decision.reason, "ambiguous_column_header")
        self.assertEqual(decision.reason, "insufficient_continuation_observation")

    @staticmethod
    def cell_facts(record):
        return [
            (
                cell["start_row_offset_idx"],
                cell["start_col_offset_idx"],
                cell["text"],
                cell["column_header"],
                cell["row_header"],
                cell["row_section"],
                cell["row_span"],
                cell["col_span"],
            )
            for cell in record["data"]["table_cells"]
        ]

    def test_continuation_does_not_require_geometry(self):
        records = copy.deepcopy(self.fixture["record_sets"]["6_7"])
        records[1]["prov"][0].pop("bbox")
        decision = evaluate_reviewed_continuation(
            records,
            boundary=self.boundary("positive_6_to_7"),
        )
        self.assertTrue(decision.continue_table)
        self.assertNotIn("bbox", decision.observed_provenance[1][0])

    def test_narrative_interstitial_retains_separate_tables(self):
        decision = self.review("narrative_interstitial")
        self.assertFalse(decision.continue_table)
        self.assertEqual(decision.reason, "intervening_narrative")
        self.assertEqual(len(decision.groups), 2)

    def test_new_header_row_is_an_independent_negative(self):
        decision = self.review("new_table_header_row")
        self.assertFalse(decision.continue_table)
        self.assertEqual(decision.reason, "new_table_header_row")

    def test_caption_is_an_independent_negative(self):
        decision = self.review("caption_interstitial")
        self.assertFalse(decision.continue_table)
        self.assertEqual(decision.reason, "caption")

    def test_failed_continuation_observation_retains_separate_tables(self):
        decision = self.review("failed_continuation_evidence")
        self.assertFalse(decision.continue_table)
        self.assertEqual(decision.reason, "insufficient_continuation_observation")

    def test_10_to_11_anomaly_remains_separate_and_unaltered(self):
        decision = self.review("anomaly_10_to_11")
        records = decision.records

        self.assertFalse(decision.continue_table)
        self.assertEqual(decision.reason, "insufficient_continuation_observation")
        self.assertEqual(decision.groups, ((records[0],), (records[1],)))
        self.assertEqual(decision.pages, (5, 6))
        self.assertEqual(
            decision.observed_provenance,
            (tuple(records[0]["prov"]), tuple(records[1]["prov"])),
        )
        self.assertEqual(
            self.cell_facts(records[0]),
            [
                (0, 0, "N ummer", True, False, False, 1, 1),
                (0, 1, "Beskrivelse", True, False, False, 1, 1),
                (0, 2, "Bemærkninger", True, False, False, 1, 1),
                (1, 0, "30-1", False, False, False, 1, 1),
                (1, 1, "Skeletdele, tand", False, False, False, 1, 1),
                (2, 0, "30-3", False, False, False, 1, 1),
                (2, 1, "Knoglefragmenter,", False, False, False, 1, 1),
            ],
        )
        self.assertEqual(
            self.cell_facts(records[1]),
            [
                (0, 1, "formodentlig skinneben", True, False, False, 1, 1),
                (1, 0, "30-4", False, False, False, 1, 1),
                (
                    1,
                    1,
                    "Knoglefragmenter, formodentlig skinneben",
                    False,
                    False,
                    False,
                    1,
                    1,
                ),
                (2, 0, "30-6", False, False, False, 1, 1),
                (2, 1, "Knoglefragmenter", False, False, False, 1, 1),
                (2, 2, "Fundet ved afrensning", False, False, False, 1, 1),
            ],
        )
        self.assertIn("Fundliste til grav 30:", decision.following_content[0]["text"])
        self.assertEqual(decision.following_content[1]["self_ref"], "#/tables/12")

    def test_malformed_numeric_values_cannot_continue(self):
        records = copy.deepcopy(self.fixture["record_sets"]["6_7"])
        records[0]["prov"][0]["page_no"] = 4.9
        self.assertEqual(
            evaluate_reviewed_continuation(
                records, boundary=self.boundary("positive_6_to_7")
            ).reason,
            "malformed_observation",
        )

        records = copy.deepcopy(self.fixture["record_sets"]["6_7"])
        records[0]["prov"].append(copy.deepcopy(records[0]["prov"][0]))
        self.assertEqual(
            evaluate_reviewed_continuation(
                records, boundary=self.boundary("positive_6_to_7")
            ).reason,
            "malformed_observation",
        )

        records = copy.deepcopy(self.fixture["record_sets"]["6_7"])
        records[0]["data"]["table_cells"][0]["row_span"] = True
        self.assertEqual(
            evaluate_reviewed_continuation(
                records, boundary=self.boundary("positive_6_to_7")
            ).reason,
            "malformed_observation",
        )

        records = copy.deepcopy(self.fixture["record_sets"]["6_7"])
        boundary = self.boundary("positive_6_to_7")
        boundary["doctags"][0]["page_no"] = 4.0
        self.assertEqual(
            evaluate_reviewed_continuation(records, boundary=boundary).reason,
            "insufficient_continuation_observation",
        )

        records = copy.deepcopy(self.fixture["record_sets"]["6_7"])
        records[0]["data"]["table_cells"][0]["start_row_offset_idx"] = False
        self.assertEqual(
            evaluate_reviewed_continuation(
                records, boundary=self.boundary("positive_6_to_7")
            ).reason,
            "malformed_observation",
        )

    def test_decision_snapshots_caller_owned_records(self):
        records = copy.deepcopy(self.fixture["record_sets"]["6_7"])
        decision = evaluate_reviewed_continuation(
            records, boundary=self.boundary("positive_6_to_7")
        )
        records[0]["prov"][0]["page_no"] = 99
        records[0]["data"]["table_cells"][0]["text"] = "changed"
        self.assertEqual(decision.pages, (4, 5))
        self.assertEqual(
            decision.records[0]["data"]["table_cells"][0]["text"], "Fundnummer"
        )

    def test_direct_decision_construction_freezes_records(self):
        records = [{"prov": [{"page_no": 1}]}]
        decision = ProducerReviewDecision(
            continue_table=False,
            records=records,
            following_content=[],
            reason="test",
        )
        records[0]["prov"][0]["page_no"] = 9
        self.assertEqual(decision.pages, (1,))

    def test_malformed_boundary_items_are_rejected(self):
        invalid_items = {
            "doctags": "not a doctag",
            "interstitial": "not interstitial content",
            "following_content": {},
        }
        for field, invalid_item in invalid_items.items():
            with self.subTest(field=field):
                boundary = self.boundary("positive_6_to_7")
                boundary[field].append(invalid_item)
                decision = evaluate_reviewed_continuation(
                    self.fixture["record_sets"]["6_7"], boundary=boundary
                )
                self.assertEqual(decision.reason, "malformed_observation")

    def test_empty_or_malformed_observations_cannot_continue(self):
        decision = evaluate_reviewed_continuation(
            [],
            boundary=self.boundary("positive_6_to_7"),
        )
        self.assertFalse(decision.continue_table)
        self.assertEqual(decision.reason, "malformed_observation")
        self.assertEqual(decision.groups, ())

        records = copy.deepcopy(self.fixture["record_sets"]["6_7"])
        records[0]["data"]["table_cells"] = [{}]
        malformed = evaluate_reviewed_continuation(
            records,
            boundary=self.boundary("positive_6_to_7"),
        )
        self.assertFalse(malformed.continue_table)
        self.assertEqual(malformed.reason, "malformed_observation")

        non_mapping = evaluate_reviewed_continuation(
            [None, None],
            boundary=self.boundary("positive_6_to_7"),
        )
        self.assertFalse(non_mapping.continue_table)
        self.assertEqual(non_mapping.reason, "malformed_observation")

    def test_adjacent_records_without_raw_otsl_evidence_cannot_continue(self):
        boundary = self.boundary("positive_6_to_7")
        boundary["doctags"] = []
        decision = evaluate_reviewed_continuation(
            self.fixture["record_sets"]["6_7"],
            boundary=boundary,
        )
        self.assertFalse(decision.continue_table)
        self.assertEqual(decision.reason, "insufficient_continuation_observation")


if __name__ == "__main__":
    unittest.main()

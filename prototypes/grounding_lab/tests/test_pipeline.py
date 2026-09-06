"""Lexical-tier self-check — runs without torch installed."""

import io
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import ModuleType
from unittest.mock import patch

from grounding_lab.pipeline import (
    Anchor,
    Claim,
    bounded_contains,
    lexical_match,
    normalize,
    render_claim,
)


def anchor(anchor_id: str, text: str) -> Anchor:
    return Anchor(anchor_id, text, page=1)


def claim(value, context=None) -> Claim:
    return Claim(value=value, result_path=("field",), gold_anchor_ids=(), context=context)


class NormalizeTest(unittest.TestCase):
    def test_locale_numbers_converge(self):
        self.assertEqual(normalize("1.234,56"), normalize("1,234.56"))
        self.assertEqual(normalize("1.234,56"), "1234.56")

    def test_dates_iso_ize(self):
        self.assertEqual(normalize("17.06.1790"), "1790-06-17")
        self.assertEqual(normalize("17/6/1790"), "1790-06-17")
        self.assertEqual(normalize("1790-06-17"), "1790-06-17")

    def test_casefold_and_punctuation(self):
        self.assertEqual(normalize("Ærø, Danmark!"), "ærø danmark")

    def test_month_name_dates_iso_ize(self):
        self.assertEqual(normalize("13. august 2004"), "2004-08-13")
        self.assertEqual(normalize("August 13, 2004"), "2004-08-13")
        self.assertEqual(normalize("17 juin 1790"), "1790-06-17")
        self.assertEqual(normalize("den 13. august 2004."), "den 2004-08-13.")
        self.assertEqual(normalize("40 august 2004"), "40 august 2004")

    def test_space_grouping_and_unicode_minus(self):
        # typographic no-break spaces are grouping in documents...
        self.assertEqual(normalize("645 000"), "645000")
        self.assertEqual(normalize("1 234 567,89"), "1234567.89")
        # ...a plain space is not: "page 5 200" / adjacent table cells stay two numbers
        self.assertEqual(normalize("page 5 200"), "page 5 200")
        self.assertFalse(bounded_contains("5200", "page 5 200"))
        # Grouped scalars match in either representation.
        self.assertTrue(bounded_contains("1234", "1 234"))
        self.assertTrue(bounded_contains("645000", "645 000 bebes"))
        self.assertTrue(bounded_contains("645 000", "645000 bebes"))
        self.assertTrue(bounded_contains("645 000", "645 000 bebes"))
        self.assertTrue(bounded_contains("645 000", "645 000 bebes"))
        self.assertEqual(normalize("in 2024 100 cases"), "in 2024 100 cases")
        self.assertTrue(bounded_contains("−6 000", "-6000"))

    def test_glued_unit_splits(self):
        self.assertEqual(normalize("1300m2"), normalize("1300 m2"))
        self.assertEqual(normalize("1,300m2"), normalize("1,300 m2"))
        self.assertTrue(bounded_contains("1300 m2", "udgrave 1300m2 i 100m zonen"))
        self.assertTrue(bounded_contains("1,300 m2", "area 1,300m2"))
        self.assertFalse(bounded_contains("2", "1300m2"))

    def test_percent_and_currency_markers_are_preserved(self):
        self.assertEqual(normalize("50 %"), normalize("50%"))
        self.assertEqual(normalize("$ 50"), normalize("$50"))
        self.assertEqual(normalize("50 €"), normalize("50€"))
        self.assertTrue(bounded_contains("50%", "rate: 50 %"))
        self.assertTrue(bounded_contains("$50", "budget: $ 50"))
        self.assertFalse(bounded_contains("50%", "budget: $50"))
        self.assertFalse(bounded_contains("$50", "rate: 50%"))
        self.assertFalse(bounded_contains("$50", "budget: €50"))
        self.assertTrue(bounded_contains("$116,800", "income in 2024 ($116,800), followed by"))


class BoundedContainmentTest(unittest.TestCase):
    def test_shared_semantics(self):
        cases = [
            ("1.234,56", "Total 1,234.56 kg", True),
            ("18", "dated 1834", False),
            ("8-1", "find 8-1", True),
            ("1", "find 8-1", False),
            ("4.4", "4.3-4.4", False),
            ("4.4", "4.3–4.4", False),
            ("4.4", "4.4 | 4.2", True),
            ("x", "x", True),
            ("x", "grade x", False),
            (5, "there were 5 cases", True),
            (True, "true", True),
        ]
        for value, text, expected in cases:
            with self.subTest(value=value, text=text):
                self.assertEqual(bounded_contains(value, text), expected)


class LexicalMatchTest(unittest.TestCase):
    def test_unique_containment_scores_one(self):
        anchors = [anchor("a1", "Total weight was 1,234.56 kg."), anchor("a2", "No numbers here.")]
        link = lexical_match(claim("1.234,56"), anchors)
        self.assertIsNotNone(link)
        self.assertEqual(link.anchor_id, "a1")
        self.assertEqual(link.score, 1.0)

    def test_spaced_ocr_hits_are_undecided_and_never_verbatim(self):
        from grounding_lab.pipeline import lexical_tier, loose_contains

        anchors = [anchor("a1", "Institute, Im Dol 2 -6, Berlin"), anchor("a2", "Editor: Carlos Jos é Dias")]
        decided, hits = lexical_tier(claim("Im Dol 2-6"), anchors)
        self.assertIsNone(decided)  # scorer disambiguates; containment cap applies
        self.assertEqual([a.anchor_id for a in hits], ["a1"])
        self.assertTrue(loose_contains("Carlos José Dias", anchors[1].text))
        self.assertTrue(loose_contains("AAR33284", "AAR 33273 og AAR 33284."))
        self.assertFalse(loose_contains("grav 12", "grav 1 2"))  # digit runs stay whole
        self.assertFalse(loose_contains("1234", "1 234"))  # numbers never loosen

    def test_ambiguous_containment_abstains(self):
        anchors = [anchor("a1", "born 1790"), anchor("a2", "died 1790")]
        self.assertIsNone(lexical_match(claim("1790"), anchors))

    def test_boolean_and_short_cell_values_link(self):
        self.assertEqual(
            lexical_match(claim(True), [anchor("a1", "true")]).anchor_id,
            "a1",
        )
        self.assertEqual(
            lexical_match(claim("A"), [anchor("a1", "A")]).anchor_id,
            "a1",
        )
        self.assertEqual(
            lexical_match(claim(5), [anchor("a1", "there were 5 cases")]).anchor_id,
            "a1",
        )

    def test_no_match_abstains(self):
        anchors = [anchor("a1", "completely unrelated prose about fish")]
        self.assertIsNone(lexical_match(claim("Hamburg free port"), anchors))

    def test_substring_of_longer_number_does_not_match(self):
        self.assertIsNone(lexical_match(claim("18"), [anchor("a1", "Fundet dateres til 1834 e.Kr.")]))
        self.assertIsNone(lexical_match(claim("15"), [anchor("a1", "Side 3 af 152")]))

    def test_bounded_number_still_matches(self):
        link = lexical_match(claim("18"), [anchor("a1", "mindst 18 treskibede langhuse")])
        self.assertEqual(link.anchor_id, "a1")

    def test_hyphenated_find_id_matches(self):
        link = lexical_match(claim("8-1"), [anchor("a1", "8-1"), anchor("a2", "prose")])
        self.assertEqual(link.anchor_id, "a1")


class ConfigRoutingTest(unittest.TestCase):
    def test_neural_configs_route_to_the_right_scorer(self):
        # regression: "nli-only".endswith("nli") is False — this test actually
        # drives ground() and asserts which scorer ran, with models mocked out.
        from unittest.mock import patch

        import grounding_lab.pipeline as pipeline

        class FakeIndex:
            # two hits: lexical configs disambiguate inside the hit set
            anchors = [anchor("a1", "value 1591 here"), anchor("a2", "1591 again")]

            def shortlist(self, _text):
                return self.anchors

        expected = {
            "lexical+ce": "ce", "lexical+nli": "nli",
            "lexical+ce-bare": "ce", "lexical+nli-bare": "nli",
            "ce-only": "ce", "nli-only": "nli",
        }
        for config, scorer in expected.items():
            called = []
            fake = lambda text, sl, called=called: (
                called.append(1), pipeline.Link(None, 0.0, 0.0, "fake")
            )[1]
            target = "nli_match" if scorer == "nli" else "cross_encoder_match"
            with patch.object(pipeline, target, fake):
                other = "cross_encoder_match" if scorer == "nli" else "nli_match"
                with patch.object(pipeline, other, side_effect=AssertionError(config)):
                    pipeline.ground(claim("1591"), FakeIndex(), config)
            self.assertTrue(called, f"{config} did not call {target}")

    def test_lexical_configs_abstain_on_zero_hits_without_neural_pass(self):
        from unittest.mock import patch

        import grounding_lab.pipeline as pipeline

        class FakeIndex:
            anchors = [anchor("a1", "unrelated")]

            def shortlist(self, _text):
                raise AssertionError("dense shortlist must not run for a zero-hit claim")

        for config in ("lexical", "lexical+ce", "lexical+nli", "lexical+ce-bare", "lexical+nli-bare"):
            with patch.object(pipeline, "cross_encoder_match", side_effect=AssertionError(config)):
                with patch.object(pipeline, "nli_match", side_effect=AssertionError(config)):
                    link = pipeline.ground(claim("no lexical hit"), FakeIndex(), config)
            self.assertEqual((link.anchor_id, link.tier), (None, "lexical"), config)

    def test_neural_only_configs_skip_tier_one(self):
        from unittest.mock import patch

        import grounding_lab.pipeline as pipeline

        class FakeIndex:  # one verbatim hit; ce-only must still go dense, not lexical
            anchors = [anchor("a1", "1591"), anchor("a2", "prose")]

            def shortlist(self, _text):
                return self.anchors

        seen = {}
        fake = lambda text, sl: (seen.setdefault("text", text), pipeline.Link("a2", 0.9, 0.5, "fake"))[1]
        with patch.object(pipeline, "cross_encoder_match", fake):
            link = pipeline.ground(claim("1591", context="port: Livorno"), FakeIndex(), "ce-only")
        self.assertEqual(link.anchor_id, "a2")
        self.assertEqual(seen["text"], "field: 1591 (port: Livorno)")

    def test_hit_set_rendering_is_field_with_siblings_or_bare(self):
        from unittest.mock import patch

        import grounding_lab.pipeline as pipeline

        class FakeIndex:
            anchors = [anchor("a1", "1591 a"), anchor("a2", "1591 b")]

            def shortlist(self, _text):
                raise AssertionError("multi-hit must rerank inside the hit set")

        for config, expected in (("lexical+ce", "field: 1591 (port: Livorno)"), ("lexical+ce-bare", "1591")):
            seen = {}
            fake = lambda text, sl: (seen.setdefault("text", text), pipeline.Link("a1", 0.9, 0.5, "fake"))[1]
            with patch.object(pipeline, "cross_encoder_match", fake):
                pipeline.ground(claim("1591", context="port: Livorno"), FakeIndex(), config)
            self.assertEqual(seen["text"], expected, config)


class MarginLinkTest(unittest.TestCase):
    def test_empty_shortlist_abstains(self):
        import numpy

        from grounding_lab.pipeline import _margin_link

        link = _margin_link(numpy.array([]), [], "cross-encoder")
        self.assertIsNone(link.anchor_id)


class CrossEncoderConfigTest(unittest.TestCase):
    def test_selected_qwen_reranker_is_pinned_and_instruction_aware(self):
        import grounding_lab.pipeline as pipeline

        calls = {}
        sentence_transformers = ModuleType("sentence_transformers")
        torch = ModuleType("torch")
        torch.bfloat16 = object()

        def fake_cross_encoder(model, **kwargs):
            calls.update(model=model, **kwargs)
            return object()

        sentence_transformers.CrossEncoder = fake_cross_encoder
        pipeline._cross_encoder.cache_clear()
        try:
            with patch.dict(
                sys.modules,
                {"sentence_transformers": sentence_transformers, "torch": torch},
            ):
                pipeline._cross_encoder()
        finally:
            pipeline._cross_encoder.cache_clear()

        self.assertEqual(calls["model"], "Qwen/Qwen3-Reranker-0.6B")
        self.assertEqual(calls["revision"], pipeline.CROSS_ENCODER_REVISION)
        self.assertEqual(calls["prompts"], {"evidence": pipeline.RERANK_INSTRUCTION})
        self.assertEqual(calls["default_prompt_name"], "evidence")
        self.assertIs(calls["model_kwargs"]["dtype"], torch.bfloat16)


class VerbatimDowngradeTest(unittest.TestCase):
    def test_near_variant_link_is_downgraded(self):
        from grounding_lab.pipeline import Link, verbatim_downgrade

        anchors = [anchor("a1", "Kroppedal Museums journalnummer: TAK 1506")]
        link = Link("a1", 0.99, 0.95, "cross-encoder")
        downgraded = verbatim_downgrade(link, claim("TAK 1507"), anchors)
        self.assertLessEqual(downgraded.confidence, 0.25)
        self.assertEqual(downgraded.tier, "cross-encoder*")

    def test_verbatim_link_untouched(self):
        from grounding_lab.pipeline import Link, verbatim_downgrade

        anchors = [anchor("a1", "Kroppedal Museums journalnummer: TAK 1506")]
        link = Link("a1", 0.99, 0.95, "cross-encoder")
        self.assertEqual(verbatim_downgrade(link, claim("TAK 1506"), anchors), link)

    def test_wrong_boolean_link_is_downgraded(self):
        from grounding_lab.pipeline import Link, verbatim_downgrade

        link = Link("a1", 0.99, 0.95, "cross-encoder")
        downgraded = verbatim_downgrade(link, claim(True), [anchor("a1", "false")])
        self.assertLessEqual(downgraded.confidence, 0.25)

    def test_row_context_does_not_rescue_wrong_sibling_cell(self):
        # A wrong sibling cell shares the row context that contains the value;
        # containment must check the cell's own text, not the row.
        from grounding_lab.pipeline import Link, verbatim_downgrade

        wrong_cell = Anchor(
            "a1", "Livorno", page=1, context="Livorno | Med | 1591 — Livorno"
        )
        link = Link("a1", 0.99, 0.95, "cross-encoder")
        downgraded = verbatim_downgrade(link, claim("1591"), [wrong_cell])
        self.assertLessEqual(downgraded.confidence, 0.25)
        self.assertEqual(downgraded.tier, "cross-encoder*")


class SiblingGateTest(unittest.TestCase):
    def test_gate_routes_single_hits_and_narrows_bare_numbers(self):
        from grounding_lab.pipeline import gated_lexical_tier

        anchors = [
            Anchor("h7", "Grab 7", 1),
            Anchor("d7", "L 2,34, B 1,42 m", 1),
            Anchor("f1", "Adult, männlich", 1),
            Anchor("f2", "Literatur: Größler 1909", 1),
            Anchor("f3", "Unverz. Glockenbecher", 1),
            Anchor("h8", "Grab 8", 1),
            Anchor("d8", "L 1, B 0,8 m", 1),
            Anchor("far", "Tiefe 0,8 m", 3),
        ]
        # one hit, in another grave's entry: the anchor is kept but goes to review
        link, _ = gated_lexical_tier(
            Claim(2.34, ("records", 1, "length"), ("d8",), context="grave_id: Grab 8"), anchors
        )
        self.assertEqual((link.anchor_id, link.confidence, link.tier), ("d7", 0.0, "lexical-gated"))
        # a bare number in two anchors: only the one near its sibling links
        link, hits = gated_lexical_tier(
            Claim(0.8, ("records", 1, "width"), ("d8",), context="grave_id: Grab 8"), anchors
        )
        self.assertEqual((link.anchor_id, link.confidence, [a.anchor_id for a in hits]), ("d8", 1.0, ["d8"]))
        # no usable sibling: the plain lexical decision, undecided with both hits
        link, hits = gated_lexical_tier(Claim(0.8, ("records", 1, "width"), ("d8",)), anchors)
        self.assertEqual((link, len(hits)), (None, 2))


class BareNumberPruningTest(unittest.TestCase):
    def test_keeps_row_supported_matches(self):
        from grounding_lab.pipeline import narrow_bare_number_hits

        hits = [
            Anchor("wrong", "40", 1, "grave: Grave 7 | material: Copper | 40"),
            Anchor("right", "40", 1, "grave: Grave 8 | material: Bronze | 40"),
            Anchor("tie", "40", 1, "grave: Grave 8 | material: Copper | 40"),
        ]
        item = Claim(40, ("records", 0, "weight"), ("right",), "grave: Grave 8, material: Bronze")
        self.assertEqual(
            [anchor.anchor_id for anchor in narrow_bare_number_hits(item, hits)],
            ["right", "tie"],
        )

    def test_no_row_signal_and_non_bare_values_pass_through(self):
        from grounding_lab.pipeline import narrow_bare_number_hits

        hits = [Anchor("a", "40", 1), Anchor("b", "40", 1)]
        item = Claim(40, ("records", 0, "weight"), (), "grave: Grave 8")
        self.assertIs(narrow_bare_number_hits(item, hits), hits)
        self.assertIs(narrow_bare_number_hits(claim("forty", "grave: 8"), hits), hits)

    def test_letter_suffix_ambiguity_is_exposed_for_instrumentation(self):
        from grounding_lab.pipeline import letter_suffix_ambiguous

        hits = [Anchor("a", "grave 1117A", 1)]
        self.assertTrue(letter_suffix_ambiguous(1117, hits))
        self.assertFalse(letter_suffix_ambiguous("1117A", hits))


class UnknownConfigTest(unittest.TestCase):
    def test_unknown_config_raises(self):
        from grounding_lab.pipeline import ground

        with self.assertRaises(ValueError):
            ground(claim("x"), None, "lexical+typo")


class ParseLinksTest(unittest.TestCase):
    # Shape must mirror production groundingSelections: exactly one top-level
    # "links" object; a flat claim map is a protocol failure, not links.
    def test_links_object_accepted(self):
        from grounding_lab.llm_baseline import parse_links

        self.assertEqual(parse_links('{"links": {"C1": "E4"}}'), {"C1": "E4"})

    def test_flat_map_rejected(self):
        from grounding_lab.llm_baseline import parse_links

        self.assertEqual(parse_links('{"C1": "E4"}'), {})

    def test_extra_top_level_keys_rejected(self):
        from grounding_lab.llm_baseline import parse_links

        self.assertEqual(parse_links('{"links": {"C1": "E4"}, "note": "hi"}'), {})

    def test_one_malformed_value_rejects_whole_batch(self):
        from grounding_lab.llm_baseline import parse_links

        self.assertEqual(parse_links('{"links": {"C1": "E4", "C2": 2}}'), {})
        self.assertEqual(parse_links('{"links": {"C1": "E4", "C2": ""}}'), {})
        self.assertEqual(parse_links('{"links": {"C1": " "}}'), {"C1": " "})

    def test_json_dug_out_of_prose(self):
        from grounding_lab.llm_baseline import parse_links

        self.assertEqual(
            parse_links('Sure! {"links": {"C1": "NONE"}}'), {"C1": "NONE"}
        )


class LlmLabelTest(unittest.TestCase):
    def test_only_exact_none_and_e_labels_are_accepted(self):
        import grounding_lab.llm_baseline as baseline

        index = type("Index", (), {"anchors": [anchor("a1", "evidence")]})()
        claims = [
            Claim("yes", ("yes",), ("a1",)),
            Claim("absent", ("absent",), ()),
        ]

        def run(links):
            ground = lambda *_args: (links, 0.0)
            output = io.StringIO()
            with (
                patch.object(
                    baseline,
                    "load_dataset",
                    return_value=[("doc", index, claims)],
                ),
                redirect_stdout(output),
            ):
                baseline.main(Path("."), "test", ground=ground)
            return output.getvalue()

        self.assertIn(
            "| test | 1/1 | 1/1 | 0 | 0 |", run({"C1": "E1", "C2": "NONE"})
        )
        for label in ("e1", " E1", "E01", "EE1", "E1١", "1", "NONE "):
            with self.subTest(label=label):
                self.assertIn(
                    "| test | 0/1 | 1/1 | 0 | 1 |",
                    run({"C1": label, "C2": "NONE"}),
                )


class DatasetLoadingTest(unittest.TestCase):
    def test_anchor_structure_is_loaded(self):
        from grounding_lab.harness import load_dataset

        with tempfile.TemporaryDirectory() as directory:
            doc = Path(directory) / "document"
            doc.mkdir()
            (doc / "anchors.json").write_text(
                '[{"anchorId":"a","text":"40","page":2,"kind":"table_cell",'
                '"context":"row","afterBibliography":false,"logicalTableId":"t","row":3}]',
                encoding="utf-8",
            )
            (doc / "claims.json").write_text("[]", encoding="utf-8")
            anchor = load_dataset(Path(directory))[0][1].anchors[0]
            self.assertEqual(
                (anchor.kind, anchor.after_bibliography, anchor.logical_table_id, anchor.row),
                ("table_cell", False, "t", 3),
            )

    def test_fixture_directories_are_excluded(self):
        from grounding_lab.harness import load_dataset

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("document", "_smoke"):
                doc = root / name
                doc.mkdir()
                (doc / "anchors.json").write_text("[]", encoding="utf-8")
                (doc / "claims.json").write_text("[]", encoding="utf-8")
            self.assertEqual(
                [name for name, _, _ in load_dataset(root)], ["document"]
            )

    def test_extra_claim_files_are_merged_when_present(self):
        from grounding_lab.harness import load_dataset

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, traps in (("with", True), ("without", False)):
                doc = root / name
                doc.mkdir()
                (doc / "anchors.json").write_text("[]", encoding="utf-8")
                (doc / "claims.json").write_text(
                    '[{"value": "a", "goldAnchorId": null}]', encoding="utf-8"
                )
                if traps:
                    (doc / "traps.json").write_text(
                        '[{"value": "b", "goldAnchorId": null}]', encoding="utf-8"
                    )
            loaded = {
                name: [c.value for c in claims]
                for name, _, claims in load_dataset(
                    root, ("claims.json", "traps.json")
                )
            }
            self.assertEqual(loaded, {"with": ["a", "b"], "without": ["a"]})
            # default is unchanged
            self.assertEqual(
                {name: [c.value for c in claims] for name, _, claims in load_dataset(root)},
                {"with": ["a"], "without": ["a"]},
            )


class LabelReviewTest(unittest.TestCase):
    def test_default_scope_validates_all_evaluated_documents(self):
        from grounding_lab.label_review import main

        dataset = Path(__file__).parents[1] / "dataset"
        output = io.StringIO()
        with (
            patch("sys.argv", ["label-review", str(dataset)]),
            redirect_stdout(output),
        ):
            self.assertEqual(main(), 0)
        self.assertIn("OK: 10 doc(s) validated, 26 warning(s)", output.getvalue())

    def test_incomplete_extraction_fails_before_it_can_be_a_benchmark_set(self):
        from grounding_lab.label_review import main

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            doc = root / "truncated"
            doc.mkdir()
            (doc / "anchors.json").write_text(
                '[{"anchorId":"a","text":"invented","page":1}]', encoding="utf-8"
            )
            (doc / "claims_extracted.json").write_text(
                '[{"value":"invented","goldAnchorIds":[],"expectedLexicalHitIds":["a"]}]',
                encoding="utf-8",
            )
            (doc / "extracted_meta.json").write_text(
                '{"metadata":{"finishReason":"length"},"error":null}', encoding="utf-8"
            )
            errors = io.StringIO()
            with (
                patch("sys.argv", ["label-review", str(root), "--claims", "claims_extracted.json"]),
                redirect_stdout(io.StringIO()),
                redirect_stderr(errors),
            ):
                self.assertEqual(main(), 1)
            self.assertIn("extraction incomplete", errors.getvalue())

    def test_extraction_metadata_is_required_and_null_safe(self):
        from grounding_lab.label_review import main

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            doc = root / "failed"
            doc.mkdir()
            (doc / "anchors.json").write_text("[]", encoding="utf-8")
            (doc / "claims_extracted.json").write_text("[]", encoding="utf-8")
            meta = doc / "extracted_meta.json"

            for payload, message in (
                ('{"metadata":null,"error":"boom"}', "error 'boom'"),
                (None, "extracted_meta.json missing"),
            ):
                if payload is None:
                    meta.unlink()
                else:
                    meta.write_text(payload, encoding="utf-8")
                errors = io.StringIO()
                with (
                    patch("sys.argv", ["label-review", str(root), "--claims", "claims_extracted.json"]),
                    redirect_stdout(io.StringIO()),
                    redirect_stderr(errors),
                ):
                    self.assertEqual(main(), 1)
                self.assertIn(message, errors.getvalue())


class DateGuardTest(unittest.TestCase):
    def test_invalid_day_or_month_left_alone(self):
        self.assertEqual(normalize("35.06.1790"), "35.06.1790")
        self.assertEqual(normalize("3.13.1790"), "3.13.1790")


class RenderClaimTest(unittest.TestCase):
    def test_context_appended(self):
        self.assertEqual(
            render_claim(claim("1591", context="port: Livorno")),
            "field: 1591 (port: Livorno)",
        )

    def test_anchor_scoring_text_prefers_context(self):
        cell = Anchor("a1", "1591", page=1, context="Livorno | Med | 1591 — 1591")
        self.assertEqual(cell.scoring_text, "Livorno | Med | 1591 — 1591")
        self.assertEqual(anchor("a2", "plain").scoring_text, "plain")


if __name__ == "__main__":
    unittest.main()

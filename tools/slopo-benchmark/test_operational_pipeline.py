from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import numpy as np
import yaml

import operational_pipeline as pipeline


class OperationalPipelineConfigTests(unittest.TestCase):
    def test_saved_pipeline_matches_benchmark_selection(self) -> None:
        settings = pipeline.load_pipeline_settings()

        self.assertEqual(
            (
                "pplx-v1-0.6b-512d",
                "jina-v2-code-768d",
                "qwen3-0.6b-1024d",
            ),
            settings.discovery_configurations,
        )
        self.assertEqual(
            ("voyage-4-nano-512d",), settings.confirmation_configurations
        )
        self.assertEqual(
            "pplx-v1-0.6b-512d", settings.fusion.primary_configuration
        )
        self.assertEqual(50, settings.fusion.pool_size_per_configuration)
        self.assertEqual(0.60, settings.fusion.member_jaccard_threshold)
        self.assertFalse(settings.fusion.transitive_member_union)

    def test_source_plan_excludes_non_production_inputs_and_pipeline_state(self) -> None:
        settings = pipeline.load_pipeline_settings()
        exclusions = set(pipeline.source_plan(settings)["source_dir_exclude"])

        self.assertIn("**/.slopo/**", exclusions)
        self.assertIn("**/tests/**", exclusions)
        self.assertIn("**/*.test.*", exclusions)
        self.assertIn("tools/**", exclusions)
        self.assertIn("openspec/**", exclusions)

    def test_embedding_plan_contains_pinned_artifacts(self) -> None:
        settings = pipeline.load_pipeline_settings()

        for item in pipeline.embedding_plan(settings):
            with self.subTest(configuration=item["configuration"]):
                self.assertRegex(item["revision"], r"^[0-9a-f]{40}$")
                self.assertRegex(item["sha256"], r"^[0-9a-f]{64}$")

    def test_unsupported_fusion_setting_fails_closed(self) -> None:
        raw = yaml.safe_load(
            pipeline.DEFAULT_PIPELINE_CONFIG.read_text(encoding="utf-8")
        )
        raw["fusion"]["minimum_support"] = 3

        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "pipeline.yaml"
            path.write_text(yaml.safe_dump(raw, sort_keys=False), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "minimum_support"):
                pipeline.load_pipeline_settings(path)


class OperationalPipelineStateTests(unittest.TestCase):
    def test_embedding_refresh_restores_tracked_per_model_ignore_file(self) -> None:
        settings = pipeline.load_pipeline_settings()
        with tempfile.TemporaryDirectory(dir=pipeline.ROOT) as temporary_directory:
            temporary = Path(temporary_directory)
            review_dir = temporary / "ignores"
            review_dir.mkdir()
            isolated = replace(settings, work_dir=temporary, review_dir=review_dir)
            first = isolated.models[0]
            for model in isolated.models:
                isolated.ignore_path(model.configuration).write_text(
                    "reviewed-cluster\n" if model == first else "",
                    encoding="utf-8",
                )
            ignore_path = isolated.runs_dir / first.configuration / "slopo.ignore.txt"
            ignore_path.parent.mkdir(parents=True)
            ignore_path.write_text("stale-run-state\n", encoding="utf-8")

            def fake_write_run_database(**arguments):
                spec = arguments["spec"]
                dimensions = arguments["dimensions"]
                run_dir = isolated.runs_dir / f"{spec.family}-{dimensions}d"
                if run_dir.exists():
                    shutil.rmtree(run_dir)
                run_dir.mkdir(parents=True)
                db_file = run_dir / "slopo.db"
                db_file.touch()
                return db_file, None

            with (
                patch.object(
                    pipeline.benchmark,
                    "embed_model",
                    return_value=(
                        ["body"],
                        np.ones((1, 2048), dtype=np.float32),
                        {"revision": "pinned"},
                    ),
                ),
                patch.object(
                    pipeline.benchmark,
                    "write_run_database",
                    side_effect=fake_write_run_database,
                ),
            ):
                pipeline.run_embedding_stage(
                    isolated,
                    {"fingerprint": "corpus"},
                    use_cache=True,
                )

            self.assertEqual(
                "reviewed-cluster\n", ignore_path.read_text(encoding="utf-8")
            )

    def test_embedding_state_rejects_a_changed_index(self) -> None:
        settings = pipeline.load_pipeline_settings()
        with tempfile.TemporaryDirectory() as temporary_directory:
            isolated = replace(settings, work_dir=Path(temporary_directory))
            state = {
                "index_fingerprint": "old",
                "embedding_plan_sha256": pipeline.sha256_json(
                    pipeline.embedding_plan(isolated)
                ),
                "models": [],
            }
            isolated.embedding_state.write_text(
                json.dumps(state), encoding="utf-8"
            )

            with self.assertRaisesRegex(ValueError, "source changed"):
                pipeline.load_embedding_state(
                    isolated, {"fingerprint": "new"}
                )

    def test_label_stripping_makes_every_candidate_unreviewed(self) -> None:
        value = {
            "top": [
                {"state": "known_positive", "relevant": True},
                {"state": "known_hard_negative", "relevant": False},
            ],
            "p20": {
                "returned": 2,
                "reviewed": 2,
                "unknown": 0,
                "known_precision_lower_bound": 0.5,
                "reviewed_precision": 0.5,
            },
            "p50": {},
        }

        result = pipeline.remove_evaluation_labels(value)

        self.assertEqual(
            ["unreviewed", "unreviewed"],
            [item["state"] for item in result["top"]],
        )
        self.assertEqual([None, None], [item["relevant"] for item in result["top"]])
        self.assertEqual(2, result["p20"]["unknown"])
        self.assertEqual(0.0, result["p20"]["reviewed_precision"])


if __name__ == "__main__":
    unittest.main()

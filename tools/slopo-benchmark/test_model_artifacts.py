from __future__ import annotations

import hashlib
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock, patch

import benchmark


class ModelArtifactLockTests(unittest.TestCase):
    def test_every_model_artifact_is_pinned(self) -> None:
        for spec in benchmark.MODEL_SPECS:
            with self.subTest(family=spec.family):
                self.assertRegex(spec.revision, r"^[0-9a-f]{40}$")
                self.assertRegex(spec.sha256, r"^[0-9a-f]{64}$")
                if spec.projection_filename:
                    self.assertRegex(spec.projection_sha256 or "", r"^[0-9a-f]{64}$")
                else:
                    self.assertIsNone(spec.projection_sha256)

    def test_download_uses_pinned_revision_and_accepts_matching_hash(self) -> None:
        contents = b"pinned model bytes"
        spec = replace(
            benchmark.MODEL_SPECS[0],
            revision="a" * 40,
            sha256=hashlib.sha256(contents).hexdigest(),
        )
        api = Mock()
        api.list_repo_files.return_value = [spec.filename]

        with tempfile.TemporaryDirectory() as temporary_directory:
            artifact = Path(temporary_directory) / spec.filename
            artifact.write_bytes(contents)
            with patch.object(
                benchmark, "hf_hub_download", return_value=str(artifact)
            ) as download:
                path, revision, filename = benchmark.download_model(spec, api)

        self.assertEqual(artifact, path)
        self.assertEqual(spec.revision, revision)
        self.assertEqual(spec.filename, filename)
        api.list_repo_files.assert_called_once_with(
            repo_id=spec.repo, revision=spec.revision
        )
        download.assert_called_once_with(
            repo_id=spec.repo,
            filename=spec.filename,
            revision=spec.revision,
            cache_dir=benchmark.MODEL_CACHE,
        )

    def test_download_rejects_changed_artifact_bytes(self) -> None:
        spec = replace(benchmark.MODEL_SPECS[0], sha256="0" * 64)
        api = Mock()
        api.list_repo_files.return_value = [spec.filename]

        with tempfile.TemporaryDirectory() as temporary_directory:
            artifact = Path(temporary_directory) / spec.filename
            artifact.write_bytes(b"unexpected bytes")
            with patch.object(
                benchmark, "hf_hub_download", return_value=str(artifact)
            ):
                with self.assertRaisesRegex(ValueError, "artifact hash mismatch"):
                    benchmark.download_model(spec, api)


if __name__ == "__main__":
    unittest.main()

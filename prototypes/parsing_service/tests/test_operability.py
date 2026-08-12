"""Static checks for documented workspace and dependency profiles."""

from __future__ import annotations

import json
import tomllib
import unittest
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parents[1]
WORKSPACE_ROOT = SERVICE_ROOT.parents[1]


def _load_json(path: Path) -> dict:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise AssertionError(f"Could not read JSON configuration: {path}") from exc
    if not isinstance(loaded, dict):
        raise AssertionError(f"Expected a JSON object in {path}")
    return loaded


def _load_toml(path: Path) -> dict:
    try:
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise AssertionError(f"Could not read TOML configuration: {path}") from exc


class TestOperabilityContracts(unittest.TestCase):
    def test_cpu_and_gpu_profiles_are_explicit_and_runtime_preserves_selection(self):
        pyproject = _load_toml(SERVICE_ROOT / "pyproject.toml")
        extras = pyproject["project"]["optional-dependencies"]
        self.assertIn("ocr-cpu", extras)
        self.assertIn("ocr-gpu", extras)
        conflicts = pyproject["tool"]["uv"]["conflicts"]
        self.assertTrue(conflicts)

        scripts = _load_json(SERVICE_ROOT / "package.json")["scripts"]
        self.assertIn("--extra ocr-cpu", scripts["install:python"])
        self.assertIn(
            "--reinstall-package nvidia-cusparselt-cu13",
            scripts["install:python"],
        )
        self.assertIn("--extra ocr-gpu", scripts["install:python:gpu"])
        self.assertIn("--no-sync", scripts["dev"])
        self.assertIn("--no-sync", scripts["test"])
        self.assertNotIn("--extra", scripts["dev"])
        self.assertNotIn("--extra", scripts["test"])

        workspace_scripts = _load_json(WORKSPACE_ROOT / "package.json")["scripts"]
        self.assertNotIn("install:cpu", workspace_scripts)
        self.assertIn("install:gpu", workspace_scripts)


if __name__ == "__main__":
    unittest.main()

import importlib.resources
import tomllib
import unittest
from pathlib import Path


class PackagingTests(unittest.TestCase):
    def test_prompt_files_are_declared_as_package_data(self) -> None:
        pyproject = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))

        self.assertIn(
            "task_instructions/*.txt",
            pyproject["tool"]["setuptools"]["package-data"]["model_providers"],
        )

    def test_prompt_files_are_readable_as_package_resources(self) -> None:
        task_instructions = importlib.resources.files("model_providers").joinpath(
            "task_instructions"
        )

        self.assertIn("Return ONLY a single JSON object", task_instructions.joinpath(
            "structured.txt"
        ).read_text(encoding="utf-8"))
        self.assertIn("Markdown", task_instructions.joinpath("markdown.txt").read_text(
            encoding="utf-8"
        ))


if __name__ == "__main__":
    unittest.main()

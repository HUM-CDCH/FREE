"""Serving code never imports the experiment code (docs/extraction-experiments.md, Ownership)."""
import ast
from pathlib import Path

SOURCE = Path(__file__).parent.parent / "src"


def test_serving_modules_never_import_experiments():
    offenders = []
    for path in SOURCE.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0:
                names = [node.module or ""]
            else:
                continue
            offenders += [f"{path.relative_to(SOURCE)}: {name}" for name in names if name.split(".")[0] == "experiments"]
    assert offenders == []

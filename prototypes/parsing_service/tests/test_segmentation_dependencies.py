"""The segmentation artifact must not depend on its computation or orchestration, nor the stages on extraction."""
import ast
from importlib.util import resolve_name
from pathlib import Path

from kei_exp import kie
from kei_exp.kie import segmentation

KIE = Path(kie.__file__).parent


def _imports(path: Path, package: str) -> set[str]:
    # Include function-local imports: the original cycle was hidden inside obtain().
    imports = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            imports.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            module = resolve_name("." * node.level + (node.module or ""), package)
            imports.add(module)
            imports.update(f"{module}.{alias.name}" for alias in node.names)
    return imports


def _violations(imports: set[str], forbidden: set[str]) -> list[str]:
    return sorted(name for name in imports
                  if any(name == target or name.startswith(target + ".") for target in forbidden))


def test_segmentation_artifacts_do_not_import_the_segmenter_or_runner():
    imports = _imports(Path(segmentation.__file__), segmentation.__package__)
    violations = _violations(imports, {"kei_exp.kie.stages.segment", "kei_exp.kie.segmentation_run"})
    assert not violations, f"Segmentation artifacts depend on execution: {violations}"


def test_the_passage_view_and_the_recipe_path_do_not_import_extraction():
    assert _violations(_imports(KIE / "passages.py", "kei_exp.kie"), {"kei_exp.kie"}) == []
    modules = [KIE / name for name in ("segmentation.py", "segmentation_run.py", "boundaries.py")]
    modules += sorted((KIE / "stages").glob("*.py"))
    for path in modules:
        package = "kei_exp.kie.stages" if path.parent.name == "stages" else "kei_exp.kie"
        violations = _violations(_imports(path, package), {"kei_exp.kie.extract"})
        assert not violations, f"{path.relative_to(KIE)} depends on extraction: {violations}"

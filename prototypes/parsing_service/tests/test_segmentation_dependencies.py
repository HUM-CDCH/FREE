"""The segmentation artifact must not depend on its computation or orchestration, nor the stages on extraction,
nor any extraction module on the orchestrator `run` that chooses among them, nor the recipe Catalog's model-free
modules on the implementation that uses them or on the version 1 artifact; and the crop data and the transcriber
contract must not depend on the layout detector or the stages, so a module that only names them loads no OCR stack."""
import ast
import json
import subprocess
import sys
from importlib.util import resolve_name
from pathlib import Path

import pytest

from kei_exp import kie
from kei_exp.kie import segmentation

KIE = Path(kie.__file__).parent
KEI = KIE.parent
HEAVY = ("docling", "torch", "transformers", "cv2")


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


def test_no_extraction_module_imports_the_orchestrator():
    for path in sorted((KIE / "extract").glob("*.py")):
        if path.name == "run.py":
            continue
        violations = _violations(_imports(path, "kei_exp.kie.extract"), {"kei_exp.kie.extract.run"})
        assert not violations, f"{path.relative_to(KIE)} depends on the orchestrator: {violations}"


def test_the_recipe_catalogs_model_free_modules_do_not_import_what_runs_it():
    forbidden = {"kei_exp.kie.extract.grounded", "kei_exp.kie.extract.run", "kei_exp.kie.extract.assembly"}
    for name in ("acceptance.py", "windows.py", "catalog_result.py"):
        violations = _violations(_imports(KIE / "extract" / name, "kei_exp.kie.extract"), forbidden)
        assert not violations, f"extract/{name} depends on the recipe Catalog's execution: {violations}"


def test_the_crop_data_and_the_transcriber_contract_do_not_import_the_cut_or_the_stages():
    forbidden = {"kei_exp.cut", "kei_exp.kie.stages"}
    modules = ((KEI / "regions.py", "kei_exp"), (KEI / "transcription" / "types.py", "kei_exp.transcription"))
    for path, package in modules:
        violations = _violations(_imports(path, package), forbidden)
        assert not violations, f"{path.relative_to(KEI)} depends on the layout detector or the stages: {violations}"


# ponytail: two accepted edges still carry the OCR stack into the result and the API. kei_exp.models builds its records
# from Docling's VLM model specs, whose module loads torch, transformers and cv2; kei_exp._pdfium takes Docling's
# PDFium lock, which loads the docling package alone (the result reaches it through kei_exp.pages). An edge is a
# kei_exp module that imports one of the heavy packages, itself or through a third-party module it imports; the
# probe records every such import during one real import of the target, already-loaded packages included.
_MODEL_RECORDS = "kei_exp.models"
_PDFIUM_LOCK = "kei_exp._pdfium"

_PROBE = """
import builtins, importlib, json, sys
from importlib.util import resolve_name

HEAVY = {heavy!r}
edges = set()


def importer():
    frame = sys._getframe(2)
    while frame is not None and not frame.f_globals.get("__name__", "").startswith("kei_exp"):
        frame = frame.f_back
    return frame.f_globals["__name__"] if frame is not None else None


def record(name):
    if name.partition(".")[0] in HEAVY:
        edges.add((importer(), name.partition(".")[0]))


def recorded_import(name, globals=None, locals=None, fromlist=(), level=0):
    record(resolve_name("." * level + name, globals["__package__"]) if level else name)
    return original_import(name, globals, locals, fromlist, level)


def recorded_import_module(name, package=None):
    record(resolve_name(name, package) if name.startswith(".") else name)
    return original_import_module(name, package)


original_import, builtins.__import__ = builtins.__import__, recorded_import
original_import_module, importlib.import_module = importlib.import_module, recorded_import_module
import {module}
builtins.__import__, importlib.import_module = original_import, original_import_module
print(json.dumps({{"edges": sorted(edges, key=str), "heavy": sorted(name for name in HEAVY if name in sys.modules)}}))
"""


def _probe(module: str) -> tuple[set[tuple[str | None, str]], list[str]]:
    """The (kei_exp importer, heavy package) edges one real import of module takes in a fresh interpreter, and the
    heavy packages loaded after it; an importer is None when no kei_exp module is on the stack."""
    run = subprocess.run([sys.executable, "-c", _PROBE.format(module=module, heavy=HEAVY)],
                         capture_output=True, text=True, check=False)
    assert run.returncode == 0, f"importing {module} failed:\n{run.stderr}"
    observed = json.loads(run.stdout.splitlines()[-1])
    return {tuple(edge) for edge in observed["edges"]}, observed["heavy"]


@pytest.mark.parametrize("module, accepted", [
    ("kei_exp.regions", set()),
    ("kei_exp.transcription.types", set()),
    ("kei_exp.result", {_MODEL_RECORDS, _PDFIUM_LOCK}),
    ("kei_exp.api", {_MODEL_RECORDS}),
])
def test_light_modules_load_the_ocr_stack_only_through_accepted_edges(module, accepted):
    edges, heavy = _probe(module)
    importers = {importer for importer, _ in edges}
    unexpected = sorted((importer, package) for importer, package in edges if importer not in accepted)
    assert not unexpected, f"{module} reaches the OCR stack beyond its accepted edges {sorted(accepted)}: {unexpected}"
    for edge in sorted(accepted - importers):
        pytest.fail(f"{module} no longer reaches the OCR stack through {edge}: drop it from its accepted edges")
    if not accepted:
        assert heavy == [], f"{module} loads {heavy}"

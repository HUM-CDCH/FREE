"""Docling's layout and table weights in a folder Docling reads without asking the Hugging Face hub.

Given no `artifacts_path`, Docling resolves each model's revision on the hub for every pipeline it builds, cached
weights or not, and the native path builds one per conversion: a slow hub stalls a conversion that needs nothing from
it. Given one, it reads `<artifacts_path>/<repo folder>` and asks nothing. So each model is fetched once, the way
Docling fetches it (through the Hugging Face cache), and a copy is kept in that layout. The folder is per Docling
release: the revisions are that release's, so the next one fetches its own.
"""
from __future__ import annotations

import shutil
from collections.abc import Callable
from importlib.metadata import version
from pathlib import Path

from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.datamodel.settings import settings
from docling.models.stages.table_structure.table_structure_model import TableStructureModel
from docling.models.utils.hf_model_download import download_hf_model
from filelock import FileLock

_LAYOUT_FILES = ("config.json", "preprocessor_config.json", "model.safetensors")
_TABLE_FILES = tuple(
    f"{TableStructureModel._model_path}/{mode}/{name}"
    for mode in ("accurate", "fast")
    for name in ("tm_config.json", f"tableformer_{mode}.safetensors")
)


def local(options: PdfPipelineOptions) -> Path | None:
    """The folder holding the weights a pipeline with `options` loads, each fetched on first use. None where the
    operator already names a folder of their own (`DOCLING_ARTIFACTS_PATH`), which Docling then reads."""
    if settings.artifacts_path is not None:
        return None
    root = settings.cache_dir / "models" / version("docling")
    layout = options.layout_options
    spec = layout.model_spec.get_engine_config(layout.engine_options.engine_type)
    _keep(root / spec.repo_id.replace("/", "--"), _LAYOUT_FILES,
          lambda: download_hf_model(spec.repo_id, revision=spec.revision))
    if options.do_table_structure:
        _keep(root / TableStructureModel._model_repo_folder, _TABLE_FILES, TableStructureModel.download_models)
    return root


def _keep(folder: Path, required: tuple[str, ...], fetch: Callable[[], Path]) -> None:
    """Publish a usable snapshot once, even across concurrent or interrupted conversions."""
    def complete(path: Path) -> bool:
        return all((path / name).is_file() for name in required)

    if complete(folder):
        return
    folder.parent.mkdir(parents=True, exist_ok=True)
    with FileLock(folder.with_suffix(".lock")):
        if complete(folder):
            return
        staging = folder.with_suffix(".partial")
        if staging.exists():
            shutil.rmtree(staging)  # a previous writer died holding this model's lock
        source = fetch()
        if folder.exists():
            shutil.rmtree(folder)  # repair an incomplete copy published by an earlier worker
        try:
            shutil.copytree(source, staging)
            if not complete(staging):
                raise FileNotFoundError(f"Incomplete Docling snapshot for {folder.name} at {source}")
            staging.rename(folder)
        finally:
            if staging.exists():
                shutil.rmtree(staging)

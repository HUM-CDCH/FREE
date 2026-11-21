"""Docling's layout and table weights in a folder Docling reads without asking the Hugging Face hub.

Given no `artifacts_path`, Docling resolves each model's revision on the hub for every pipeline it builds, cached
weights or not, and the native path builds one per conversion: a slow hub stalls a conversion that needs nothing from
it. Given one, it reads `<artifacts_path>/<repo folder>` and asks nothing. So each model is fetched once, the way
Docling fetches it (through the Hugging Face cache), and a copy is kept in that layout. The folder is per Docling
release: the revisions are that release's, so the next one fetches its own.
"""
from __future__ import annotations

import shutil
import tempfile
from collections.abc import Callable
from importlib.metadata import version
from pathlib import Path

from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.datamodel.settings import settings
from docling.models.stages.table_structure.table_structure_model import TableStructureModel
from docling.models.utils.hf_model_download import download_hf_model


def local(options: PdfPipelineOptions) -> Path | None:
    """The folder holding the weights a pipeline with `options` loads, each fetched on first use. None where the
    operator already names a folder of their own (`DOCLING_ARTIFACTS_PATH`), which Docling then reads."""
    if settings.artifacts_path is not None:
        return None
    root = settings.cache_dir / "models" / version("docling")
    layout = options.layout_options
    spec = layout.model_spec.get_engine_config(layout.engine_options.engine_type)
    _keep(root / spec.repo_id.replace("/", "--"), lambda: download_hf_model(spec.repo_id, revision=spec.revision))
    if options.do_table_structure:
        _keep(root / TableStructureModel._model_repo_folder, TableStructureModel.download_models)
    return root


def _keep(folder: Path, fetch: Callable[[], Path]) -> None:
    """A copy at `folder` of the model `fetch` returns, unless it is there. Published by rename: Docling takes an
    existing folder as complete, so a fetch stopped halfway must leave none."""
    if folder.exists():
        return
    folder.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(dir=folder.parent, prefix=".fetch-"))
    try:
        shutil.copytree(fetch(), staging, dirs_exist_ok=True)
        try:
            staging.rename(folder)
        except OSError:  # the API or another conversion published it first
            if not folder.exists():
                raise
    finally:
        shutil.rmtree(staging, ignore_errors=True)

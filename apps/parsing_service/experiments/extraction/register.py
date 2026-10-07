"""Freeze the supplied six-paper validation corpus and ten example PDFs before inference.

python -m experiments.extraction.register DIAGNOSIS_ROOT MANIFEST
The manifest records paths and hashes; moving data requires a new manifest, never silent rebinding.
"""
from __future__ import annotations

import argparse
import copy
import subprocess
from datetime import UTC, datetime
from pathlib import Path

from kei_exp.kie.extract.method import ArticleOptions, CatalogFactors
from kei_exp.kie.passages import load
from .manifest import code_pin, pin, read, validate, write_new


def source(identifier, run, schema, methods, identity_fields, *, gold=False, pdf=None):
    evidence = load(run)
    return {"id": identifier, "run": str(run), "generation": evidence.generation, "digest": evidence.digest,
            "canonical_files": [pin(p) for p in sorted((run / "result").rglob("*.json"))],
            "schema": pin(schema), "pdf": pin(pdf) if pdf is not None else None,
            "methods": methods, "identity_fields": identity_fields,
            "exposure": "development" if gold else "unannotated", "used_in_previous_diagnosis": True,
            "annotation": "adjudicated non-exhaustive collagen gold" if gold else "no independent field annotations"}


def register(root: Path, service: Path) -> dict:
    root = root.resolve()
    models = {"fields": "instruct", "reasoning": "instruct"}
    base = {"strategy": "article", "models": models, "article": ArticleOptions().model_dump(mode="json")}
    methods = {"reference": base}
    for name, parent, key, value in [
        ("identity", "reference", "identity", "conservative"),
        ("schema", "identity", "prompt", "schema"),
        ("bounded", "schema", "context", "bounded"),
        ("quoted", "bounded", "grounding", "quoted"),
        ("full_quoted", "schema", "grounding", "quoted"),
        ("overlap", "bounded", "overlap_passages", 1),
        ("unverified", "bounded", "grounding", "off"),
    ]:
        methods[name] = copy.deepcopy(methods[parent])
        methods[name]["article"][key] = value
    article_methods = list(methods)
    comparisons = [{"control": parent, "treatment": name, "factor": f"article.{key}"}
                   for name, parent, key in [
                       ("identity", "reference", "identity"), ("schema", "identity", "prompt"),
                       ("bounded", "schema", "context"), ("quoted", "bounded", "grounding"),
                       ("full_quoted", "schema", "grounding"), ("overlap", "bounded", "overlap_passages"),
                       ("unverified", "bounded", "grounding")]]
    methods["catalog"] = {"strategy": "catalog", "models": models, "catalog": {
        "recipe": "headed-graves-da@1", "input_tokens": 4096, "output_tokens": 2048,
        "factors": CatalogFactors().model_dump()}}
    for name, factor in [("catalog_no_overlap", "overlap"), ("catalog_unverified", "verification")]:
        methods[name] = copy.deepcopy(methods["catalog"])
        methods[name]["catalog"]["factors"][factor] = False
        comparisons.append({"control": "catalog", "treatment": name, "factor": f"catalog.factors.{factor}"})
    methods["generic_catalog"] = {"strategy": "catalog", "models": models}
    sources = []
    gold = read(root / "snapshot/validation/adjudicated-v1/gold.corrected.json")
    identity = ["scientific_name", "tissue", "sample_scope", "sample_fraction"]
    for paper, metadata in sorted(gold["sources"].items()):
        run = Path(read(root / f"fix/full-source-v11/{paper}/pins.json")["canonical_run"])
        sources.append(source(paper, run, root / "fix/collagen.schema.v3.json", article_methods, identity,
                              gold=True, pdf=Path(metadata["absolute_path"])))
    examples = read(root / "fix/examples/evaluation-plan.json")
    pdfs = {pin(p)["sha256"]: p for p in service.parents[1].joinpath("examples").rglob("*.pdf")}
    for item in examples:
        name = item["source_id"]
        variant = item.get("conversion", name)  # the plan names a fixed re-conversion when one replaced the original
        fields = {"historical-person.json": ["person_name", "associated_enslaver"],
                  "research-paper.json": ["study_title"], "archaeology-report.json": ["site_name", "report_id"],
                  "collagen-groups.json": [*identity, "sample_group"], "grave-entry.json": ["grave_id"]}[Path(item["schema"]).name]
        selected = ["reference", "schema", "bounded"] if item["strategy"] == "article" else [
            "generic_catalog", "catalog", "catalog_no_overlap", "catalog_unverified"]
        sources.append(source(name, root / f"fix/examples/conversions/{variant}", Path(item["schema"]), selected, fields,
                              pdf=pdfs[item["source_sha256"]]))
    return {"version": 1, "id": "extraction-ablation-20260927-r1", "registered_at": datetime.now(UTC).isoformat(),
            "base_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=service, text=True).strip(),
            "code_files": code_pin(service), "methods": methods, "sources": sources, "comparisons": comparisons,
            "interactions": [{"label": "context_by_grounding", "baseline": "schema", "a": "bounded",
                              "b": "full_quoted", "ab": "quoted"}],
            "repeats": 1, "order_seed": 20260927,
            "providers": {role: {"base_url": "http://127.0.0.1:18012", "model": "Qwen/Qwen3.8-27B-FP8",
                                 "context_tokens": 32768} for role in ("fields", "reasoning")},
            "sampling": {"temperature": 0, "thinking": False, "model_weights_digest": "unavailable"},
            "evaluation": {"gold": pin(root / "snapshot/validation/adjudicated-v1/gold.corrected.json"),
                           "scorer": pin(root / "snapshot/validation/evaluation-v1/score.py")},
            "primary_metric": "Per-document populated sample-field lower-bound accuracy on six development papers",
            "uncertainty": "Paired document bootstrap, seed 20260927, 10000 draws; descriptive only",
            "scope": "79 fresh cells on 16 existing canonical sources. No held-out claim. No new OCR in this study.",
            "catalog_scope": "One Danish grave excerpt: overlap and verification. No glossary/headings in this excerpt; those factors have scripted contract tests only.",
            "adaptation": "Paper-inspired components, not complete replications of trained LMDX, Tan or Multi-VIE models."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("diagnosis", type=Path)
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()
    service = Path(__file__).resolve().parents[2]
    study = register(args.diagnosis, service)
    cells = validate(study, service)
    write_new(args.manifest, study)
    print(f"registered {len(cells)} cells over {len(study['sources'])} sources")


if __name__ == "__main__":
    main()

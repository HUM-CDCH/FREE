"""Developer-only evaluation watcher.

On a developer deployment a host process watches Project Contexts that hold both
an uploaded gold spreadsheet (with answer rows) and at least one ingested source
document. For each ready Project Context it writes the gold rows to a workbook,
builds the Extraction Schema from the gold header columns, assembles the fixed
pipeline's configuration, runs `iterative_eval.run_pipeline`, and records one
`EvaluationRound` per round.

This module owns the pure decisions the watcher makes: which columns are fields,
what schema they describe, how a workbook is written back, and what pipeline
configuration to run. The database polling loop lives beside it and is a thin
wrapper over these functions. Nothing here is imported by the service runtime.
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import UTC, datetime
from pathlib import Path

FILENAME_COLUMN = "filename"


def _is_filename(column_name: str) -> bool:
    return column_name.strip().lower() == FILENAME_COLUMN


def field_names(columns) -> list[str]:
    """The field column names, in sheet order, without the file-name column."""
    names = []
    for column in columns:
        name = str(column["columnName"] if isinstance(column, dict) else column).strip()
        if name and not _is_filename(name):
            names.append(name)
    return names


def _field_id(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", name.casefold()).strip("_")
    return slug or "field"


def schema_from_gold(columns, *, strategy: str = "article",
                     description: str = "Gold answer fields for the evaluation pipeline.") -> dict:
    """The Extraction Schema the gold header row describes: every field column
    becomes a plain string field, in sheet order, under the strategy's scope."""
    if strategy not in ("article", "catalog"):
        raise ValueError("strategy must be article or catalog")
    names = field_names(columns)
    if not names:
        raise ValueError("the gold sheet has no field columns beside the file-name column")
    nodes, seen = [], {}
    for name in names:
        base = _field_id(name)
        seen[base] = seen.get(base, 0) + 1
        nodes.append({"id": base if seen[base] == 1 else f"{base}_{seen[base]}",
                      "name": name, "type": "string"})
    return {"recordDescription": description,
            "recordScope": "document" if strategy == "article" else "records",
            "schemaNodes": nodes}


def write_gold_workbook(path: Path, columns, rows) -> None:
    """Write the stored gold columns and rows back to the workbook the pipeline
    reads; `rows` are the stored `{columnName: text}` objects in sheet order."""
    import openpyxl  # a developer dependency, kept out of the service runtime

    names = [str(column["columnName"] if isinstance(column, dict) else column) for column in columns]
    if not names:
        raise ValueError("the gold corpus version has no columns")
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = "gold"
    sheet.append(names)
    for row in rows or []:
        sheet.append([row.get(name, "") for name in names])
    path.parent.mkdir(parents=True, exist_ok=True)
    workbook.save(path)


def pipeline_config(*, eval_id: str, schema_path, golden_path, documents, providers, output,
                    runs=None, strategy: str = "article", exhaustive: bool = True,
                    identity=None, options: dict | None = None) -> dict:
    """The `iterative_eval pipeline` configuration for one Project Context."""
    config = {"id": eval_id, "schema": str(schema_path), "golden": str(golden_path),
              "documents": [str(document) for document in documents], "providers": providers,
              "output": str(output), "options": {"strategy": strategy, **(options or {})},
              "exhaustive": exhaustive}
    if runs:
        config["runs"] = {str(key): str(value) for key, value in runs.items()}
    if identity:
        config["identity"] = list(identity)
    return config


def run_id_from_preprocess(preprocess_id: str) -> str | None:
    """The kei run id a Source Representation Revision was made from
    (`kei-exp:<run>:<generation>`), or None for anything else."""
    match = re.fullmatch(r"kei-exp:([A-Za-z0-9][A-Za-z0-9._-]*):([^:\s]+)", preprocess_id or "")
    return match.group(1) if match else None


def base_url_of(chat_url: str) -> str:
    """A chat-completions URL's server root; the pipeline appends
    `/v1/chat/completions` to a provider's `base_url`."""
    trimmed = (chat_url or "").rstrip("/")
    return re.sub(r"/v1/chat/completions$", "", trimmed) or trimmed


def providers_from_env(environ) -> dict:
    """The pipeline's fields/reasoning endpoints: the Free deployment's
    extraction server unless a developer names a separate one."""
    chat_url = environ.get("KEI_EXTRACT_URL", "http://extraction_model:8000/v1/chat/completions")
    model = environ.get("KEI_EXTRACT_MODEL", "Qwen/Qwen3.8-27B-FP8")
    return {"fields": {"base_url": environ.get("FREE_EVAL_FIELDS_URL") or base_url_of(chat_url),
                       "model": environ.get("FREE_EVAL_FIELDS_MODEL") or model},
            "reasoning": {"base_url": environ.get("FREE_EVAL_REASONING_URL") or base_url_of(chat_url),
                          "model": environ.get("FREE_EVAL_REASONING_MODEL") or model}}


READY_PROJECTS = """
SELECT p.id AS project_id, v.id AS version_id, v."revisionNumber" AS revision_number,
       v.columns, v.rows, v.exhaustive
FROM "projectContext" p
JOIN LATERAL (
  SELECT id, "revisionNumber", columns, rows, exhaustive
  FROM "projectSpreadsheetVersion"
  WHERE "projectContextId" = p.id
  ORDER BY "revisionNumber" DESC LIMIT 1
) v ON TRUE
WHERE v.rows IS NOT NULL
ORDER BY p.id
"""

PROJECT_DOCUMENTS = """
SELECT d.id AS document_id, d."originalName" AS original_name, r."preprocessId" AS preprocess_id
FROM "sourceDocument" d
JOIN LATERAL (
  SELECT "preprocessId"
  FROM "sourceRepresentationRevision"
  WHERE "sourceDocumentId" = d.id
  ORDER BY "revisionNumber" DESC LIMIT 1
) r ON TRUE
WHERE d."projectContextId" = %s
ORDER BY d."createdAt"
"""

ALREADY_EVALUATED = """
SELECT 1 FROM "evaluationRound"
WHERE "projectContextId" = %s AND "projectSpreadsheetVersionId" = %s LIMIT 1
"""

INSERT_ROUND = """
INSERT INTO "evaluationRound"
  (id, "projectContextId", "projectSpreadsheetVersionId", "pipelineRunId", label, status,
   documents, pins, metrics, failure, "createdAt", "completedAt")
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
ON CONFLICT ("projectContextId", "pipelineRunId", label) DO NOTHING
"""

FINISH_ROUND = """
UPDATE "evaluationRound" SET status = %s, metrics = %s, failure = %s, "completedAt" = %s
WHERE id = %s
"""

LABELS = ("PILOT_1", "PILOT_2", "BATCH")


def _host_run_directories(documents) -> tuple[list[str], list[dict]]:
    """The canonical run directories of documents whose run is on this host,
    and their `{sourceDocumentId, filename}` pins."""
    from kei_exp import runs as kei_runs

    directories, pinned = [], []
    for document in documents:
        run_id = run_id_from_preprocess(document.get("preprocess_id") or "")
        directory = kei_runs.directory_of(run_id) if run_id else None
        if directory is None:
            continue
        directories.append(str(directory))
        pinned.append({"sourceDocumentId": document["document_id"],
                       "filename": document["original_name"] or run_id})
    return directories, pinned


def evaluate_project(connection, project, documents, *, eval_root: Path, providers,
                     strategy: str = "article", identity=None, exhaustive: bool = True) -> str:
    """Run the fixed pipeline for one ready Project Context and record its three
    rounds. Rows start PENDING and end SUCCEEDED or FAILED, so an interrupted
    watcher leaves a visible PENDING marker instead of silence."""
    from psycopg.types.json import Jsonb

    from .iterative_eval import run_pipeline

    work = eval_root / str(project["project_id"]) / str(project["version_id"])
    schema_path, golden_path = work / "schema.json", work / "gold.xlsx"
    output = work / "out"
    schema_path.parent.mkdir(parents=True, exist_ok=True)
    schema_path.write_text(json.dumps(schema_from_gold(project["columns"], strategy=strategy),
                                      ensure_ascii=False, indent=2), encoding="utf-8")
    write_gold_workbook(golden_path, project["columns"], project["rows"] or [])

    directories, pinned = _host_run_directories(documents)
    if not directories:
        raise RuntimeError("no document of this Project Context has a canonical run on this host")
    config = pipeline_config(eval_id=f"eval-{project['project_id']}-{project['version_id']}",
                             schema_path=schema_path, golden_path=golden_path, documents=directories,
                             providers=providers, output=output, strategy=strategy, identity=identity,
                             exhaustive=exhaustive)
    pipeline_run_id = str(uuid.uuid4())
    round_ids = {}
    for label in LABELS:
        round_ids[label] = str(uuid.uuid4())
        connection.execute(INSERT_ROUND, (
            round_ids[label], project["project_id"], project["version_id"], pipeline_run_id, label,
            "PENDING", Jsonb(pinned), None, None, None, datetime.now(UTC), None))
    connection.commit()

    try:
        manifest = run_pipeline(config, work)
    except Exception as error:  # noqa: BLE001 - a failed run is recorded, not lost
        for label in LABELS:
            connection.execute(FINISH_ROUND, ("FAILED", None,
                                              Jsonb({"error_type": type(error).__name__, "error": str(error)}),
                                              datetime.now(UTC), round_ids[label]))
        connection.commit()
        raise

    for status in manifest["rounds"]:
        label = status["label"]
        metrics_path = output / "rounds" / label.lower() / "metrics.json"
        metrics = json.loads(metrics_path.read_text(encoding="utf-8")) if metrics_path.is_file() else None
        failure = {"error": status["error"]} if status.get("error") else None
        pins = {"goldSha256": manifest["gold"]["sha256"], "schema": manifest["schema"],
                "request": manifest["request"], "guidanceSha256": status.get("guidance_sha256"),
                "documents": status.get("documents")}
        connection.execute(FINISH_ROUND, (
            status["status"], Jsonb(metrics) if metrics is not None else None,
            Jsonb(failure) if failure else None, datetime.now(UTC), round_ids[label]))
    connection.commit()
    return pipeline_run_id


def once(*, database_url: str, eval_root: Path, providers: dict, strategy: str = "article",
         identity=None, exhaustive: bool = True, limit: int | None = None) -> list[str]:
    """Evaluate every ready Project Context that has no round for its current
    gold version yet. Returns the pipeline run ids it started."""
    import psycopg
    from psycopg.rows import dict_row

    started = []
    with psycopg.connect(database_url, row_factory=dict_row) as connection:
        for project in connection.execute(READY_PROJECTS).fetchall():
            if limit is not None and len(started) >= limit:
                break
            if connection.execute(ALREADY_EVALUATED,
                                  (project["project_id"], project["version_id"])).fetchone():
                continue
            documents = connection.execute(PROJECT_DOCUMENTS, (project["project_id"],)).fetchall()
            if not documents:
                continue
            started.append(evaluate_project(connection, project, documents, eval_root=eval_root,
                                            providers=providers, strategy=strategy, identity=identity,
                                            exhaustive=exhaustive))
    return started


def main() -> None:
    import argparse
    import os
    import time

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-url", default=os.environ.get("EVAL_WATCHER_DATABASE_URL")
                        or os.environ.get("DATABASE_URL"))
    parser.add_argument("--eval-root", type=Path,
                        default=Path(os.environ.get("FREE_EVAL_ROOT", "eval-out/watch")))
    parser.add_argument("--strategy", default=os.environ.get("FREE_EVAL_STRATEGY", "article"),
                        choices=["article", "catalog"])
    parser.add_argument("--identity", action="append")
    parser.add_argument("--not-exhaustive", action="store_true")
    parser.add_argument("--interval", type=float, default=float(os.environ.get("FREE_EVAL_INTERVAL", "60")))
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    if not args.database_url:
        parser.error("set EVAL_WATCHER_DATABASE_URL (or DATABASE_URL) to the application database")
    providers = providers_from_env(os.environ)
    while True:
        started = once(database_url=args.database_url, eval_root=args.eval_root, providers=providers,
                       strategy=args.strategy, identity=args.identity, exhaustive=not args.not_exhaustive)
        for run_id in started:
            print(f"evaluated {run_id}", flush=True)
        if args.once:
            return
        time.sleep(args.interval)


if __name__ == "__main__":
    main()

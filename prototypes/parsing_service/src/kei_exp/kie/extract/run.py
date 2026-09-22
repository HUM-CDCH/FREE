"""One extraction: the request, the composition of the stages into the artifact, and its publication.

The artifact is one JSON file under the run directory. It carries everything a client needs to trust and use
it: the parse generation and digest it was read from, the schema and options, the model and prompt version,
and the fingerprint over all of those (so a repeat with the same inputs is the same extraction and a changed
schema is another one, with no OCR rerun either way), the records, their evidence links into the canonical
result, what stayed ungrounded, the issues, and every model call's cost. Document-level fields (`valueSource:
document`) are extracted but not verified in this slice, since grounding them would need the whole source's
labels: the artifact names them under `unverified`, and `complete` speaks for record values only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from kei_exp.canonical import canonical_json
from kei_exp.files import publish
from kei_exp.kie.extract.evidence import load
from kei_exp.kie.extract.llm import Chat, OpenAIChat
from kei_exp.kie.extract.schema import Schema
from kei_exp.kie.extract.stages import (
    Call,
    Issue,
    Link,
    discover,
    extract_document,
    extract_record,
    extract_records,
    leaves,
    merge,
    verify,
)

EXTRACTION_VERSION = 1
PROMPT_VERSION = 2  # 2: extraction calls turn model reasoning off


class Options(BaseModel):
    model_config = ConfigDict(extra="forbid")
    strategy: Literal["catalog", "article"] = "catalog"  # catalog: discover records first; article: one call
    model: str | None = None                             # the server's model id; the deployment default when None
    discovery_chars: int = Field(default=48_000, ge=1_000)  # text per discovery call
    record_chars: int = Field(default=24_000, ge=1_000)     # text per record or document call


class ExtractRequest(BaseModel):
    """The body of POST /api/runs/{run_id}/extract."""
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    schema_: Schema = Field(alias="schema")
    options: Options = Field(default_factory=Options)


class StaleGeneration(ValueError):
    """The run's result is no longer the parse generation this extraction was admitted against.

    Terminal, not transient: another attempt reads the same rewritten result, and the passage identities this
    extraction would publish (`p{page}_s{index}`, valid only within one generation) would not resolve in the
    generation its client was told about. The client resubmits against the generation that is there now.
    """


def fingerprint(result: dict, request: ExtractRequest, model: str) -> str:
    """Over the parse generation and digest, the schema, the options, the model and the prompt version."""
    return hashlib.sha256(canonical_json({
        "generation": result["generation"], "digest": result["digest"],
        "schema": request.schema_.model_dump(by_alias=True, exclude_none=True),
        "options": request.options.model_dump(), "model": model, "prompt_version": PROMPT_VERSION,
    })).hexdigest()


def extract(run_dir: Path, request: ExtractRequest, chat: Chat, *, generation: str | None = None) -> dict:
    """The artifact for `request` over the run's canonical result, from the stages in order.

    `generation` is the parse the caller admitted this extraction against, when it had one: the result on disk
    must still be that generation, or nothing is extracted (`StaleGeneration`). The check is before the first
    model call, so a run re-converted while the extraction sat in the queue costs no tokens. The CLI passes
    none: it extracts from whatever the directory holds at the moment it is run.
    """
    evidence = load(run_dir)
    if generation is not None and evidence.generation != generation:
        raise StaleGeneration(
            f"the run's result is generation {evidence.generation!r}, not the {generation!r} this extraction was "
            f"admitted against: it was re-converted in between, so submit this extraction again against the "
            f"generation that is there now")
    schema = request.schema_
    options = request.options
    started = datetime.now(UTC).isoformat()
    clock = time.monotonic()
    calls: list[Call] = []
    issues: list[Issue] = []
    document, document_calls, document_issues = extract_document(evidence, schema, chat, budget=options.record_chars)
    calls += document_calls
    issues += document_issues
    if options.strategy == "article":
        found, call, record_issues = extract_records(evidence.passages, schema, chat, budget=options.record_chars)
        calls.append(call)
        issues += record_issues
        slices = [(list(evidence.passages), fields) for fields in found]
    else:
        groups, discovery_calls, discovery_issues = discover(evidence, schema, chat, budget=options.discovery_chars)
        calls += discovery_calls
        issues += discovery_issues
        slices = []
        for number, group in enumerate(groups):
            fields, call, record_issues = extract_record(group, schema, chat, budget=options.record_chars,
                                                         record=number)
            calls.append(call)
            issues += record_issues
            slices.append((group, fields))
    records: list[dict] = []
    links: list[Link] = []
    for number, (group, fields) in enumerate(slices):
        found_links, grounding_calls, grounding_issues = verify(group, fields, schema, chat, record=number)
        links += found_links
        calls += grounding_calls
        issues += grounding_issues
        records.append(merge(fields, document, evidence.source_name, schema))
    grounded = {link.path for link in links}
    ungrounded = [["records", number, *path] for number, (_, fields) in enumerate(slices)
                  for path, _ in leaves(fields) if ("records", number, *path) not in grounded]
    result = {
        "extraction_version": EXTRACTION_VERSION, "run_id": evidence.run_id, "generation": evidence.generation,
        "digest": evidence.digest, "strategy": options.strategy, "model": chat.model, "prompt_version": PROMPT_VERSION,
        "schema": schema.model_dump(by_alias=True, exclude_none=True), "options": options.model_dump(),
        "started": started, "seconds": round(time.monotonic() - clock, 3),
        "complete": all(call.ok for call in calls) and not ungrounded and not issues,
        "records": records,
        "evidence": [{**asdict(link), "path": list(link.path), "bbox_pt": list(link.bbox_pt)} for link in links],
        "ungrounded": ungrounded,
        "unverified": [node.name for node in schema.document_nodes],
        "issues": [{**asdict(issue), "path": list(issue.path) if issue.path else None} for issue in issues],
        "calls": [asdict(call) for call in calls],
        "tokens": {"input": _total(call.input_tokens for call in calls),
                   "output": _total(call.output_tokens for call in calls)},
    }
    result["fingerprint"] = fingerprint(result, request, chat.model)
    return result


def _total(values) -> int | None:
    known = [value for value in values if value is not None]
    return sum(known) if known else None


def publish_extraction(run_dir: Path, extraction_id: str, result: dict) -> Path:
    """`extractions/<id>/result.json` under the run, renamed into place."""
    directory = run_dir / "extractions" / extraction_id
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / "result.json"
    with publish(target) as part:
        part.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return target


def main(argv: list[str] | None = None) -> int:
    """`uv run python -m kei_exp.kie.extract.run RUN_DIR SCHEMA.json [--strategy article] [--model m]`: one
    extraction against the configured server, printed as JSON; no PostgreSQL involved."""
    parser = argparse.ArgumentParser(description="extract structured records from a finished parse run")
    parser.add_argument("run_dir", type=Path)
    parser.add_argument("schema", type=Path, help="a FREE schema definition (recordDescription, schemaNodes)")
    parser.add_argument("--strategy", choices=["catalog", "article"], default="catalog")
    parser.add_argument("--model", default=None)
    args = parser.parse_args(argv)
    request = ExtractRequest.model_validate({"schema": json.loads(args.schema.read_text(encoding="utf-8")),
                                             "options": {"strategy": args.strategy, "model": args.model}})
    chat = OpenAIChat(model=request.options.model) if request.options.model else OpenAIChat()
    json.dump(extract(args.run_dir, request, chat), sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())

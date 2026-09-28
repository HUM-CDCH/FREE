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
from collections.abc import Callable
from dataclasses import asdict, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from kei_exp.canonical import canonical_json
from kei_exp.files import publish
from kei_exp.kie.extract import grounded
from kei_exp.kie.extract import models as extraction_models
from kei_exp.kie.extract.article import extract_records, source_contexts
from kei_exp.kie.extract.contexts import GROUPING_VERSION, Context, reconcile_values
from kei_exp.kie.extract.evidence import load
from kei_exp.kie.extract.grounded import CatalogOptions
from kei_exp.kie.extract.llm import Chat
from kei_exp.kie.extract.models import Router, as_router, chats_for
from kei_exp.kie.extract.method import ArticleOptions, LimitedCounter
from kei_exp.kie.extract.rendering import RENDERING_VERSION
from kei_exp.kie.extract.schema import Schema
from kei_exp.kie.extract.selection import VERSION as SELECTION_VERSION
from kei_exp.kie.extract.spans import VERSION as SPAN_GROUNDING_VERSION
from kei_exp.kie.extract.stages import (
    Call,
    Issue,
    Link,
    discover,
    extract_document,
    extract_record,
    leaves,
    merge,
    verify,
)
from kei_exp.kie.extract.tokens import BudgetUnavailable, counter_for
from kei_exp.kie.recipe import load_recipe
from kei_exp.kie.segmentation import obtain

EXTRACTION_VERSION = 1
PROMPT_VERSION = 12  # Lossless source-string decoding and coherent exact quoted grounding.


class Options(BaseModel):
    model_config = ConfigDict(extra="forbid")
    strategy: Literal["catalog", "article"] = "catalog"
    models: dict[str, str] | None = None  # role (fields, reasoning) -> extraction model key; deployment defaults
    discovery_chars: int = Field(default=48_000, ge=1_000)  # text per discovery call
    record_chars: int = Field(default=24_000, ge=1_000)     # generic Catalog text/grounding cap; Article uses tokens
    catalog: CatalogOptions | None = None  # a recipe: structural segmentation and grounded result version 2
    article: ArticleOptions | None = None

    @model_validator(mode="after")
    def _models_are_served(self) -> Options:
        extraction_models.check(self.models or {})  # an unservable route is refused before any model call
        return self

    @model_validator(mode="after")
    def _recipe_is_known(self) -> Options:
        if self.article is not None and self.strategy != "article":
            raise ValueError("options.article applies to the article strategy only")
        if self.catalog is not None:
            if self.strategy != "catalog":
                raise ValueError("options.catalog applies to the catalog strategy only")
            load_recipe(self.catalog.recipe)  # an unknown reference is refused before any model call
        return self

    def dumped(self) -> dict:
        """The options as the artifact and the fingerprint record them; no `catalog` key on the version 1 path."""
        result = self.model_dump(exclude={name for name in ("catalog", "article") if getattr(self, name) is None})
        if self.catalog is not None and self.catalog.factors is None:
            result["catalog"].pop("factors")
        return result


class ExtractRequest(BaseModel):
    """The `request` of the `extract` workflow's input (`workflows.contracts.ExtractInput`), and the CLI's."""
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    schema_: Schema = Field(alias="schema")
    options: Options = Field(default_factory=Options)

    @model_validator(mode="after")
    def _identity_fields_exist(self):
        if self.options.article is not None:
            from kei_exp.kie.extract.schema import SCALAR_JSON
            scalar = {node.name for node in self.schema_.record_nodes if node.type in SCALAR_JSON}
            unknown = set(self.options.article.identity_fields) - scalar
            if unknown:
                raise ValueError(f"identity_fields must be scalar record fields: {sorted(unknown)}")
        return self


class StaleGeneration(ValueError):
    """The run's result is no longer the parse generation this extraction was admitted against.

    Terminal, not transient: another attempt reads the same rewritten result, and the passage identities this
    extraction would publish (`p{page}_s{index}`, valid only within one generation) would not resolve in the
    generation its client was told about. The client resubmits against the generation that is there now.
    """


def fingerprint(result: dict, request: ExtractRequest, model: dict) -> str:
    """Over the parse generation and digest, the schema, the options, the model per role and the prompt version."""
    return hashlib.sha256(canonical_json({
        "generation": result["generation"], "digest": result["digest"],
        "schema": request.schema_.model_dump(by_alias=True, exclude_none=True),
        "options": request.options.dumped(), "model": model, "prompt_version": PROMPT_VERSION,
        **({"method_version": 1} if request.options.article is not None else {}),
        **({"rendering_version": RENDERING_VERSION} if request.options.article is not None
           and request.options.article.rendering is not None else {}),
        **({"grouping_version": GROUPING_VERSION} if request.options.article is not None
           and request.options.article.grouping is not None else {}),
        **({"selection_version": SELECTION_VERSION}
           if request.options.article is not None and request.options.article.selection is not None else {}),
        **({"span_grounding_version": SPAN_GROUNDING_VERSION}
           if request.options.article is not None and request.options.article.grounding == "spans" else {}),
    })).hexdigest()


def extract(run_dir: Path, request: ExtractRequest, chat: Chat | Router, *, generation: str | None = None,
            counter=None, chunks: int = 1, before_entry: Callable[[], None] | None = None) -> dict:
    """The artifact for `request` over the run's canonical result, from the stages in order.

    `generation` is the parse the caller admitted this extraction against, when it had one: the result on disk
    must still be that generation, or nothing is extracted (`StaleGeneration`). The check is before the first
    model call, so a run re-converted while the extraction sat in the queue costs no tokens. The CLI passes
    none: it extracts from whatever the directory holds at the moment it is run.

    `before_entry` is a hook whose error ends the extraction (the worker's cooperative cancellation). A recipe's
    grounded Catalog (`grounded.extract_grounded`) calls it before every entry, and runs its entries in `chunks`
    parallel contiguous chunks. The version 1 Catalog calls it before each discovery call, before each record's
    extraction and verification; Article, before inventory, each record call and each record's verification.
    Both paths also check before each grounding batch, run unsplit and ignore `chunks`.
    """
    evidence = load(run_dir)
    if generation is not None and evidence.generation != generation:
        raise StaleGeneration(
            f"the run's result is generation {evidence.generation!r}, not the {generation!r} this extraction was "
            f"admitted against: it was re-converted in between, so submit this extraction again against the "
            f"generation that is there now")
    schema = request.schema_
    options = request.options
    chat = as_router(chat)
    if options.catalog is not None:
        return _grounded(run_dir, evidence, request, chat, counter, chunks=chunks, before_entry=before_entry)
    check = before_entry or _unchecked
    started = datetime.now(UTC).isoformat()
    clock = time.monotonic()
    calls: list[Call] = []
    issues: list[Issue] = []
    article = options.strategy == "article"
    method = options.article
    contexts = [Context(evidence.passages)]
    identities = []
    if article:
        if counter is None:
            counters = {id(client): counter_for(client) for client in chat.chats().values()}
            counter = {role: counters[id(client)] for role, client in chat.chats().items()}
        for role in ("fields", "reasoning"):
            if type(counter[role].context_tokens) is not int or counter[role].context_tokens <= 0:
                raise BudgetUnavailable(f"Article requires the {role} endpoint's context size")
        if method is not None and method.context == "bounded":
            counter = {role: LimitedCounter(each, method.context_tokens) for role, each in counter.items()}
            contexts = source_contexts(evidence.passages, schema, method, counter["reasoning"], check)
    documents = []
    for context in contexts:
        if schema.document_nodes:
            check()
        document, document_calls, document_issues = extract_document(replace(evidence, passages=context.passages),
            schema, chat, budget=options.record_chars, counter=counter["fields"] if article else None,
            structured=method is not None and method.rendering == "structured")
        documents.append(document)
        calls += document_calls
        issues += document_issues
    document, document_conflicts = reconcile_values(documents) if len(documents) > 1 else (documents[0], [])
    issues += [Issue("conflicting_document_values", json.dumps(conflict, ensure_ascii=False))
               for conflict in document_conflicts]
    if article:
        extracted = extract_records(evidence.passages, schema, chat, counters=counter,
                                    record_chars=options.record_chars, check=check, method=method, contexts=contexts)
        identities, slices = extracted.identities, extracted.slices
        calls += extracted.calls
        issues += extracted.issues
    else:  # discovery checks before each of its calls
        groups, discovery_calls, discovery_issues = discover(evidence, schema, chat, budget=options.discovery_chars,
                                                            before_call=check)
        calls += discovery_calls
        issues += discovery_issues
        slices = []
        for number, group in enumerate(groups):
            check()
            fields, record_calls, record_issues = extract_record(group, schema, chat, budget=options.record_chars,
                                                                 record=number)
            calls += record_calls
            issues += record_issues
            slices.append((group, fields))
    records: list[dict] = []
    links: list[Link] = []
    proofs: list[dict] = []
    for number, (group, fields) in enumerate(slices):
        check()
        verification_groups = [c.passages for c in contexts] if article else [group]
        if method is not None and method.grounding == "off":
            verification_groups = []
        for verification_group in verification_groups:
            found_links, grounding_calls, grounding_issues = verify(verification_group, fields, schema, chat,
                record=number, budget=options.record_chars, counter=counter["reasoning"] if article else None,
                record_context=(identities[number]["label"] + "\n" + json.dumps(identities[number]["identity"],
                    ensure_ascii=False)) if article else None,
                before_call=check, quoted=method is not None and method.grounding == "quoted", proofs=proofs,
                span_ids=method is not None and method.grounding == "spans",
                skip_paths=frozenset(link.path for link in links)
                    if method is not None and method.grounding_schedule == "unresolved" else frozenset())
            # Retain the first support in canonical order for each path; all calls remain auditable.
            known = {link.path for link in links}
            links += [link for link in found_links if link.path not in known]
            calls += grounding_calls
            issues += grounding_issues
        records.append(merge(fields, document, evidence.source_name, schema))
    grounded = {link.path for link in links}
    ungrounded = [["records", number, *path] for number, (_, fields) in enumerate(slices)
                  for path, _ in leaves(fields) if ("records", number, *path) not in grounded]
    result = {
        "extraction_version": EXTRACTION_VERSION, "run_id": evidence.run_id, "generation": evidence.generation,
        "digest": evidence.digest, "strategy": options.strategy, "model": chat.model, "models": chat.models,
        "prompt_version": PROMPT_VERSION,
        "schema": schema.model_dump(by_alias=True, exclude_none=True), "options": options.dumped(),
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
    result["fingerprint"] = fingerprint(result, request, chat.models)
    if article:
        result["inventory"] = identities
    if method is not None:
        result["method_version"] = 1
        result["contexts"] = [context.dumped() for context in contexts]
        result["value_contexts"] = [[context.dumped() for context in group] for group in extracted.value_contexts]
        result["quoted_support"] = proofs
        if method.grounding == "spans":
            result["span_grounding_version"] = SPAN_GROUNDING_VERSION
        if method.rendering is not None:
            result["rendering_version"] = RENDERING_VERSION
        if method.grouping is not None:
            result["grouping_version"] = GROUPING_VERSION
        if method.selection is not None:
            result["selection_version"] = SELECTION_VERSION
            result["selections"] = extracted.selections
        result["conflicts"] = {"document": document_conflicts, "records": extracted.conflicts}
        result["completion"] = {
            "processing": all(call.ok for call in calls),
            "source_coverage": "attempted" if all(call.ok for call in calls if call.stage == "inventory") else "partial",
            "grounding": "disabled" if method.grounding == "off" else ("complete" if not ungrounded else "partial"),
            "record_recall": "unmeasured", "document_fields": "unverified" if schema.document_nodes else "not_applicable"}
        # Successful calls and linked returned fields cannot establish inventory recall.
        result["complete"] = False
    return result


def _grounded(run_dir: Path, evidence, request: ExtractRequest, chat: Router, counter, *, chunks: int = 1,
              before_entry: Callable[[], None] | None = None) -> dict:
    """The recipe path: the proven segmentation (computed and published when absent), a verified token counter for
    each serving endpoint (one per distinct chat), and the version 2 artifact."""
    options = request.options
    recipe = load_recipe(options.catalog.recipe)
    segmentation = obtain(run_dir, evidence, recipe)
    if counter is None:
        counters = {id(client): counter_for(client) for client in chat.chats().values()}
        counter = {role: counters[id(client)] for role, client in chat.chats().items()}
    body = grounded.extract_grounded(evidence, request.schema_, recipe, options.catalog, segmentation, chat, counter,
                                     chunks=chunks, before_entry=before_entry)
    result = {"run_id": evidence.run_id, "generation": evidence.generation, "digest": evidence.digest,
              "model": chat.model, "models": chat.models,
              "schema": request.schema_.model_dump(by_alias=True, exclude_none=True), "options": options.dumped(),
              **body}
    result["fingerprint"] = grounded.fingerprint(body, evidence.generation, evidence.digest, request.schema_,
                                                 options.dumped(), chat.models)
    return result


def _unchecked() -> None:
    """No cancellation hook: the CLI and direct callers run to the end."""


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
    """`uv run python -m kei_exp.kie.extract.run RUN_DIR SCHEMA.json [--strategy article] [--fields KEY]
    [--reasoning KEY]`: one extraction against the configured servers, printed as JSON; no PostgreSQL involved."""
    parser = argparse.ArgumentParser(description="extract structured records from a finished parse run")
    parser.add_argument("run_dir", type=Path)
    parser.add_argument("schema", type=Path, help="a FREE schema definition (recordDescription, schemaNodes)")
    parser.add_argument("--strategy", choices=["catalog", "article"], default="catalog")
    for role in ("fields", "reasoning"):
        parser.add_argument(f"--{role}", default=None, metavar="KEY",
                            help=f"extraction model for the {role} role (default: the deployment's)")
    args = parser.parse_args(argv)
    chosen = {role: key for role in ("fields", "reasoning") if (key := getattr(args, role))}
    request = ExtractRequest.model_validate({"schema": json.loads(args.schema.read_text(encoding="utf-8")),
                                             "options": {"strategy": args.strategy, "models": chosen or None}})
    json.dump(extract(args.run_dir, request, chats_for(request.options)), sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())

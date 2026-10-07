"""One extraction: the request and the choice of the Extraction Strategy's implementation.

The artifact carries everything a client needs to trust and use it: the parse generation and digest it was read from, the schema and options, the model and prompt version,
and the fingerprint over all of those (so a repeat with the same inputs is the same extraction and a changed
schema is another one, with no OCR rerun either way), the records, their evidence links into the canonical
result, what stayed ungrounded, the issues, and every model call's cost.

Every implementation has one call shape: the run directory, the evidence read from it, the validated request and a
router, keyword-only `counter`, `chunks` and `before_entry`, returning the finished artifact. The unified Catalog's
is `unified.extract` (version 3, `options.unified`); the legacy recipe Catalog's is `grounded.extract`, Article's `article.extract` and the legacy version 1
Catalog's `catalog.extract`; the last two assemble their version 1 artifact in `assembly.py`. `extract` chooses one
from the request's task scope (`ExtractRequest.record_scope`: Article for "document", a Catalog for "records") and
options, does not know what it does, and holds its result to the scope's cardinality (`dispatch`); no implementation
imports this module. Durable execution (`workflows/durable_extract.py`) calls `dispatch` over its pinned evidence;
nothing here publishes a file.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from kei_exp.kie.extract import article, catalog, grounded, unified
from kei_exp.kie.extract import models as extraction_models
from kei_exp.kie.extract.grounded import CatalogOptions
from kei_exp.kie.extract.llm import Chat
from kei_exp.kie.extract.method import ArticleOptions
from kei_exp.kie.extract.models import Router, as_router, chats_for
from kei_exp.kie.extract.schema import RecordScope, Schema
from kei_exp.kie.extract.unified import ITEM, UnifiedOptions
from kei_exp.kie.passages import Evidence, load
from kei_exp.kie.recipe import load_recipe

# The task scope each service strategy serves (`tests/fixtures/contracts/record-scope.json`, `service_strategies`):
# Article is one document-level object, a Catalog (generic, recipe or unified) a collection of records.
SERVICE_STRATEGIES: dict[str, RecordScope] = {"article": "document", "catalog": "records"}


class Options(BaseModel):
    model_config = ConfigDict(extra="forbid")
    strategy: Literal["catalog", "article"] = "catalog"
    models: dict[str, str] | None = None  # role (fields, reasoning) -> extraction model key; deployment defaults
    discovery_chars: int = Field(default=48_000, ge=1_000)  # text per discovery call
    record_chars: int = Field(default=24_000, ge=1_000)     # generic Catalog text/grounding cap; Article uses tokens
    catalog: CatalogOptions | None = None  # a recipe: structural segmentation and grounded result version 2
    article: ArticleOptions | None = None
    unified: UnifiedOptions | None = None  # the unified Catalog method: result version 3
    # The page the researcher was reading when the run started, one-based: the order the unified Catalog reads its
    # entries and Article its bounded value contexts in (nearest first), never which of them are read. Excluded from
    # `dumped()`, so the artifact and its fingerprint are those of the same request without it (design §4). Strict,
    # as UnifiedOptions is: "6" is no page. A page beyond the document orders the work from the document's end.
    start_page: int | None = Field(default=None, ge=1, strict=True)

    @model_validator(mode="after")
    def _models_are_served(self) -> Options:
        extraction_models.check(self.models or {})  # an unservable route is refused before any model call
        return self

    @model_validator(mode="after")
    def _unified_stands_alone(self) -> Options:
        """The unified method never reads the legacy character limits or a recipe: sent with it, they are refused
        rather than silently ignored."""
        if self.unified is not None and (self.strategy != "catalog" or self.catalog is not None
                                         or {"discovery_chars", "record_chars"} & self.model_fields_set):
            raise ValueError("options.unified applies to the catalog strategy only and takes no recipe "
                             "(options.catalog) and no character limits (discovery_chars, record_chars)")
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
        """The options as the artifact and the fingerprint record them: no `catalog` key on the version 1 path, and
        the unified method without the character limits it never reads. The start page is never recorded: it orders the
        work, not the result."""
        result = self.model_dump(exclude={name for name in ("catalog", "article", "unified")
                                          if getattr(self, name) is None} | {"start_page"})
        if self.catalog is not None and self.catalog.factors is None:
            result["catalog"].pop("factors")
        if self.unified is not None:  # it has no character limits to record
            del result["discovery_chars"], result["record_chars"]
            result["unified"] = self.unified.dumped()
        return result


class ExtractRequest(BaseModel):
    """The validated schema and options of a durable attempt's pinned selection, and the CLI's.

    A schema that declares `recordScope` fixes the strategy: "document" is Article's, "records" a Catalog's, and any
    other pairing is refused before a model call. One that declares none (the CLI, the research harness, a legacy
    caller) takes its scope from the task selection, `options.strategy`: never from its fields or a model's output."""
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    schema_: Schema = Field(alias="schema")
    options: Options = Field(default_factory=Options)

    @property
    def record_scope(self) -> RecordScope:
        """The effective task scope: the schema's declaration, or the one its strategy serves."""
        return self.schema_.record_scope or SERVICE_STRATEGIES[self.options.strategy]

    @model_validator(mode="after")
    def _strategy_serves_the_scope(self):
        declared = self.schema_.record_scope
        if declared is not None and SERVICE_STRATEGIES[self.options.strategy] != declared:
            raise ValueError(f"record_scope_mismatch: the schema's recordScope is {declared!r}, which the "
                             f"{self.options.strategy!r} strategy does not serve (it serves "
                             f"{SERVICE_STRATEGIES[self.options.strategy]!r})")
        return self

    @model_validator(mode="after")
    def _item_name_is_free(self):
        if self.options.unified is not None:
            lists = [node for top in self.schema_.nodes for node in _nodes(top) if node.type == "array"]
            if any(child.name == ITEM for node in lists for child in node.children or []):
                raise ValueError(f"the unified Catalog reserves the list field name {ITEM!r}")
        return self

    @model_validator(mode="after")
    def _identity_fields_exist(self):
        if self.options.article is not None:
            from kei_exp.kie.extract.schema import SCALAR_JSON
            scalar = {node.name for node in self.schema_.record_nodes if node.type in SCALAR_JSON}
            unknown = set(self.options.article.identity_fields) - scalar
            if unknown:
                raise ValueError(f"identity_fields must be scalar record fields: {sorted(unknown)}")
        return self

    @model_validator(mode="after")
    def _native_fields_are_supported(self):
        if extraction_models.routes(self.options)["fields"] == "gliformer":
            from kei_exp.kie.extract.gliformer import native_schema
            settings = self.options.unified
            if settings is None or self.record_scope != "records":
                raise ValueError("GLiFormer fields require unified Catalog extraction")
            if settings.headings is True or settings.verification is True:
                raise ValueError("GLiFormer pure extraction does not use heading context or value verification; "
                                 "leave these Auto or off")
            native_schema(self.schema_)
        return self


def _nodes(node):
    yield node
    for child in node.children or []:
        yield from _nodes(child)


class RecordScopeViolation(ValueError):
    """An implementation returned a record count its task scope forbids: a document-scope (Article) result is
    exactly one record. Never retained; its message starts `record_scope_violation:`."""



def extract(run_dir: Path, request: ExtractRequest, chat: Chat | Router, *, generation: str | None = None,
            counter=None, chunks: int = 1, before_entry: Callable[[], None] | None = None) -> dict:
    """The artifact for `request` over the run's canonical result, from the implementation its options choose (the
    CLI and the research harness; durable execution checks its pinned generation and calls `dispatch`).

    `generation`, when given, is the parse a replay was captured against: the result on disk must still be that
    generation, or nothing is extracted (a ValueError before the first model call). The CLI passes none and reads
    whatever the directory holds. `counter`, `chunks` and `before_entry` go to the implementation unchanged;
    `before_entry` is a hook whose error ends the extraction, and each implementation says where it calls it.
    """
    evidence = load(run_dir)
    if generation is not None and evidence.generation != generation:
        raise ValueError(f"the run's result is generation {evidence.generation!r}, not {generation!r}")
    return dispatch(run_dir, evidence, request, chat, counter=counter, chunks=chunks, before_entry=before_entry)


def dispatch(run_dir: Path | None, evidence: Evidence, request: ExtractRequest, chat: Chat | Router, *, counter=None,
             chunks: int = 1, before_entry: Callable[[], None] | None = None) -> dict:
    """The implementation the request's scope and options choose, over `evidence` already read, and its result held
    to the scope's cardinality: a document-scope result that is not exactly one record is a `RecordScopeViolation`,
    never an artifact; a records-scope result may hold any number, none included. Durable execution and the research
    harness call this with evidence already read (the harness's `run_dir` None: a recipe, which needs its run's
    segmentation, is refused by `grounded.extract`)."""
    chat = as_router(chat)
    scope = request.record_scope
    if scope == "document":
        result = article.extract(run_dir, evidence, request, chat, counter=counter, chunks=chunks,
                                 before_entry=before_entry)
    elif request.options.unified is not None:
        result = unified.extract(run_dir, evidence, request, chat, counter=counter, chunks=chunks,
                                 before_entry=before_entry)
    else:
        implementation = grounded.extract if request.options.catalog is not None else catalog.extract
        result = implementation(run_dir, evidence, request, chat, counter=counter, chunks=chunks,
                                before_entry=before_entry)
    if scope == "document" and len(result["records"]) != 1:
        raise RecordScopeViolation(f"record_scope_violation: a document-scope extraction is exactly one record, "
                                   f"and the {request.options.strategy!r} strategy returned {len(result['records'])}")
    return result



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

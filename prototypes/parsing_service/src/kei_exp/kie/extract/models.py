"""Which model serves which extraction call: the deployment's extraction models, a default per role, a run's choice.

Two roles split the calls. `fields` reads values off the source for a schema (a document's fields, a record's, a
grounded entry's candidates). `reasoning` decides over labelled text (where records start, which passage grounds a
value, which competing candidate is right). A template extractor such as NuExtract fills fields well but cannot
express the reasoning calls' replies (enums over thousands of passage labels), so it takes the fields role only.

Generative models use vLLM; GLiFormer has a native encoder service. The deployment sets the registry.
"""
from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, Protocol

from kei_exp.kie.extract import llm
from kei_exp.kie.extract.llm import Chat, NuExtractChat, OpenAIChat

if TYPE_CHECKING:
    from kei_exp.kie.extract.gliformer import GLiFormerFields

Role = Literal["fields", "reasoning"]
ROLES: tuple[Role, ...] = ("fields", "reasoning")
ROLE: dict[str, Role] = {"document": "fields", "record": "fields", "entry": "fields",
                         "discovery": "reasoning", "inventory": "reasoning", "grounding": "reasoning", "arbitration": "reasoning",
                         "verification": "reasoning"}


@dataclass(frozen=True)
class ExtractModel:
    key: str
    repo: str                          # the served model id
    url: str                           # chat completions URL, or the native service base URL
    adapter: Literal["instruct", "nuextract", "gliformer"]
    roles: frozenset[Role]

    def chat(self) -> Chat | GLiFormerFields:
        if self.adapter == "gliformer":
            from kei_exp.kie.extract.gliformer import GLiFormerFields
            return GLiFormerFields(url=self.url, model=self.repo)
        kind = OpenAIChat if self.adapter == "instruct" else NuExtractChat
        return kind(url=self.url, model=self.repo)


def registry(environ: Mapping[str, str]) -> dict[str, ExtractModel]:
    """The instruction model always; optional fields backends only where the deployment names their server."""
    models = {"instruct": ExtractModel("instruct", environ.get("KEI_EXTRACT_MODEL", llm.EXTRACT_MODEL),
                                       environ.get("KEI_EXTRACT_URL", llm.EXTRACT_URL), "instruct",
                                       frozenset(ROLES))}
    if environ.get("KEI_NUEXTRACT_URL"):
        models["nuextract"] = ExtractModel("nuextract", environ.get("KEI_NUEXTRACT_MODEL", llm.NUEXTRACT_MODEL),
                                           environ["KEI_NUEXTRACT_URL"], "nuextract", frozenset({"fields"}))
    if environ.get("KEI_GLIFORMER_URL"):
        models["gliformer"] = ExtractModel("gliformer", "knowledgator/gliformer-large-v1",
                                           environ["KEI_GLIFORMER_URL"], "gliformer", frozenset({"fields"}))
    return models


def defaults(models: Mapping[str, ExtractModel]) -> dict[Role, str]:
    return {"fields": "nuextract" if "nuextract" in models else "instruct", "reasoning": "instruct"}


EXTRACT_MODELS = registry(os.environ)
DEFAULTS = defaults(EXTRACT_MODELS)


def check(choice: Mapping[str, str]) -> None:
    """Refuse a run's choice the deployment cannot serve; called when the `extract` step validates its request, before any model call."""
    for role, key in choice.items():
        if role not in ROLES:
            raise ValueError(f"{role!r} is not an extraction role (fields, reasoning)")
        model = EXTRACT_MODELS.get(key)
        if model is None:
            raise ValueError(f"unknown extraction model {key!r}; this deployment serves {sorted(EXTRACT_MODELS)}")
        if role not in model.roles:
            raise ValueError(f"{key!r} cannot take the {role} role")


class Choice(Protocol):  # what routing reads of `run.Options`
    models: dict[str, str] | None


def routes(options: Choice) -> dict[Role, str]:
    """The registry key serving each role: the run's choice over the deployment's defaults."""
    return {**DEFAULTS, **(options.models or {})}


@dataclass(frozen=True)
class Router:
    """The backend each role uses. `model` names the fields model that read the values."""
    fields: Chat | GLiFormerFields
    reasoning: Chat
    runtime: object | None = None  # protocol-specific call adapter; legacy routing has none

    def for_stage(self, stage: str) -> Chat:
        role = ROLE.get(stage)
        if role is None:
            raise ValueError(f"stage {stage!r} has no role")
        client = self.fields if role == "fields" else self.reasoning
        if not hasattr(client, "complete"):
            raise ValueError("GLiFormer fields require the native unified Catalog path")
        return client

    @property
    def model(self) -> str:
        return self.fields.model

    @property
    def models(self) -> dict[Role, str]:
        return {"fields": self.fields.model, "reasoning": self.reasoning.model}

    def chats(self) -> dict[Role, Chat | GLiFormerFields]:
        return {"fields": self.fields, "reasoning": self.reasoning}


def as_router(chat: Chat | Router) -> Router:
    """One chat for every stage, or the router as it is."""
    return chat if isinstance(chat, Router) else Router(fields=chat, reasoning=chat)


def chats_for(options: Choice) -> Router:
    """The clients a run talks to: each role goes to its routed model, one client per server."""
    keys = routes(options)
    clients = {key: EXTRACT_MODELS[key].chat() for key in set(keys.values())}
    return Router(fields=clients[keys["fields"]], reasoning=clients[keys["reasoning"]])

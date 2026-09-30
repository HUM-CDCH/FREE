"""One validated experiment configuration: every behaviour-affecting choice, rejected before any model call when it
cannot run or would not test what it names.

A study varies whole sections (`chunking`, `evidence`, ...); a section is the unit of one-factor comparisons.
Options that need infrastructure this repository does not have (page images, coordinate output) are refused with the
prerequisite, never stubbed.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from experiments.extraction.manifest import digest
from kei_exp.canonical import canonical_json

HARNESS_VERSION = 1
PROMPT_VERSION = 1      # bump with any change to a prompt or reply schema in extract.py or evidence.py


class _Section(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Input(_Section):
    mode: Literal["text", "layout", "images", "text+images"] = "text"  # layout: structured markup with block ids


class Chunking(_Section):
    mode: Literal["whole", "fixed", "page", "structure"] = "whole"
    max_chars: int = Field(default=6000, ge=200)   # primary text of one chunk; whole ignores it
    overlap: int = Field(default=0, ge=0, le=4)    # preceding passages repeated as non-primary context, on top of max_chars


class Retrieval(_Section):
    mode: Literal["exhaustive", "lexical"] = "exhaustive"
    top_k: int = Field(default=3, ge=1)            # chunks kept before expansion
    expand: int = Field(default=0, ge=0, le=2)     # neighbouring chunks added on each side; measured apart


class Decompose(_Section):
    """Static groups of top-level fields. `max_fields` bounds a group's size; it is not output-budget-aware: reacting to
    a reply that outgrew its budget is `recovery.subdivide`, which acts on measured length failures."""
    mode: Literal["whole", "groups", "max_fields"] = "whole"
    groups: tuple[tuple[str, ...], ...] = ()       # explicit groups of top-level field names
    max_fields: int = Field(default=4, ge=1)


class Output(_Section):
    constraint: Literal["prompt", "schema"] = "schema"   # schema: provider-native structured output
    max_tokens: int = Field(default=2048, ge=64)


class Recovery(_Section):
    retries: int = Field(default=0, ge=0, le=3)    # further attempts of a failed task, each a new call with the same request
    subdivide: bool = False                        # halve a failed task's chunk or field group and retry the halves
    depth: int = Field(default=2, ge=1, le=4)


class Alignment(_Section):
    exact: bool = True                             # a quote is a raw substring
    normalized: bool = True                        # NFKC, case, whitespace, hyphenation (kei_exp locate)
    fuzzy: bool = False                            # bounded difflib alignment, always marked approximate
    fuzzy_threshold: float = Field(default=0.85, gt=0, le=1)
    fuzzy_growth: float = Field(default=1.25, ge=1)     # a fuzzy match spans at most this many times the quote
    disambiguate: Literal["none", "record"] = "none"    # record: prefer the occurrence in the record's own passages


class Evidence(_Section):
    mode: Literal["none", "ids", "quote", "coords"] = "none"
    alignment: Alignment = Alignment()


class Verification(_Section):
    model: bool = False                            # separate model-based support check of each cited value
    gate: Literal["off", "flag", "abstain"] = "off"


class Merge(_Section):
    keys: bool = True                              # match records on the case's declared key
    min_fields: int = Field(default=2, ge=1)       # fields two keyless records must share to be one record
    continuation: Literal["off", "flags"] = "off"  # join records a chunk boundary cut, on the model's own flags
    resolver: bool = False                         # a model chooses between conflicting scalars; alternatives stay


class Sampling(_Section):
    n: int = Field(default=1, ge=1, le=9)
    temperature: float = Field(default=0.0, ge=0, le=2)
    seed: int | None = None
    aggregate: Literal["strict", "majority"] = "strict"
    views: tuple[Literal["field", "document"], ...] = ("field",)


class Signals(_Section):
    verbalized: bool = False                       # the model states a 0-1 confidence per field
    top_logprobs: int = Field(default=0, ge=0, le=20)   # 0: token probabilities are not requested


class Budget(_Section):
    input_chars: int = Field(default=12000, ge=200)  # source text of one request; whole-document admission cap
    calls: int = Field(default=200, ge=1)            # fresh model calls one case may make
    tokens: int | None = Field(default=None, ge=1000)   # fresh input+output tokens one case may spend
    workers: int = Field(default=1, ge=1, le=16)


class Config(_Section):
    input: Input = Input()
    chunking: Chunking = Chunking()
    retrieval: Retrieval = Retrieval()
    decompose: Decompose = Decompose()
    output: Output = Output()
    recovery: Recovery = Recovery()
    evidence: Evidence = Evidence()
    verification: Verification = Verification()
    merge: Merge = Merge()
    sampling: Sampling = Sampling()
    signals: Signals = Signals()
    budget: Budget = Budget()

    @model_validator(mode="after")
    def coherent(self) -> Config:
        if self.input.mode in ("images", "text+images"):
            raise ValueError("page images need a served vision model and an adapter that sends image content; "
                             "llm.py sends text messages only")
        if self.evidence.mode == "coords":
            raise ValueError("coordinate output needs page images or rendered boxes in the input; not available")
        if self.evidence.mode == "ids" and self.input.mode != "layout":
            raise ValueError("segment ids are shown only by the layout input; evidence.mode=ids needs input.mode=layout")
        if self.evidence.mode == "none" and self.evidence.alignment != Alignment():
            raise ValueError("evidence.alignment resolves cited evidence; evidence.mode=none cites none, so it would change nothing")
        if self.verification.model and self.evidence.mode == "none":
            raise ValueError("model verification judges cited evidence; evidence.mode=none cites none")
        if self.verification.gate != "off" and self.evidence.mode == "none":
            raise ValueError("an evidence gate needs evidence.mode other than none")
        if self.retrieval.mode == "lexical" and self.chunking.mode == "whole":
            raise ValueError("retrieval chooses among chunks; chunking.mode=whole has one")
        if self.retrieval.expand and self.retrieval.mode != "lexical":
            raise ValueError("retrieval.expand applies to lexical retrieval only")
        if self.decompose.mode == "groups" and not self.decompose.groups:
            raise ValueError("decompose.mode=groups needs decompose.groups")
        if self.decompose.mode != "groups" and self.decompose.groups:
            raise ValueError("decompose.groups is used only with decompose.mode=groups")
        if self.sampling.n > 1 and self.sampling.temperature == 0:
            raise ValueError("samples at temperature 0 repeat one request; set sampling.temperature above 0")
        if "field" not in self.sampling.views or len(set(self.sampling.views)) != len(self.sampling.views):
            raise ValueError("sampling.views must be unique and include the field-guided view")
        if self.sampling.aggregate == "majority" and self.sampling.n < 3:
            raise ValueError("majority aggregation needs sampling.n of at least 3")
        if self.merge.continuation == "flags" and self.chunking.mode == "whole":
            raise ValueError("continuation flags describe chunk boundaries; chunking.mode=whole has none")
        if self.chunking.mode == "whole" and self.chunking.overlap:
            raise ValueError("chunking.overlap repeats text between chunks; chunking.mode=whole has one chunk")
        if self.chunking.mode != "whole" and self.chunking.max_chars > self.budget.input_chars:
            raise ValueError("chunking.max_chars exceeds budget.input_chars")
        return self

    def sha256(self) -> str:
        return digest(canonical_json({"harness_version": HARNESS_VERSION, "prompt_version": PROMPT_VERSION,
                                      "config": self.model_dump(mode="json")}))

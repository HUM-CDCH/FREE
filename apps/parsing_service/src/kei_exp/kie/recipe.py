"""The structural recipe of one catalogue family: the only place content rules live (grounded catalogue design §1).

A recipe has two parts with two digests. `structure` is everything segmentation reads (entry marker, headings,
section rules, label hints, glossary syntax, context window); a segmentation artifact binds only to it. `bindings`
say which approved-schema fields are filled from structure or verified through declared keys and positions; they
bind extraction, never segmentation. Recipes are versioned JSON files beside this module, addressed as `id@version`.
"""
from __future__ import annotations

import hashlib
import re
from functools import cache
from pathlib import Path
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from kei_exp.canonical import canonical_json

RECIPES = Path(__file__).resolve().parent / "recipes"
_REFERENCE = re.compile(r"(?a)([a-z0-9][a-z0-9-]*)@(\d+)\Z")

Region = Literal["catalogue", "glossary", "references", "prose", "index", "lists", "figures", "excluded"]


class RecipeError(ValueError):
    """A recipe reference that names no recipe of this service, or a recipe file that does not validate."""


class _Base(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


@cache
def pattern(source: str) -> re.Pattern[str]:
    """One compiled pattern per recipe string, shared by every stage that applies it."""
    return re.compile(source)


def _compiled(source: str, what: str, groups: tuple[str, ...] = ()) -> None:
    try:
        compiled = pattern(source)
    except re.error as error:
        raise ValueError(f"{what} {source!r} does not compile: {error}") from error
    for group in groups:
        if group not in compiled.groupindex:
            raise ValueError(f"{what} {source!r} has no named group {group!r}")


class HeadingRule(_Base):
    """A heading line: the whole trimmed line matches `pattern` within `max_chars`; group `value` is the inherited
    value and its evidence. A longer line never matches, so a sentence that begins like a heading changes nothing."""
    kind: str = Field(min_length=1)
    level: int = Field(ge=1)
    pattern: str
    max_chars: int = Field(gt=0)

    @model_validator(mode="after")
    def _has_value(self) -> Self:
        _compiled(self.pattern, f"heading {self.kind!r}", ("value",))
        return self


class SectionRule(_Base):
    """A whole line that switches the region; `restart` marks a section that numbers its entries from 1 again."""
    pattern: str
    region: Region
    numbering: Literal["continue", "restart"] = "continue"

    @model_validator(mode="after")
    def _compiles(self) -> Self:
        _compiled(self.pattern, "section")
        return self


class Labels(_Base):
    """Parser labels as hints: running heads and page numbers, figures, headings, list items."""
    furniture: list[str]
    figure: list[str]
    heading: list[str]
    list_item: list[str]


class Context(_Base):
    """The bounded context a block sees on either side: source lines, each clipped next to the boundary."""
    lines: int = Field(ge=0)
    max_chars: int = Field(gt=0)


class Structure(_Base):
    entry_marker: str                   # matched at the start of a trimmed line; groups `number`, optional `suffix`
    inline_marker: str                  # the same enumerator written mid-line (group `number`): paragraph context
    series_marker: str | None           # a prefixed series (`a 1.`) that would need a scoped identity (decision D4)
    numbering_max_gap: int = Field(ge=0)  # reporting only: a larger step is a `numbering_jump`, not a decision
    headings: list[HeadingRule]
    heading_hints: list[str]            # region words: a short whole segment naming one is an unclassified heading
    hint_max_chars: int = Field(gt=0)
    sections: list[SectionRule]
    labels: Labels
    glossary_line: str                  # groups `key`, `expansion`
    context: Context

    @model_validator(mode="after")
    def _patterns(self) -> Self:
        _compiled(self.entry_marker, "entry_marker", ("number",))
        _compiled(self.inline_marker, "inline_marker", ("number",))
        if self.series_marker is not None:
            _compiled(self.series_marker, "series_marker")
        for hint in self.heading_hints:
            _compiled(hint, "heading hint")
        _compiled(self.glossary_line, "glossary_line", ("key", "expansion"))
        levels: dict[str, int] = {}
        for rule in self.headings:
            if levels.setdefault(rule.kind, rule.level) != rule.level:
                raise ValueError(f"heading kind {rule.kind!r} is given two levels")
        return self

    @property
    def heading_levels(self) -> dict[str, int]:
        return {rule.kind: rule.level for rule in self.headings}


class Bindings(_Base):
    """Explicit schema-field bindings, by exact top-level field name. Inactive for a schema without that field."""
    entry_label: list[str]              # fields filled with the block's printed label
    headings: dict[str, list[str]]      # heading kind -> fields filled with the in-force heading's value
    keys: dict[str, list[str]]          # field -> key tokens a value of that field must follow
    positions: dict[str, str] = Field(default_factory=dict)  # field -> a structural position (none defined yet)


class Recipe(_Base):
    id: str = Field(min_length=1)
    version: int = Field(ge=1)
    description: str
    structure: Structure
    bindings: Bindings

    @model_validator(mode="after")
    def _bindings_name_structure(self) -> Self:
        for kind in self.bindings.headings:
            if kind not in self.structure.heading_levels:
                raise ValueError(f"bindings name heading kind {kind!r}, which the structure does not define")
        return self

    @property
    def structure_sha256(self) -> str:
        return hashlib.sha256(canonical_json(self.structure.model_dump(mode="json"))).hexdigest()

    @property
    def bindings_sha256(self) -> str:
        return hashlib.sha256(canonical_json(self.bindings.model_dump(mode="json"))).hexdigest()

    @property
    def reference(self) -> str:
        return f"{self.id}@{self.version}"


def load_recipe(reference: str) -> Recipe:
    """The recipe `id@version`, from this service's own recipe files; any other reference is refused."""
    match = _REFERENCE.match(reference)
    if match is None:
        raise RecipeError(f"{reference!r} is not a recipe reference of the form id@version")
    name, version = match.group(1), int(match.group(2))
    path = RECIPES / f"{name}.json"
    if not path.is_file():
        raise RecipeError(f"no recipe {name!r} in this service")
    try:
        recipe = Recipe.model_validate_json(path.read_bytes())
    except ValueError as error:
        raise RecipeError(f"{path.name} is not a valid recipe: {error}") from error
    if recipe.id != name or recipe.version != version:
        raise RecipeError(f"{path.name} is recipe {recipe.reference}, not {reference}")
    return recipe

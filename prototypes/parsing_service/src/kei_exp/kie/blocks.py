"""Entry blocks and what the recipe stages attach to them: spans, heading events, glossary entries and diagnostics.

Vocabulary: `CONTEXT.md`. Contracts: `docs/superpowers/specs/2026-09-14-kie-model-and-ingest-design.md`
(sections are cited as "spec 3.6" below) and the grounded catalogue design. These are the only model types the
recipe stages, the segmentation artifact and extraction use, and this module imports only `kie.primitives`, so none
of them loads the ingest artifact, the document or the run report. Whether a span lies inside real text is checked
where the text is: by `Document` over the assembled document, by the segmentation artifact over the canonical
passages.
"""

import re
from typing import Self

from pydantic import Field, model_validator

from kei_exp.kie.primitives import Count, Index, Name, Offset, _Base

# Only this form of entry label has a meaning: leading decimal digits, then the suffix (`31`, `31a`).
# `\Z`, not `$`: a trailing newline is OCR noise in the label, not an empty suffix.
_ENTRY_LABEL = re.compile(r"(?a)^(\d+)(.*)\Z", re.DOTALL)


class Span(_Base):
    """A half-open character range inside one segment's text, counted in code points (spec 3.5).

    Spans are positive, so an empty segment text is representable while no span can point into it.
    """

    segment_id: Name
    start: Offset
    end: Offset

    @model_validator(mode="after")
    def _positive(self) -> Self:
        if self.start >= self.end:
            raise ValueError(f"span [{self.start}, {self.end}) in {self.segment_id} is empty")
        return self


class HeadingEvent(_Base):
    """A heading anchored to the spans that are its evidence (spec 3.6, amended 2026-09-23 by the grounded catalogue
    design §10): `kind` is the recipe's name for its level (the German recipe keeps `bezirk` and `kreis`), `level` its
    depth, 1 the outermost. A heading clears every deeper level, which is invariant 6 in general form."""

    id: Name
    kind: Name
    level: Index
    text: str
    spans: list[Span] = Field(min_length=1)  # the inherited value's evidence; its position is its first span


class GlossaryEntry(_Base):
    """One abbreviation of the document's own glossary, with the spans of its key and its expansion."""

    key: Name
    expansion: Name
    key_span: Span
    expansion_span: Span


class Diagnostic(_Base):
    """Something a stage noticed and reports rather than corrects, with the source spans it concerns."""

    code: Name
    detail: str
    spans: list[Span] = Field(default_factory=list)
    block: str | None = None


class Block(_Base):
    """An entry block: the unit of extraction, one per entry (spec 3.6)."""

    id: Name
    entry_label: Name  # the number as printed: `31`, `31a`
    entry_no: Count  # the leading digits
    entry_suffix: str  # the rest: "" for `31`, "a" for `31a`
    primary_spans: list[Span] = Field(min_length=1)  # text the block owns; a block with no text is not evidence
    context_spans: list[Span] = Field(default_factory=list)  # text it only sees, and which may overlap anything
    continuation: bool  # crosses a column or a page boundary, and nothing else
    heading_events: list[str] = Field(default_factory=list)  # the ids in force at this block

    @model_validator(mode="after")
    def _label_matches_identity(self) -> Self:
        # The identity is the pair (CONTEXT.md invariant 7); the label is what makes it auditable against the book.
        match = _ENTRY_LABEL.match(self.entry_label)
        if match is None:
            raise ValueError(f"entry label {self.entry_label!r} does not start with decimal digits")
        digits, rest = match.groups()
        if int(digits) != self.entry_no or rest != self.entry_suffix:
            raise ValueError(f"entry label {self.entry_label!r} is not ({self.entry_no}, {self.entry_suffix!r})")
        return self

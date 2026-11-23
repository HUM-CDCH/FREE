"""Character ranges in canonical extraction evidence."""

from typing import Self

from pydantic import model_validator

from kei_exp.kie.primitives import Name, Offset, _Base


class Span(_Base):
    """A half-open character range inside one segment's text, counted in code points.

    See section 3.5 of the KIE data model and stage 0 (ingest) design.
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

# Repetition does not make Evidence uncertain

Status: accepted, 2026-11-11.

## Context

The repetition diagnostic `hits` had different units: the generic grounder
counted matching passages, cells or source spans in its current verification
request, while recipe and unified Catalog derived it from saved alternative
locations. It was calculated before a verifier chose Evidence. Neither a high
count nor a single match establishes whether that Evidence supports the field.
Unified alternative locations can also be confirmations of an accepted value.

Studio called all these counts other passages and used them to mark links
uncertain, filter them and put them first in the review queue. Restricting the
old count to the selected candidate normally gives zero or one; counting
printings within it would be a different diagnostic with another data contract.

## Decision

Retire production of `hits` in every extraction method and projection of
`lexicalHits` onto review links. Studio no longer derives uncertainty from
either counts or saved alternative locations. It retains the non-verbatim
hint, absence of Evidence, location precision, value marks, and the saved
alternative locations and their descriptive detail. Only a researcher's
decision approves a value.

Readers accept the historical count as an optional, validated field. Existing
producer snapshots and projected links remain readable without rewriting
them. Their presentation follows the new review policy. This supersedes only
the repetition-based hint retained by ADR 0029; it does not change how a
printing is located or marked.

New correction guidance omits the retired count from historical and new model
Evidence alike, alongside display locations. Already saved correction
examples and finalized captures remain immutable. New guidance can differ
from guidance created before this decision by the omitted count; this is not
a promise of byte-identical future prompts across the change.

## Consequences

No replacement counter, confidence score, approval state or model call is
introduced. Values, candidate selection, extraction and verification prompts,
fallback and workflow steps are unchanged. No method-version change or DBOS
patch is needed for this output-only removal and review policy; readers must
accept missing counts before producers omit them. No database migration or
reprocessing of saved results is required.

The count no longer prioritizes repeated values for review, including in
generic Catalog. Lack of the hint does not establish unique location or
correct attribution. Alternative locations remain informational; they are
not promoted into a substitute doubt signal.

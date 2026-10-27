# 0022: Schema edits run through Schema Suggestion

Date: 2026-10-27. Status: accepted; amends [0007](0007-two-explicit-model-capability-routes.md).

## Context

The schema panel's chat had two model paths. Before the first schema, its instructions lead a Schema Suggestion
request: the Schema Suggestion Route receives the source and returns a whole template. After it, "Describe a change
to the schema…" asked the Interaction Route for a per-field envelope keyed by opaque field IDs, with a bounded
repair call for missing or invalid entries. The two paths used different routes, prompts and output forms, so the
same researcher instruction behaved differently before and after generation.

## Decision

An edit proposal is a Schema Suggestion request. `proposeSchemaEdit` sends the base Schema Revision as a template,
its field notes and the researcher's change request as the instruction, with the source when the request names one
(excerpted as any Schema Suggestion input is), and receives the whole revised template. Studio compares it with the
base, level by level by field name, into the existing proposal: a field the revision drops is removed, a new one is
added, and a field left unmatched is renamed when it is its level's only unmatched pair or the revision has an
unmatched field of the same shape in its place. Unchanged fields are left out.

The `edit_schema` endpoint, the `proposeSchemaEdit` workflow and its single step, and the proposal contract are
unchanged, so review (Apply / Discard), recovery after a reload and the base-revision rule stay as they were. The
repair call is gone.

## Consequences

- The Interaction Route no longer runs model work of its own; it remains the default an unset Schema Suggestion
  Route follows.
- A template carries no scalar field notes, so a proposal never changes them; it can change a group's note.
- A change to the root record description, or to field order, is not proposed.
- A rename the comparison cannot pair is proposed as a removal and an addition.

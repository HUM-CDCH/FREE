# 0038: Article or Catalog is chosen before the template

Date: 2026-11-25. Status: accepted; amends [0024](0024-rail-chat-guides-to-extraction.md) and
[0032](0032-a-suggestion-is-saved-as-an-ordinary-extraction-schema.md).

## Context

The chat guided Generate template → Template ready → Choose Record Scope → Run. But the Record Scope says what one
record of the template is: under Article the whole document is the record and what repeats in it are arrays; under
Catalog each entry is a record and the fields describe one entry. Schema Suggestion was asked without knowing which,
so it guessed, and a template suggested as one document-wide record (an array of entries) was then run as a Catalog,
or the other way round. The choice came too late to shape the template it governs.

## Decision

- **The chat asks first.** Before the first template, while the host can generate one and no Record Scope is chosen,
  the chat's step is *Choose Record Scope* (Catalog or Article). Generate template follows, showing the strategy, with
  *Use Catalog/Article instead* beside it. A host with no Article/Catalog choice goes straight to Generate template.
- **The suggestion is made for it.** The generation request carries `record_scope`; the `suggestSchema` workflow's
  input keeps it (optional, so earlier inputs replay as before; the step sequence is unchanged) and every window and
  combination asks for it: under Article the record is the whole document, with what repeats as arrays; under Catalog
  the record is one of many, defined with where each begins. Without a scope the prompts are as before.
- **The first revision is saved with it.** The choice made before any revision is the one the first revision declares
  (as `pendingRecordScope` already allowed), so no second revision is appended for it. A generation restored after a
  reload is saved with the scope it was made for, which the model-operation listing returns.
- **A template without one still asks.** A template made before the choice (imported, or a batch suggestion) keeps
  the *Choose Record Scope* step after it, before Run.

## Consequences

- A first template takes one more click before generating, and never a revision for the scope afterwards.
- Changing the scope after generating keeps the template as it is: the header's selector saves the new scope, and
  Regenerate suggests a template for it.
- Batch Schema Suggestion is unchanged: it suggests for several documents before any scope, and its schema asks after.

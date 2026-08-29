## Context

The current `/api/edit_schema` asks for a partial name-based operation array. Non-arrays become `[]`, invalid entries disappear, unmatched names are no-ops, and the browser infers “No changes needed” from an empty visual diff. The same path cannot represent repeating scalar lists and manufactures incomplete ghost nodes for modified rows.

The decided replacement is one whole-proposal call. Existing fields are keyed by an opaque dotted display key that code compares but never parses; additions carry structural paths in the post-edit namespace. Chat may change names and types only.

## Goals / Non-Goals

**Goals:**

- Make the model response total and mechanically checkable over every existing `SchemaNode` path.
- Preserve node identity and complete node data through derivation, preview, and atomic application.
- Expose refusal, model failure, partial coverage, invalid entries, and unknown keys without interpreting researcher intent.
- Preserve descriptions, closed sets, and repeating scalar arrays according to the decided metadata rules.

**Non-Goals:**

- Per-change accept/reject state; that is the next sequential change.
- Chat editing of descriptions or allowed values.
- Move operations, durable history, or compatibility with `EditSchemaOp`.
- Provider-specific retry plumbing, `Output.object`, or configurable context windows.

## Decisions

### 1. Share the node model and enumerate paths from nodes

Move `SchemaNode`, conversion helpers, and a deterministic `enumerateFieldPaths` walk to `shared/schemaNode.ts`. Each entry carries the node id, structural path, and an opaque dotted key used only as a map key. Enumeration refuses duplicate keys before a model call. Raw templates are never flattened, so `_description` and closed-set members cannot become editable fields.

Repeating scalar lists use an array node with no `children`; conversion reads `["string"]` as `{ type: "array" }` and writes it back unchanged. Arrays with children remain repeating groups and allowed-value arrays keep their existing discriminator.

### 2. Compose totality at the API boundary

`api/_schema_edit.ts` validates submitted nodes, builds the expected key set, prompts for `{ fields, additions }`, validates each uniform `{ name, type, removed }` field entry, and classifies extra keys as `unknown-key`. Missing or invalid expected keys receive one scoped retry containing only those keys. The retry result is merged once; remaining issues accompany a partial `proposed` outcome.

A duplicate expected key returns `refused` without calling the model. Transport, parse, or wholly unusable output returns `failed`. A valid total or partial response returns `proposed`, including a legitimate zero-change proposal. These statuses report events, not inferred intent.

### 3. Keep model transport small and explicit

The schema-edit call uses `Output.json()` for every general provider, `reasoning: 'none'`, and the existing Interaction Route. `Output.object` is not used. A `finishReason === 'length'` result fails before JSON repair or parsing, preventing a repaired truncation from masquerading as missing keys.

### 4. Derive complete changes once

`src/schemaChanges.ts` turns the checked response into id-addressed `Change[]` records with complete `before` and `after` nodes. Existing entries resolve through their enumerated ids. The complete proposed existing tree is built first; additions then resolve their parent once against that tree using their post-edit structural path and receive a provisional id. Old-name aliases are not retained: after renaming `group` to `renamed`, `renamed/child` resolves and `group/child` is `unknown-key`.

Sanitisation happens before records are emitted. Closed-set fields keep type `string`; a requested retype is recorded as a conflict while an accompanying rename remains represented. Container-crossing retypes materialise or remove `children` and delete orphaned `description`/`allowedValues`, attaching a researcher-facing `note` but no `reason` when the change applies.

### 5. Review is a projection, not a source of truth

SchemaPanel stores the original nodes, derived changes, and materialised proposal. Rows are rendered directly from complete before/after records, one row per node id; modified ghost nodes are deleted. The header shows applied/unresolved/conflict counts, rowless missing/invalid/unknown-key diagnostics, and a conditional count of descriptions and allowed-value lists outside chat reach. Apply commits the complete proposal atomically; Discard commits nothing.

## Risks / Trade-offs

- **Opaque dotted keys can collide when sibling names duplicate.** → Refuse before the model call; the separate manual-edit uniqueness issue owns prevention.
- **A weak model may remain incomplete after one retry.** → Propose the validated subset and show factual issue counts; do not raise the retry budget silently.
- **Container retypes discard metadata or descendants.** → Perform the loss deterministically at derive time and show the attached note before Apply.
- **The endpoint is incompatible with existing clients.** → Remove the old decoder and `schemaOps.ts`; no compatibility layer is permitted.

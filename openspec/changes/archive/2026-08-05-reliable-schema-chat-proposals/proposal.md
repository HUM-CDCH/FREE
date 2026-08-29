## Why

Schema chat currently collapses malformed output, invalid operations, and unmatched edits into the same “No changes needed” message, while name-based operations can target the wrong field at depth. Researchers need one reviewable proposal whose coverage and failures are checked by code before the schema can change.

## What Changes

- **BREAKING** Replace the `name`/`parentName` operation list returned by `/api/edit_schema` with one structured response total over every existing field path plus separate additions.
- Validate the response against paths enumerated from `SchemaNode[]`, retry missing paths once, and return explicit `refused`, `failed`, or `proposed` outcomes with fixed `missing`, `invalid`, and `unknown-key` diagnostics.
- Derive id-addressed `Change[]` records containing complete `before` and `after` nodes, sanitising closed-set and container-crossing retypes before review.
- Review the whole proposal inline with summary counts, metadata reach disclosure, row-level unresolved/conflict notes, and atomic Apply/Discard.
- Delete the obsolete `EditSchemaOp`/`schemaOps.ts` path and modified-node ghost rows.
- Preserve scalar-list arrays as `type: 'array'` leaves and serialize them as `["string"]`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `schema-chat-edit`: Replace partial name-based operations with a total, validated whole-proposal workflow and explicit failure surfaces.
- `schema-inline-diff`: Render each changed node once from complete before/after records instead of manufacturing degraded ghost nodes.

## Impact

- Studio server schema-edit composition and tests under `prototypes/studio/api/`.
- Shared/browser schema-node enumeration and round-trip conversion.
- Browser API decoding, proposal derivation, SchemaPanel review state, and focused tests under `prototypes/studio/src/`.
- `/api/edit_schema` is intentionally incompatible with the previous operation-list response.

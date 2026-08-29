## 1. Shared schema-node contract

- [x] 1.1 Move `SchemaNode`, template conversion, and id allocation to `shared/schemaNode.ts`; update all imports without a compatibility re-export.
- [x] 1.2 Add `enumerateFieldPaths` and metadata counting from nodes, refusing duplicate opaque keys before model work.
- [x] 1.3 Add focused round-trip tests for `["string"]`, repeating groups, allowed values, descriptions excluded from enumeration, and duplicate keys.

## 2. Total schema-edit API

- [x] 2.1 Add `api/_schema_edit.ts` with strict node/request validation, one total `{ fields, additions }` response contract, fixed diagnostics, and one missing/invalid-key retry.
- [x] 2.2 Replace `editSchemaWithModel` with the minimal JSON transport using `Output.json()`, `reasoning: 'none'`, and a pre-parse `finishReason === 'length'` failure.
- [x] 2.3 Replace the `/api/edit_schema` form and response contract with submitted nodes and `refused`/`failed`/`proposed` outcomes; update browser decoding.
- [x] 2.4 Add focused model/composition/endpoint tests proving pre-call duplicate refusal, native and prompt route JSON output, truncation failure, non-object failure, invalid entries, unknown keys, scoped retry merge, partial proposal, and valid zero-change proposal.

## 3. Proposal derivation

- [x] 3.1 Add `src/schemaChanges.ts` to derive complete id-addressed before/after changes and materialise an atomic proposal from checked existing-field edits.
- [x] 3.2 Resolve additions once against the fully proposed post-edit namespace, mint provisional ids, and report unresolved paths as `unknown-key`.
- [x] 3.3 Sanitize closed-set and container-crossing retypes before records are emitted, including `children: []`, metadata deletion, conflict reasons, and applied notes.
- [x] 3.4 Add focused derivation tests for rename+retype as one record, `renamed/child` resolution versus `group/child` unknown-key, closed-set rename/retype, both container crossings, subtree removal, and mixed resolved/unresolved proposals.
- [x] 3.5 Delete `src/schemaOps.ts`, `EditSchemaOp`, and all obsolete callers after the derivation tests pass.

## 4. Atomic inline review

- [x] 4.1 Replace SchemaPanel pending op state with the original nodes, derived `Change[]`, and materialised proposal; render every changed node once with no ghost nodes.
- [x] 4.2 Add the review header counts, rowless coverage diagnostics, node conflict/unresolved annotations, and conditional metadata reach line.
- [x] 4.3 Keep Apply and Discard atomic, block a second request while pending, and report `refused`, `failed`, and zero-change `proposed` outcomes distinctly in chat.
- [x] 4.4 Add focused UI tests for mixed proposal counts, metadata disclosure, one-row rename+retype, atomic Apply, Discard, and blocked second submission.

## 5. Verification

- [x] 5.1 Run the focused Studio tests, TypeScript build, lint, OpenSpec validation, and `git diff --check`.
- [x] 5.2 Manually verify on the configured Interaction Route: a schema-wide rename, a rename plus nested addition under the renamed parent, a closed-set rename plus rejected retype, a container-crossing retype, a partial-coverage response surface, Apply, and Discard.

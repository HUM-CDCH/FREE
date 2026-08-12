## 1. Field enumeration

- [x] 1.1 In `prototypes/studio/api/_model.ts`, `flattenTemplateFields` returns `{ path: string, type: string }` entries (not just display strings).
- [x] 1.2 ~~Add a `chunkFields(fields, batchSize)` helper~~ — superseded: batching was replaced with one call per individual field (see design.md Decision 2). No chunking helper needed.

## 2. Structured per-field model call

- [x] 2.1 Add a fixed Zod schema `{ name: string, type: string, removed: boolean }` (`fieldEditResultSchema`) shared by every per-field call, instead of a dynamically-built per-batch schema.
- [x] 2.2 Add `editOneField(field, instruction)` that calls `generateText` with `output: Output.object({ schema: fieldEditResultSchema })` for exactly one field, including its dotted path for disambiguation.
- [x] 2.3 On Zod validation failing (or the call throwing) for a field, retry that field's call up to `FIELD_EDIT_ATTEMPTS` (2) times before throwing a clear per-field `RequestError` — never applies partial/invalid data.

## 3. Concurrent per-field orchestration

- [x] 3.1 Run one call per field concurrently via `runWithConcurrencyLimit(fields.map(...), MAX_CONCURRENT_FIELD_CALLS)` (cap: 6) rather than unbounded `Promise.all` or sequential per-field calls.
- [x] 3.2 Keep the existing free-form prompt/call for `add`-style new-field requests (`editNewFields`) separate from the per-field existing-field calls, run concurrently alongside them, and merge its results in afterward.

## 4. Convert results back to `EditSchemaOp[]`

- [x] 4.1 For each field (in original order, matched by array index to its call's result), diff the returned `name`/`type`/`removed` against the field's original value and emit `patch` (name/type changed), `remove` (`removed: true`), or no-op (unchanged) entries.
- [x] 4.2 Merge the diffed ops with the `add` ops from the new-field pass into the final `EditSchemaOp[]` returned by `editSchemaWithModel`, preserving the current function signature (`Promise<EditSchemaOp[]>`).
- [x] 4.3 Confirm `parentName` is populated correctly for nested fields so `schemaOps.ts`'s `matches()`/`mapNodes()` still resolve them unambiguously (no changes to `schemaOps.ts` itself expected).

## 5. Verification

- [x] 5.1 Run `tsc --noEmit` and `eslint` in `prototypes/studio` and confirm no errors.
- [x] 5.2 Tested via direct `POST /api/edit_schema` against the running dev server with a realistic 16-field template (2 nested) and "Translate all field names into Danish" — all 16 fields covered with correct translations (`titel`, `forfatter`, `sted`, `udgraver`, etc.), none left untouched. (An earlier attempt with 22 NATO-phonetic-alphabet placeholder field names like `field_bravo`/`field_hotel` only returned 6/22 ops — investigated and found to be a test-data artifact: many of those "words" are proper nouns/loanwords a model reasonably leaves untranslated, not a coverage bug. Re-ran with natural field names to confirm.) Note: verified the API response, not the SchemaPanel pending-diff card visually in a browser.
- [x] 5.3 Tested via the same 16-field endpoint with "Rename the title field to headline" — returned exactly one `patch` op for `title`, no unrelated fields touched.
- [ ] 5.4 Only `claude-code` could be exercised in this environment: `codex` CLI isn't installed here, and the configured Ollama host (`spark.cdch-dgxspark.lan.ku.dk`) isn't resolvable from this machine right now. Needs a manual check against `ollama` and/or `codex-cli` wherever those are actually reachable.
- [ ] 5.5 Update `openspec/specs/schema-chat-edit/spec.md` via `openspec archive` once this change is merged and validated.

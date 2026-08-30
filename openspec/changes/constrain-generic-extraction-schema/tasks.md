## 1. Schema derivation in `packages/extraction/src/schema.ts`

- [ ] 1.1 Add an exported function that converts `SchemaNode[]` into a Zod schema: scalar type mapping (`'string' | 'verbatim-string' | 'date'` → `z.string()`, `'number'` → `z.number()`, `'integer'` → `z.number().int()`, `'boolean'` → `z.boolean()`), `allowedValues` → `z.enum(...)`, `'array'` with `itemType` → `z.array(<scalar>)`, `'object' | 'array'` with `children` → nested `z.object({...}).strict()` (array-wrapped for `'array'`), every field `.nullable().optional()`.
- [ ] 1.2 Unit-test the conversion directly against representative `SchemaNode[]` shapes (flat scalars, nested object, array of scalars, array of objects, `allowedValues` enum, mixed missing/null tolerance) in the existing `schema.test.ts`.
- [ ] 1.3 Unit-test the round trip `templateToNodes(nodesToTemplate(nodes))` → new conversion, confirming a template produced by `nodesToTemplate` always derives a valid Zod schema.

## 2. Wire schema-constrained generation into `extractWithModel`

- [ ] 2.1 In `prototypes/studio/api/_model.ts`'s general-profile branch of `extractWithModel`, attempt `templateToNodes(extractionTemplate)` + the new conversion inside a `try/catch`; on success pass the resulting schema into `generateWithGenericJsonPrompt`.
- [ ] 2.2 Update `generateWithGenericJsonPrompt` to use `Output.object({ schema })` when a schema is supplied, replacing the current `target.jsonOutput === 'native' ? { output: Output.json() } : {}` conditional for that call (schema-based output supersedes the native/prompt split).
- [ ] 2.3 On derivation failure (step 2.1's catch), fall back to today's behavior unchanged (no `output` config beyond the existing native/prompt split).
- [ ] 2.4 Extend the existing `NoObjectGeneratedError` fallback (`generateWithGenericJsonPrompt`'s catch block) to also cover the schema-based call, returning `error.text` the same way it already does for `jsonOutput === 'native'`, so a provider/model that can't honor the schema degrades to raw text instead of throwing.

## 3. Tests

- [ ] 3.1 Add/extend `prototypes/studio/api/_model.test.ts` coverage: general-profile extraction call passes a derived schema to `Output.object()` when the template is convertible.
- [ ] 3.2 Add a regression test reproducing the original bug shape: a mocked general-profile model response that includes a schema-external key (e.g. `description`) is now rejected/excluded by schema-constrained generation rather than reaching `restoreSchemaNodeOrder`'s `Unexpected model key` throw — or, if the mock can't simulate provider-side constraint, at minimum assert the schema was correctly derived and passed for that template.
- [ ] 3.3 Add a test for the derivation-failure fallback path (template shape that `templateToNodes` can't convert) confirming extraction still proceeds via the unconstrained path.
- [ ] 3.4 Add a test for the `NoObjectGeneratedError` fallback under schema-based generation (extended condition from task 2.4).
- [ ] 3.5 Confirm `packages/extraction`'s existing NuExtract raw-prompt tests are untouched by this change (no new schema/`format` wiring reaches `generateWithNuExtractRawPrompt`).
- [ ] 3.6 If feasible, run/extend a `_model.live.test.ts`-style live check against the Anthropic and/or Claude Code connection actually configured in this environment (`claude-haiku-4-5` per the reported bug) to confirm the fix holds against a real provider, not only mocks.

## 4. Validation

- [ ] 4.1 Run the Studio test suite (`pnpm --filter studio test` or the repo-root equivalent) and confirm no regressions.
- [ ] 4.2 Manually reproduce the original failure (a CATALOG or Article extraction against the schema/document that previously produced `Unexpected model key: description` on Claude Haiku) and confirm it now succeeds with grounded Evidence instead of "No reviewable result".

## 1. Replay

- [x] 1.1 Preserve each addition's resolved parent id in its change record
- [x] 1.2 Replay accepted existing-node changes from the original schema without smuggling descendant edits
- [x] 1.3 Replay accepted additions by resolved parent id and recompute per-change outcomes
- [x] 1.4 Cover independent node decisions, parent rejection, and unresolved dependencies with focused tests

## 2. Review UI

- [x] 2.1 Initialise and maintain acceptance state by change id
- [x] 2.2 Render one acceptance control per changed row without changing proposal values
- [x] 2.3 Recompute review counts on each toggle and Apply only the accepted materialisable subset
- [x] 2.4 Cover stable rows, default acceptance, toggles, and subset Apply with component tests

## 3. Verification

- [x] 3.1 Run focused schema-change and SchemaPanel tests
- [x] 3.2 Run Studio lint, build, and full tests
- [x] 3.3 Validate the OpenSpec change and audit the final diff

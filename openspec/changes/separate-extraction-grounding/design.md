## Context

The current Studio flow gives NuExtract a canonical source projection labelled `E1`, `E2`, and so on, rewrites every Extraction Schema leaf to `{ value, anchor_id }`, then recursively replaces returned labels with parser-owned anchor IDs. On the six-page Ellekilde example this consumed 10,471 input and 8,970 output tokens, required tolerant JSON repair, omitted required citation members, and selected 29 known but inconsistent table-cell anchors. The values-only ablation returned all seven records with strict shape using 5,177 output tokens.

Parser-published `parsed_document.v2` anchors and their generation-scoped occurrences remain the sole Evidence authority. The change must not reintroduce `_evidence`, model-generated snippets or geometry, fuzzy matching, provider-specific behavior, or a compatibility path that preserves the combined contract.

## Goals / Non-Goals

**Goals:**

- Make value extraction and canonical Evidence grounding separate buffered model operations.
- Keep one deep grounding module responsible for claim enumeration, prompt-local labels, model-output validation, exact canonical resolution, and grounding issues.
- Store clean values and canonical Evidence links separately within the existing Extraction JSON aggregate.
- Preserve atomic review persistence, exact Source Representation and Schema Revision pinning, occurrence ownership, and fresh-browser reopen.
- Keep successfully extracted values visible and retry grounding without rerunning extraction.
- Reduce avoidable prompt/output amplification, including duplicate logical-table rendering.
- Compare the combined, full-document two-pass, full-source record-batched, and deterministic retrieval-batched two-pass flows on all three shipped examples before accepting performance claims.

**Non-Goals:**

- Model-generated Evidence content or location metadata.
- Text, snippet, PDF-layer, fuzzy, or heuristic matching that creates or retargets an Evidence link.
- Model-selected document boundaries, fuzzy retrieval, or allowing retrieval to publish or repair an Evidence link.
- A Prisma migration or a second Evidence/Review aggregate.
- Keeping the combined `{ value, anchor_id }` model path as a fallback.
- Re-running the historical 45-call provider matrix.

## Decisions

### 1. One deep grounding module owns the seam

Add a Studio module with a small interface:

```ts
type ResultPath = readonly (string | number)[]

type EvidenceLink = {
  resultPath: ResultPath
  evidenceAnchorId: string
}

type GroundingOutcome = {
  evidenceLinks: readonly EvidenceLink[]
  ungroundedPaths: readonly ResultPath[]
  issues: readonly GroundingIssue[]
  modelAttribution: unknown
}

groundExtraction({ document, result, signal, invokeModel }): Promise<GroundingOutcome>
```

The module hides claim enumeration, the claim and anchor dictionaries, prompt construction, strict selection validation, and canonical resolution. `invokeModel` is an internal port backed by the existing buffered Studio extraction route, so no provider-specific grounding implementation or routing configuration is added.

Alternative considered: let `useExtraction` assemble claims and maps directly. Rejected because callers and tests would need to understand the grounding protocol, creating a shallow module and spreading exact-resolution invariants.

### 2. Extraction returns the clean schema result

The first operation calls the existing model route with `{ records: [cleanTemplate] }`, the canonical plain source projection, and researcher field instructions. It does not receive citation labels or wrapper schema. A successful result is immutable for the remainder of that run.

Alternative considered: keep labels in the extraction source while removing only wrappers. Rejected for production because extraction has no citation responsibility; the controlled benchmark retains it only as an ablation.

### 3. Grounding uses two exact prompt-local dictionaries

The grounding module enumerates every non-empty scalar result leaf in deterministic traversal order. It assigns `C1`, `C2`, and so on to paths and renders compact claim lines containing the semantic result path and JSON scalar value. It separately projects parser-owned anchors as `E1`, `E2`, and so on.

The model returns one compact map whose schema enumerates every expected claim key:

```json
{
  "links": {
    "C1": "E127",
    "C2": "NONE"
  }
}
```

`NONE` is explicit abstention. Unknown claim keys, unknown anchor labels, malformed members, and missing claims do not attach Evidence. Valid selections resolve through exact maps; no text is matched to select another anchor. The enumerated map was chosen over an array of `{claim, anchor}` objects because the Ellekilde static shape was about 4,243 output characters instead of 11,993 for 310 claims.

Alternative considered: return persistent 71-character IDs or JSON paths directly. Rejected because persistent IDs raised the Ellekilde prompt to 31,558 tokens and paths make model output larger and easier to corrupt.

### 4. Persist a clean result plus Evidence links

The existing Extraction JSON payload becomes:

```ts
type GroundedExtractionPayload = {
  result: Record<string, unknown>
  evidenceLinks: EvidenceLink[]
}
```

The existing model-attribution JSON records both steps:

```ts
type GroundedModelAttribution = {
  extraction: unknown
  grounding: unknown
}
```

No Prisma migration is needed. The review write validates every result path against the immutable result, path uniqueness, canonical anchor ownership in the pinned Source Representation generation, one Review Decision per linked anchor, and occurrence ownership. Reopen returns the same clean result and links. The Results view displays only `result`; highlighting and review derive only from validated links.

Alternative considered: reconstruct wrapper objects before persistence. Rejected because it preserves the obsolete result pollution and makes Extraction data harder to consume independently of Evidence.

### 5. Deterministic candidate retrieval narrows prompts but is not quality-accepted

The full-document and full-source record-batched variants both failed the table-heavy Ellekilde gates. Full-document grounding produced nine structural issues, 43.3% strict table mismatch, and 57.0% exact-table recall. Full-source record batching produced 28 unknown anchor labels, 38.6% mismatch, and 57.9% recall while repeating 82,516 input tokens. Neither is a production candidate.

The implemented candidate groups claims by deterministic top-level `records[i]`; results without that array use one batch. For each batch, the grounding module selects candidate parser anchors by normalized exact containment of a claim value. Numeric values require token boundaries. A seeded table cell expands to its entire canonical logical row. When there is no seed, the batch falls back to the complete source. Candidates retain canonical document order, and a logical table is rendered only once.

Retrieval has no authority over the result: it only determines which parser-published `E*` labels the grounding model can see. The model must still return an exact call-scoped label, and the resolver must still look it up in the call dictionary. A hidden or unknown anchor cannot be linked or repaired and therefore leaves the value ungrounded. If at least one candidate exactly contains the claim value, a model selection outside that exact set is rejected as a conflict. This guard only removes a link; it never creates or retargets one.

One standalone, manually ordered, seed-72 Ellekilde prompt resolved all 329 claim keys with 97.2% exact-table recall and 3.3% strict table mismatch; peak context was 12,556 versus 19,441 for the combined baseline. This result is an ablation, not production acceptance. PostgreSQL `jsonb` reordered the same schema before reopen, changing the live prompt. Two unseeded live runs produced 41.9%-56.1% strict table mismatch, and a final real-handler seed-72 run produced 51.9% mismatch and 46.6% exact-table recall. Deterministic conflict rejection improved the cached ablation to 1.4% mismatch without lowering its 97.2% recall, but it cannot make the reordered live prompt pass. No separated strategy therefore passes the production-equivalent Ellekilde quality gates yet.

Alternative considered: source sections inferred from grave numbers or model boundary detection. Rejected because generic `parsed_document.v2` does not publish record ownership, and inferred boundaries could silently hide valid canonical anchors.

### 6. Grounding failure preserves values and review fails closed

Browser state distinguishes `extracting` and `grounding`. Once extraction succeeds, the clean result remains available. A whole grounding-call failure yields a ready ungrounded result plus a grounding error and a grounding-only retry. Per-link invalidity yields issues and leaves only those paths ungrounded. A run with no valid links cannot be accepted as reviewed under the current explicit-review action.

Rerunning extraction invalidates all links and both step attributions. Retrying grounding reuses the immutable current result.

### 7. Verification uses all three examples without mutating the shared database

Static prompt accounting covers every example and all three flow variants. Fixed live comparison uses exact Ollama tag, temperature, seed, assertions, per-call tokens/timing, strict extraction shape, record/populated-field recall, grounding coverage, unknown/duplicate labels, known wrong table links, abstentions, completion reason, aggregate tokens, peak context, and transport/result sizes.

The current shared database is read-only evidence: one shipped example lacks a durable snapshot. Live lifecycle verification therefore uses a disposable database and retained-artifact root. Ellekilde published successfully and completed an eight-call real-handler lifecycle, persistence, highlight, and fresh-browser reopen. Zhang failed closed before grounding with `v2_evidence_geometry_unavailable`. On this checkout, 1790 reached parser publication twice but Windows file handles retained by Camelot caused `os.replace` to fail with WinError 5, so no live model or persistence claim is made for it. Deterministic focused and Playwright checks reuse fixed outputs and do not rerun the model.

### 8. Schema order is durable domain data

`SchemaRevision.schemaTree` remains a JSONB database column but its JSON value becomes the existing recursive `SchemaNode[]` domain representation. Every sibling collection is therefore an array, preserving researcher-authored order through PostgreSQL. Reopen validates the stored array, returns it as `schemaNodes`, and the browser passes those nodes directly to the editor before `nodesToTemplate()` compiles the model-only object in the same order.

The obsolete object-shaped stored template is rejected rather than decoded. Sorting object keys was rejected because it creates an artificial order unrelated to the researcher-authored schema and would leave presentation order nondurable. A new Prisma column or migration was rejected because JSONB already preserves array element order.

## Risks / Trade-offs

- **Two calls resend source and may increase aggregate tokens or latency** → report peak context, aggregate input/output, and wall time separately; do not accept “fewer output tokens” alone as a win.
- **A focused grounding call can still choose a known but wrong anchor** → measure known-anchor correctness separately from unknown-label rejection; invalid selections never fuzzy-retarget, and review remains explicit.
- **Schema key order changes the NuExtract prompt and result quality** → the current `jsonb` schema representation does not preserve researcher field order; do not accept automatic grounding quality until schema storage publishes an ordered canonical prompt representation and the live gates pass.
- **Retrieval may omit a valid supporting anchor** → retrieval cannot publish or repair links; no-seed batches use the full source, selected anchors remain parser-owned, unknown labels fail closed, and omitted support remains visibly ungrounded.
- **Result-path links can drift if values are edited** → results are immutable; rerun extraction invalidates links, and persistence revalidates every path atomically.
- **Tolerant model parsing can hide malformed grounding output** → the grounding module applies its own strict enumerated-map decoder and converts missing, extra, or malformed members to explicit issues or a grounding-stage failure.
- **Changing persisted JSON can break reopen fixtures and callers** → replace the old shape everywhere in this change, update DTOs/tests together, and add no compatibility decoder.
- **All-three-example live E2E could contaminate existing research data** → use a verified disposable PostgreSQL database and retained-artifact root; do not seed or repair the shared database.

## Migration Plan

1. Add the pure claim/path/link types and grounding module with deterministic tests.
2. Replace combined extraction orchestration with clean extraction followed by retrieval-batched grounding and conflict rejection; delete wrapper generation and recursive result-anchor discovery.
3. Replace Extraction/reopen DTOs and JSON persistence with `{ result, evidenceLinks }`, update Schema Revision JSON to ordered `SchemaNode[]`, and update review validation and browser state in one slice.
4. Update Results progress, grounding retry, highlighting, and deterministic lifecycle fixtures.
5. Run focused checks, static three-example accounting, bounded live model comparison, and disposable-stack fresh-browser reopen.
6. Remove obsolete combined-path tests and helpers after the new interface tests pass.

Rollback before publication is a normal source revert of this change. There is no persisted compatibility migration because the prototype intentionally removes obsolete paths rather than supporting both JSON shapes.

## Open Questions

- After ordered prompt publication is implemented, does a fresh live Ellekilde run pass the <=10% strict table mismatch and >=90% exact-table recall gates without relying on a standalone benchmark fixture?

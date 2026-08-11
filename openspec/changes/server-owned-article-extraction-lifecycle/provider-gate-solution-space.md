# Ollama provider-gate solution-space exploration

Follow-up to [`matrix-rerun-evidence.md`](matrix-rerun-evidence.md). The retained failures were reproduced from raw outputs, minimized, and probed with 78 additional Ollama calls over the same Beretning and Zhang canonical sources. Each variant ran three times per source.

## Diagnosis

### Article truncation is primarily a probe-contract failure

The retained Article probe asked the values model to author `recordLabel`, `recordAnchorId`, document-metadata anchor IDs, and duplicated metadata. That is not FREE's selected Article contract: production extracts schema values and grounds them afterward against canonical anchors.

On Beretning, the probe emitted one item for nearly every `[E#]` source label. Both rejected outputs reached exactly 8,192 tokens. FREE's tolerant repair can recover these as objects with 104 and 239 partial records respectively, but they remain semantically unusable and must stay incomplete.

A values-only minimization changed the result materially:

| Article template | Beretning | Zhang | Length finishes |
|---|---:|---:|---:|
| Generic `recordLabel` only | 0/3 exact; one item returned | 0/3 exact; one item returned | 0/6 |
| Domain-valued fields (`graveNumber`; `sectionNumber` + `sectionTitle`) | 3/3 exact, seven records | 3/3 exact, four records | 0/6 |

The successful variant used explicit source-specific record instructions, so it does not prove arbitrary researcher schemas reliable. It does show that raising `num_predict` would treat the symptom, not the cause: semantically meaningful values finished in 60–66 output tokens, while the obsolete evidence-authoring shape expanded until the cap.

### Catalog's missed start exposes two separate problems

The retained discovery contract asked the model for record labels, starts, and ends. Zhang's fourth start was returned as `E174` instead of canonical `E175`; `E174` is the preceding record's final anchor. This is exactly the coupling avoided by #79's selected start-only protocol.

Start-only probes removed that end/start confusion but did not make NuExtract generally reliable:

| Discovery variant | Beretning | Zhang | Observation |
|---|---:|---:|---|
| `{ starts: string[] }`, full source | 3/3 exact | 0/3 | Zhang returned `E1`–`E4`, confusing section numbers with source labels |
| Start-only object records | 0/3 valid JSON | 0/3 exact | Beretning had a repeatable extra-brace error |
| Full source + explicit label-copy example | 3/3 exact | 0/3 | Zhang returned all 188 source labels |
| Heading-only inventory with `E#` labels | 2–3/3 exact | 0/6 | Zhang returned most numbered subsections too |
| Heading-only inventory with opaque labels | 3/3 exact | 0/6 | Opaque labels fixed copying, not semantic classification |
| Label + start pair, no end | 3/3 exact | 0/3 | Zhang again emitted every source item and hit 8,192 tokens |
| Boolean heading masks | 0/6 exact | 0/6 exact | Preserved more candidates but admitted extra headings |

`parsed_document.v2` currently reports every Zhang heading—including `2.1`, `2.9.1`, and top-level sections—as `level: 1`. Therefore the design assumption that canonical heading levels can distinguish terminal siblings is not satisfied by this retained source. Prompting with `heading_level` could not help because the canonical data contained no hierarchy.

## Ranked solution space

### 1. Correct the acceptance seam first

Do not use the obsolete evidence-authoring Article probe as the server-owned Article release gate. Replace it with a representative call through `POST /api/extractions` using a real values-only Extraction Schema, then assert persisted outcome, completeness, diagnostics, canonical grounding, and reviewability.

This does not waive truncation: `done_reason: length` remains incomplete. It prevents a rejected historical prompt shape from standing in for the implemented operation.

### 2. Keep the 8,192-token cap

Do not increase `num_predict`. The failed output was already semantically wrong after its first few items, and a larger cap would only increase latency, memory, repair work, grounding calls, and persisted noise. The correct values-only probes required fewer than 70 output tokens.

Add a defensive diagnostic for repaired length output with implausible record expansion. It should remain visible and non-reviewable, not be reclassified as complete or silently retried.

### 3. Block Catalog implementation on trustworthy canonical hierarchy

Before Slice 2, fix and verify heading hierarchy publication on the retained Zhang source. Top-level sections must be distinguishable from `2.1`/`2.9.1` subsections in canonical parser output. Catalog terminal-boundary derivation cannot be called deterministic while every heading is level 1.

This belongs in the Parsing Service's source-authority layer, not in Studio prompt heuristics. Any deterministic hierarchy normalization needs parser tests and retained-source evidence.

### 4. Give Catalog an explicit record concept

The probe had to inject source-specific rules such as “every `Grav N` heading” and “top-level numbered headings 1 through 4.” The current visible one-record schema has field descriptions but no explicit description of what constitutes one record boundary.

Before adding more prompt tricks, decide how a researcher-approved Extraction Schema communicates the record concept to Catalog—preferably one root record description rather than heuristic field-name inference. Compile that description into discovery and test it against both sources.

### 5. Use a heading-candidate discovery payload, then exact validation

Once hierarchy and record semantics are available:

- send only canonical heading candidates, not the entire anchor stream;
- request a compact scalar start-label array;
- use opaque call-scoped labels if numeric headings still alias `E#` labels;
- map labels back to canonical anchors and derive heading text, identity, and ends server-side;
- reject unknown, duplicate, non-monotonic, wrong-level, and semantically impossible candidates without fuzzy recovery.

The scalar array was the only start-only NuExtract shape that remained valid on every Beretning run. Opaque labels improved copying but cannot replace record classification.

### 6. Preserve fail-closed behavior

Do not add automatic retry, silent Article/Catalog switching, provider fallback, fuzzy matching, or a larger output cap. Until the corrected Catalog protocol passes representative provider probes, return structured `boundary_invalid`/incomplete diagnostics and let the researcher explicitly choose another strategy or route.

## Recommended rollout decision

- **Slice 1 Article:** rerun the manual provider gate through the implemented server operation with values-only domain schemas. The historical truncation alone should not block Slice 1, but a production-path truncation still should.
- **Slice 2 Catalog:** remain blocked until canonical heading hierarchy and explicit record semantics are settled, then rerun a focused start-only matrix. Current evidence does not support implementing Catalog discovery by prompt tuning alone.

## Implementation follow-up

The prerequisites were implemented and verified through the server operation: numbered outline hierarchy is now published canonically, Schema Revisions require a root record description, discovery receives only proved canonical sibling candidates and returns a scalar start-label array, and invalid starts remain fail-closed. Focused Article, Zhang Catalog, and Beretning Catalog provider smokes passed with zero retries; see [`catalog-fix-evidence.md`](catalog-fix-evidence.md).

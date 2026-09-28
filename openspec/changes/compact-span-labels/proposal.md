# Proposal

## Why

The frozen R5 span preflight refused 20.8% of claim–unit comparisons, including every comparison for Hvissinge. Canonical span IDs repeat in selectable evidence labels and reply enums; short transport labels can reduce overhead without removing source text.

## What Changes

- Use deterministic request-local evidence labels for span grounding and resolve them to existing canonical proof identities server-side.
- Version the span prompt separately; preserve quoted and semantic requests and fingerprints.
- Measure admission and input tokens on pinned development sources using tokenizer-only, all-NONE checks; keep the full matrix deferred.

## Capabilities

No spec-level behavior changes. The existing requirements in `extraction-span-grounding/specs/span-grounding/spec.md` still apply: only offered evidence is accepted, proof locations remain canonical, and refused work stays visible. `skip_specs: true` records this implementation-only optimization.

## Impact

`stages.py`, span prompt version, grounding tests and a dated validation record. No new option, dependency, provider, evidence representation or production default. The Qwen OpenAI-compatible provider excludes the reply schema from prompt token counts; distinguish schema bytes from actual token savings in evidence labels. Frozen R5 remains unchanged.

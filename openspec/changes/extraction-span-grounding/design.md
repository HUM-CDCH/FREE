# Design

## Context

See `proposal.md` for motivation and
`docs/plans/2026-09-28-span-grounding.md` for research sources and delivery gates.
Article orchestration is in `run.py`; `stages.verify()` is shared with generic
Catalog. Canonical passages and cells already expose source text and offsets.
The running study uses frozen archives, separate from this checkout.

## Goals / Non-Goals

**Goals:** Measurable reductions in claim/evidence work, exact source reconstruction,
explicit eligibility and retained uncertainty. Plain typed modules and one serving
grounding implementation, with named experimental policies.

**Non-Goals:** New evidence storage, learned claim extraction, remote model deployment,
changing current defaults, or claiming human-level support from syntactic validity.

## Decisions

1. `spans.py` owns deterministic source ranges. Labels contain canonical parent and
   code-point range (or existing cell identity), scoped by the artifact's generation.
   Sentence/whitespace boundaries are preferred within the prose cap. Text is never
   normalized or stripped. Table cells remain indivisible; coarse passages retain
   coarse geometry. Full parent and table relation context accompanies choices.
2. Extend the existing verifier with a named `spans` method, keeping the old semantic
   and quoted methods reproducible. Compact replies contain a span ID and an explicit
   attribution boolean, not generated quote text. All claims are required; only offered
   IDs are accepted. Accepted proofs reconstruct text and offsets locally and retain
   `model_attested` provenance. This is not deterministic entailment verification.
3. An independent `grounding_schedule` factor selects all claims or unresolved claims
   across contexts. Path identity includes record and array indexes. Successful support
   permits early exit; missing answers, NONE, refusal and invalid output do not. This
   changes support discovery, not exhaustive contradiction detection.
4. Policy metadata belongs to schema nodes and crosses Python/TypeScript validation
   intact. Inherit policy down a subtree unless explicitly overridden. Skipped derived
   and unverified leaves retain paths/reasons in the artifact. Schema revisions and
   evidence policy are included in fingerprints; existing absent metadata preserves
   existing behavior. An independently controlled policy factor enables its ablation.
5. Routing first uses provenance hints and deterministic lexical/table relevance.
   Record exactly which units were tried. Strict fallback covers all remaining units
   for unresolved claims, preserving budget refusals. Learned dense retrieval is a
   separate later model factor, not a hidden dependency of this implementation.
   The implemented `origin_lexical` order prefers units owning contributing value
   contexts (inventory citations for bound identity fields), then lexical value
   matches and BM25 field/value relevance. It ranks every unit without a top-k
   exclusion. Claims sharing a next unit remain batched. Original value-call paths
   survive exact array union; the hints do not substitute for semantic support.
6. Grounding experiments freeze upstream records/inventory before varying the verifier.
   Keep OFAT contrasts for representation, scheduling, policy and routing, plus the
   requested cumulative stack. Final metrics retain all-leaf and eligible denominators.

## Risks / Trade-offs

- Early false support stops search → independently review subject/table attribution;
  retain exhaustive baseline and do not claim contradiction recall.
- A source span can omit a qualifier → show full parent/table context, retain relation
  fixtures, and measure evidence adequacy separately from literal validity.
- More span labels enlarge input → count actual prompts; batch by admission and report
  token cost rather than promising the semantic verifier's call count.
- Many claims can exhaust output → bound compact decisions per call, retain truncation
  failures and test maximum-sized batches.
- Policy can disguise unsupported fills → report skipped paths and keep original
  all-leaf denominators; derived never means verified by itself.

## Migration Plan

Add opt-in factors with matching fingerprints; keep existing requests unchanged.
Register and capture new comparisons separately after frozen generation settles.
Review evidence and schema transport before any production-default decision. There
is no database migration or automatic deployment in this change.

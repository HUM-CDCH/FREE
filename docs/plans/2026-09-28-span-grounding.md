# Span selection and selective grounding — 2026-09-28

Status: active follow-up to the user's grounding-cost proposal; no new live arm has run.
Branch/worktree: `feat/extraction-span-grounding` in
`/home/gennaro/projects/FREE-worktrees/extraction-span-grounding`, based on `d74dc17c`.
Tasks and implementation decisions: `openspec/changes/extraction-span-grounding/`.
The [original study](2026-09-27-modular-extraction-ablation-study.md) remains unfinished
and independently supervised; its frozen source and registered matrix are unchanged.

Implemented: span-ID verification, independent unresolved-path scheduling and schema
evidence policy. [Validation](../validation/2026-09-28-span-grounding.md) records focused
and full suites, a real PostgreSQL policy round trip and exact old-method regression.
Origin/retrieval routing, fresh comparison and semantic-quality evaluation remain open.

## Evidence and research boundary

The inspected merged code rebuilds `leaves(fields)` inside `stages.verify()` for each
Article context from `run.extract()`. Quoted verification batches four claims, sends
every passage plus eligible table cells, and suppresses duplicate links only after calls.
The proposed change targets those three causes separately.

Primary sources checked on September 28:

- [VeriFastScore, v3](https://arxiv.org/abs/2505.16973v3) supports joint verification as
  a runtime direction, but its reported gains use a specially fine-tuned model. A prompt
  change in FREE is not a reproduction of that system or its speedup.
- [MiniCheck, v2](https://arxiv.org/abs/2404.10774v2) is a possible compact verifier.
  Its classification does not itself locate canonical evidence.
- [FActScore, v2](https://arxiv.org/abs/2305.14251v2) supports retrieval before fact
  verification; its open-world task and evaluation differ from schema-filled PDFs.
- [VERISCORE](https://arxiv.org/abs/2406.19276) distinguishes verifiable claims. FREE
  should express evidence eligibility in approved schema metadata, not another model
  pass or a hardcoded field name.
- [FACTOR, v1](https://arxiv.org/abs/2606.22474v1) is relevant exploratory evidence for
  adaptive effort, not justification to skip uncertain scientific claims.

Span selection is a local engineering hypothesis. An existing ID proves source location,
not entailment or subject attribution. No paper's benchmark gains transfer numerically
to this pipeline. The 18-versus-144 Wang grounding-call observation is a design target,
not a forecast of the new verifier's performance.

## Implementation sequence and acceptance

1. **Canonical span materialization.** Add deterministic passage-relative ranges and
   existing table-cell references in `kie/extract/spans.py`. Preserve every source byte,
   Unicode/code-point offsets, control characters, canonical generation and parent ID.
   Prefer sentence/whitespace boundaries; a 500-character upper bound must not silently
   discard overflow or invent geometry. Table cells remain intact, including long cells;
   table/header/qualifier context stays available. A prose range inherits coarse parent
   geometry; it never claims a measured word box. Verify duplicate text, tabs, Unicode,
   long prose, merged cells, cells without geometry and exact reconstruction.
2. **Span verifier.** Add an opt-in grounding method with explicit model attestation of
   support for the field and subject, compact IDs, complete claim coverage in the response
   schema, and server-reconstructed `quoted_support`. Reject unknown/missing IDs, negative
   attribution and truncated replies. Count actual input plus output reserve; split
   oversized claim batches or refuse visibly. Preserve old arms and cancellation hooks.
3. **Independent scheduling and policy.** Keep supported-path filtering independently
   fingerprinted and operate on full record paths. Introduce schema evidence policy
   (`quoted`, `derived`, `unverified`) through matching Python/TypeScript validators and
   persistence round trips. Default existing schemas to their current behavior. Use
   explicit node metadata to classify `field_statuses`; do not key behavior on its name.
   Derived is an eligibility classification, not proof that a value was deterministically
   calculated. Retain skipped paths and reasons; do not inflate grounding completeness.
4. **Candidate routing.** Preserve actual value-origin provenance before using it. Current
   record-level `value_contexts` are hints, not proof of a particular leaf's origin.
   Start with those hints and deterministic lexical/table matching. Strict mode sends
   unresolved claims through all remaining units, with attempted/refused/remaining
   dispositions. Early exit can miss contradictory evidence and therefore cannot be
   reported as exhaustive contradiction search. Dense retrieval requires a separately
   pinned embedding model and a new comparison; do not silently add a service.
5. **Controlled evaluation.** Register before generation: quoted control; span-only;
   span plus unresolved filtering; span plus policy; and routing with exhaustive fallback.
   Also report the user's cumulative variants, distinguishing bundled effects from OFAT.
   Pin upstream records/inventory, source, schema and model so grounding alone changes.
   Keep the all-leaf accounting denominator alongside policy-eligible claims. Measure
   calls, input/output tokens, stage time, failed/refused/missing decisions, exact source
   reconstruction, claim coverage and retrieval/fallback coverage. Evaluate table row,
   column-header, unit, subject and qualifier attribution on independently reviewed pairs
   when available. Existing model links cannot supply that gold. No fresh model jobs may
   compete with or replace the registered generation chain without an explicit handoff.
6. **Delivery.** Run focused and full appropriate checks, fixed-reply reference regression,
   bloat audit and schema/adapter checks for changed contracts. Record results and limits;
   push reviewable changes and open a scoped draft PR. No merge or deployment is implied.

The existing study remains a completion obligation. The prototype, current development
ablation, fresh grounding study and independently reviewed semantic evaluation must each
be reported with their actual status; none substitutes for the others.

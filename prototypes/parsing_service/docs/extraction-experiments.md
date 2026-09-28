# Extraction stages and controlled experiments

The serving entrypoint is `kei_exp.kie.extract.run.extract`. It reads one verified
canonical generation, checks strategy settings, calls the stages, and assembles
one evidence-bearing artifact. DBOS still owns scheduling and cancellation;
the experiment runner calls this same extraction entrypoint directly.

```mermaid
flowchart LR
  C[Verified canonical passages] --> R{Strategy}
  R --> A[Article: inventory and identity reconciliation]
  R --> G[Catalog: entry discovery or recipe segmentation]
  A --> V[Record values]
  G --> V
  V --> Q[Grounding and proposals]
  Q --> O[Artifact: values, evidence, issues, costs]
```

## Ownership

| Module | Responsibility |
| --- | --- |
| `evidence.py` | Verify canonical files and expose stable passages/tables. |
| `rendering.py` | Expose block types and table cell spans to the model while retaining exact canonical text. |
| `spans.py` | Offer exact generation-scoped source ranges and intact canonical cells for compact grounding decisions. |
| `routing.py` | Map reconciled values to reply origins and order whole verification units with exhaustive unresolved fallback. |
| `method.py` | Validate explicit experimental choices; enforce the Article context ceiling. |
| `contexts.py` | Partition whole passages or structural groups with disjoint primary ownership, inherited heading context and optional overlap; reconcile values without hiding scalar conflicts. |
| `selection.py` | Select whole value contexts from inventory support, adjacent qualifiers and schema relevance; expose omitted units. |
| `article.py` | Enumerate recurring identities, reconcile them, and extract each record across its source contexts. |
| `stages.py` | Shared model admission, schema prompts, generic Catalog discovery, values, grounding and record assembly. |
| `grounded.py` | Recipe Catalog entry extraction, candidate verification, conflict arbitration and normalization. |
| `run.py` | Select the strategy and assemble the pinned artifact. |
| `experiments/extraction/` | Register inputs/comparisons, capture and resume calls, and analyze completed cells. Never imported by serving code. |

These are ordinary Python functions. There is no plugin graph or separate
service per stage. Strategy differences reflect source structure: Article
identities recur across sections; Catalog entries own contiguous source spans.

## Article choices

Omitting `options.article` retains the full-source reference requests. Protocol v12
preserves literal source control characters when decoding replies; quoted verification
also has corrected instructions and literal source matching. Version/fingerprint metadata
therefore differs from v11. The frozen R1 checkout/archive retains exact v11 behavior.
Specifying Article options records all settings and `method_version: 1` in the fingerprint. It is currently a research interface;
Studio does not expose these controls.

- `identity=reference|conservative`: the reference deduplicates any nonempty
  scalar key. Conservative reconciliation restricts inventory attributes to
  explicit `identity_fields`. Only complete declared keys merge across units;
  incomplete keys also require the same label and supporting passages. Partial
  identities remain visible and can produce duplicates requiring review.
- `prompt=reference|schema`: retain the earlier laboratory instructions or
  derive record semantics from the supplied schema without laboratory examples.
- `rendering=structured`: expose canonical block IDs, labels and pages, plus
  table cell IDs, rows, columns, spans and available roles in document, inventory
  and value inputs. Tagged text preserves every source character; it is not XML.
  Missing table cells stay missing. Omission preserves plain reference requests.
  Rendering and `rendering_version` participate in the fingerprint. Tokenizers
  count the actual markup, so structure can increase costs or cause refusal.
  This changes neither the grouping algorithm nor the verifier's cell renderer.
- `context=full|bounded`: send the full source, or partition whole canonical
  passages under a fixed served-token ceiling, including output reserves.
  Inventory and record-value prompts use their actual tokenizer/template.
  By default every record reads every unit.
- `grouping=structural` (bounded only): keep a heading with its first body block
  and tables with immediately adjacent captions/footnotes, across page furniture.
  Prefer section boundaries and carry the latest heading into continuation units.
  Required heading context is token-counted and recorded separately from primary
  ownership. An oversized group is refused intact; it never sheds its qualifier
  to fit. Labels do not establish a heading hierarchy or arbitrary cross-page
  table association, so neither is inferred. Omission keeps token-only partitioning.
  The setting and `grouping_version` participate in the fingerprint.
- `selection=supported` (bounded only): retain value units owning identity
  support and neighboring canonical passages, plus at most one additional unit
  with positive schema-term relevance. The deterministic lexical score uses
  term frequency, inverse unit frequency and length normalization. It preserves
  whole original units and records selected/omitted passages and reasons.
  Inventory, document fields and verification still visit all bounded units.
  Selection can omit relevant late evidence; relevance recall remains unmeasured.
  Omission of this setting preserves the all-unit method and its fingerprint.
- `overlap_passages=0..2`: preceding context that never changes primary
  ownership. Tables are indivisible passages. An oversized passage is explicitly
  refused; it is never clipped or reconstructed under its original identity.
- `grounding=semantic|quoted|spans|off`: source-label verification; verification with
  exact source-substring checks and model-attested attribution; or no links.
  Quoted verification uses four claims per batch and at most 500 characters per
  quote. Matching preserves case and whitespace; normalization cannot manufacture
  a source substring. Quoted support is retained in the artifact. A valid substring and a
  model's attribution are **not independent proof of semantic correctness**.
- `grounding=spans` reconstructs quotes from offered canonical ranges instead of
  asking the model to generate source text. Replies select a span ID and attest
  support for the field and record; negative attribution creates no link. Prose
  ranges cover every character and are at most 500 code points, preferring sentence
  or whitespace boundaries. Existing table cells stay intact, including longer
  cells. Complete parent text and eligible cell/header context remain available.
  `quoted_support` retains exact start/end offsets, source text and cell identity;
  geometry remains at the parent's precision unless a measured cell box exists.
  Batches start at 32 claims, then split under actual input-token admission with
  a 2,048-token output reserve. Missing/unknown decisions and truncation remain
  failures. The setting and `span_grounding_version` change the fingerprint.
- `grounding_schedule=unresolved` independently removes supported full record paths
  from later source-unit calls. NONE, missing decisions and failed calls stay
  unresolved. Omission keeps the exhaustive all-claim schedule and its previous
  fingerprint. Early exit searches for support; it does not establish absence of
  contradictions elsewhere. It can amplify false-positive support and needs
  independently reviewed attribution evidence before production adoption.

- `evidence_policy=schema` independently enables node `evidencePolicy` metadata
  with quoted or span grounding. Policies are `quoted`, `derived` or `unverified`.
  Omitted metadata inherits the closest parent's policy, defaulting to `quoted`;
  explicit child metadata overrides its parent. Explicit null is rejected.
  For example, a diagnostic array node can declare `"evidencePolicy": "derived"`
  while an observation child declares `"evidencePolicy": "quoted"`. Renaming the
  array does not change eligibility. Derived describes eligibility, not a verified
  calculation. Both skipped policies retain values, full paths in `ungrounded`,
  and `evidence_policy_skipped` reasons in the result and Studio adapter.
  `grounding_eligibility` records all/eligible leaf counts and skipped paths/policies;
  `completion.eligible_grounding` reports only the eligible set (or `not_applicable`
  when empty). Existing all-leaf grounding and link-rate metrics remain unchanged.
  The analyzer checks the ledger against the schema and rejects links on skipped
  fields. Without this method factor, metadata does not prune verification.
- `grounding_routing=origin_lexical` requires `grounding_schedule=unresolved` and
  quoted or span grounding. It orders whole source units per claim: units owning
  extraction-origin passages first, then bounded lexical value matches and BM25
  field/value relevance, with canonical index as the final tie-breaker. No source
  unit is excluded; unresolved claims continue through every remaining unit.
  Claims sharing their next unit are verified in one batch where budgets allow.
  Failed, missing and invalid decisions do not stop search; refusals remain gaps.
  Table cells, headers, qualifiers and structural context are not cut by routing.
  This is deterministic lexical retrieval, without a dense model or service.

With routing enabled, `value_origins` retains each full record leaf path and its
contributing value-call unit/index path. Array unions may change output indexes;
the mapping requires an exact whole-item match to an original reply. Scalar
conflicts remain null and acquire no origin. Identity fields bound by the inventory
retain `kind=inventory` and its model-supplied citations instead of pretending they
were extracted again in each value call. Value units refer to `value_contexts`;
routing prefers their primary ownership, not duplicated heading/overlap text.
These are extraction hints, not canonical evidence or proof of support.

`grounding_routes` retains full claim paths, ordered unit indexes, origin/value
match hints, lexical scores, attempted/refused/remaining units and supported status.
An attempted unit can still have a failed model reply; the existing calls/issues
ledger retains those failures. `attempted_all` means every unit was submitted,
not that every reply was usable or no contradiction exists. `partial` retains
budget/no-evidence refusals; `stopped_after_support` retains unvisited units.
The separately recorded `grounding_routing_version` participates in fingerprints.

These methods are opt-in prototypes. Their controlled live comparison remains in
the [follow-up plan](../../../docs/plans/2026-09-28-span-grounding.md).
They do not alter the running frozen R1/R2a/R3/R4 study.

The shared decoder accepts literal control characters only inside strings and
preserves their values exactly, like escaped JSON spellings. It still rejects
missing delimiters, invalid escapes, trailing objects and output truncation.
Only a leading model thinking envelope is removed; literal tags inside source
quotes remain intact. The provider prompt requests escaped JSON strings. Recipe
Catalog records protocol v5 for the same decoder correction. This is an explicit
syntax extension, not semantic acceptance or repair of missing model output.

To exercise the new structural input with an approved schema, set:

```json
{"strategy": "article", "article": {
  "context": "bounded", "context_tokens": 12288,
  "rendering": "structured", "grouping": "structural",
  "prompt": "schema", "grounding": "quoted"
}}
```

Add conservative identity reconciliation only with identity fields appropriate to
the schema. These remain experimental controls, not a new Studio default.

Bounded value reconciliation unions exactly equal array items, merges objects,
and leaves scalar conflicts null with all alternatives recorded. It does not
infer that different array items represent the same observation. Multiple
units can therefore increase duplicate or contradictory candidates.

`completion` separates processing, attempted inventory coverage, grounding,
unverified document fields and unmeasured recall. Experimental Article artifacts
never assert complete record recall from their own inventory. A successful call
is not evidence that the model found every subject.

## Catalog choices

`options.catalog.factors` independently controls glossary use, inherited
headings, overlap, and verification. Omission preserves existing behavior and
serialization. Disabling verification retains typed model values as proposals,
without accepting or grounding them; `raw_candidates` preserves the replies.
Structural ownership and canonical spans are never disabled. Glossary-off also
disables glossary normalization; heading-off disables inherited bindings and
heading context; overlap-off disables neighboring context and window overlap.

`headed-graves-da@1` is a narrow, declared recipe for standalone `Grav N`
headings. It was developed on the supplied Ellekilde excerpt. Its seven detected
blocks and complete line disposition are observations, not annotated block F1.
It does not apply the German catalogue's field bindings or strip `Grav` from a
printed identifier. Transfer to other grave reports is unmeasured.

## Research boundary

The assemblies implement controllable adaptations of the intentions in
[kei-exp's literature review](https://github.com/GennaroBaratta/kei-exp/blob/4f724dd9d576329e4b8a53c6f25d3da8c84fe319/docs/literature.md):
bounded decomposition, stable source IDs, overlap, explicit nulls, deterministic
verification, and schema/glossary context. They do not replicate trained models,
coordinate-embedding experiments, supervised SCRI/GEC training, stochastic voting,
VLM crop rereading, learned routing, or the complete published systems. Those
require separate implementations and evaluation data.

The full-source reference remains an experimental baseline because comparison
is an explicit requirement. It is not an invisible fallback for a refused
bounded call. Bounded processing currently trades repeated calls for exhaustive
source visitation; call count grows with records times source units. The optional
lexical selector is a separate hypothesis, not hybrid retrieval replication.
Cross-unit semantic reconciliation remains unimplemented. Structural grouping adapts
[BLOCKIE's linked-block idea](https://arxiv.org/html/2505.13535v1) using canonical
labels, without an LLM rewriting the source or proof of block independence. Literal
quoted-source checking follows the decoding constraint in
[LMDX Algorithm 2](https://arxiv.org/html/2309.10952v2); it does not reproduce coordinate
training or voting. These development fixes are separate from the frozen studies.
The R3 [rendering protocol](../experiments/extraction/rendering-protocol.md)
declares a separate six-paper fresh comparison. It tests structure in model input,
not semantic grouping or the complete historical DocTags pipeline.

## Run a study

From this service directory, with the existing virtual environment:

```sh
.venv/bin/python -m experiments.extraction.register DIAGNOSIS_ROOT MANIFEST.json
.venv/bin/python -m experiments.extraction.study validate MANIFEST.json OUTPUT_DIR
.venv/bin/python -m experiments.extraction.study preflight MANIFEST.json OUTPUT_DIR
.venv/bin/python -m experiments.extraction.study run MANIFEST.json OUTPUT_DIR
.venv/bin/python -m experiments.extraction.analyze OUTPUT_DIR REPORT.json
```

Registration pins source PDFs, every canonical JSON file, generations, schemas,
gold, scorer, implementation files, method settings and model endpoint metadata.
Any changed pinned input refuses execution. Registration is immutable; a code,
schema or policy change requires a new study revision. No new conversion is
mixed into a method comparison. The registry uses only existing example and
validation inputs; the six gold papers are development data, and the ten examples
have no independently annotated field gold.

`run --cell CELL_ID` selects one registered cell. Rerunning `run` retains completed
cells and resumes interrupted cells only when their next request exactly matches
the captured request. Saved replies count as reused, not fresh inference.
Requests without saved replies carry an unknown-prior-completion count before
resubmission. A cell lock prevents concurrent execution of that cell. Completed
results commit together with their execution receipt in `cells/ID/result.json`:
the native extraction artifact is under `artifact`, execution accounting under
`execution`. Failed attempts and full request/reply captures remain separate.

The runner does not start or deploy model services, supply credentials, reset
databases, or claim authenticated service/DBOS timing. It uses greedy decoding.
Saved model latency is distinguished from the wall time of the current attempt.

Analysis uses the unchanged adjudicated collagen scorer. It reports populated
and empty fields separately, per-document paired effects, document bootstrap
intervals, one registered two-factor interaction, token/call costs, grounding
diagnostics, failures, and an extra-prediction review queue. Extra predictions
are not automatically false positives because the gold is non-exhaustive.
Unannotated examples support operational comparisons only. Small development
samples cannot establish generalization, and model links cannot establish an
independent semantic grounding accuracy score.

The selector has a separate [conditional replay protocol](../experiments/extraction/selection-protocol.md).
`python -m experiments.extraction.selection_replay register R1_DIR OUTPUT_DIR`
pins that comparison; `run OUTPUT_DIR SOURCE_ID` first reproduces the original
bounded result exactly, then compares all versus selected value units using only
captured response subsequences. Both paired arms disable grounding. Tokenizer
probes are cached, and unseen generation requests fail. Saved calls/tokens are
counterfactual costs; replay is not a fresh latency or model-variability trial.

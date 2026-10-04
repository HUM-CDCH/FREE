# 0017: Durable Extraction control and call checkpoints

Date: 2026-10-04. Status: proposed for implementation; approved planning direction under [Map durable interactive extraction and project-wide feedback](https://github.com/HUM-CDCH/FREE/issues/169). Current production contracts remain unchanged until implementation.

One researcher-visible Extraction must survive cooperative pause, revised settings, retries, and live review without losing completed work. DBOS remains the durable executor, but an attempt that returns at a pause boundary is runtime-successful while the Extraction remains Paused; DBOS messages alone also cannot establish which committed correction context a new call captured. Use immutable linked execution selections and a restricted PostgreSQL coordination schema for durable controls, call captures/checkpoints, and feedback publication, with DBOS enqueue/recovery driving attempts rather than defining researcher-visible lifecycle.

The Parsing worker retains no access to the application `public` tables or Studio's `dbos` schema. It receives only narrowly granted coordination routines that validate attempt fences and immutable inputs; Studio publishes corrections and eligible guidance revisions in one transaction. Every provider call durably captures inputs/context before invocation and commits its output before acknowledgement. A paused attempt drains and exits, releasing capacity; Resume creates a linked attempt reusing eligible saved work. Stable source anchors and result identities are distinct from schema-dependent work-window boundaries. DBOS rewind or rewriting an old admitted method is rejected because it would corrupt historical attribution.

This direction will amend the Extraction-specific status authority in [0012](0012-one-durable-execution-layer.md) and extend the immutable selection rule in [0015](0015-extraction-method-pinned-at-admission.md) from one admission to each linked execution selection. It does not introduce another job scheduler, permit worker access to researcher account configuration, or weaken source Evidence requirements. Details and release conditions live in the [implementation specification](../plans/2026-10-04-durable-interactive-extraction-specification.md) and [migration/verification plan](../plans/2026-10-04-durable-interactive-extraction-release.md).

## Pre-production scope amendment

Scope amendment, 2026-10-04: the user confirmed this is pre-production and
removed historical extraction compatibility from this feature. No legacy result
reader/identity mapping, failed-legacy upgrade Retry, protocol-0 fallback,
Cancel-to-Stop translation, or mixed-protocol export is required. Retry applies
to durable attempts in the same Extraction. Immutable producing inputs,
corrections, source Evidence, restricted coordination, and the admission gate
remain required. This amendment supersedes the original planning map's legacy
release requirements; it does not change the settled durable product decisions.

## Candidate implementation and integration status

The candidate lives on `feat/durable-interactive-extraction`, based on current
`dev` (`db6f8b92`), with the planning commit and ADR 0016/redesign artifacts
preserved. Its `extraction_runtime` namespace adds no mutated historical public
Extraction pins. Runtime capability is selected by its Head row, not by the
current admission gate. DBOS attempts and call workflows retain distinct names;
failed responses are immutable attempt-specific history, while successful
checkpoints are reusable by unchanged-input retries.

Review projection uses each value's immutable producing schema, independently
of consuming-target guidance compatibility. Stable child identities permit
nested renames; approvals/rejections bind to the actual reviewed model version.
Article aggregation retains historical lineage and explicit scalar proposals.
The source artifact and preprocessing generation stay referenced through
terminal states and deletion drain. Deleted graphs are fenced atomically with
public cascade deletion; native-history cleanup uses the Parsing worker's boot
boundary so cancellation alone never proves quiescence.

Implementation and release verification remain in progress. Spark E2E runs wait
for the results-review agent to finish; no shared Spark environment, runtime
database, deployment or production feature enablement is authorized by this
candidate. See [implementation evidence](../validation/2026-10-04-durable-interactive-extraction-implementation.md).

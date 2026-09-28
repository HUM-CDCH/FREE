# Acceptance harness

Status: pre-implementation, 2026-09-28. This is the concrete acceptance contract
for the design, not a claim that new UI behavior has been tested. Cases below
must exercise the actual implementation at the named seam. Do not replace an
adapter or database test with a function that mirrors the proposed implementation.

## Small initial gate

Use one coherent implementation owner. The first candidate must demonstrate the
three architecture invariants in [design.md](design.md), the existing
`pnpm test` gate, and the high-risk acceptance cases below. Infrastructure checks
remain separately identified. A passing fast suite cannot certify migration,
ownership, browser accessibility, durable replay or actual provider behavior.

The nineteen [contract examples](contract-cases.json) make basic accepted/rejected
Article combinations concrete. They intentionally include semantic + unresolved,
full source + quoted schema policies, and reference + identity fields: the UI
must not add restrictions that the current service does not impose. They also
reject a made-up version switch. Their scope is method validation, not schema
existence, evidence correctness or model availability.

### Exact wire example

For Article, field model `instruct`, reasoning model `instruct`, the combined
starting point translates to the following *options*, with reference fields
canonicalized by the service. No credential, provider connection or preset ID
belongs in this object. Keys here are existing service fields, not a proposed
new protocol:

```json
{
  "strategy": "article",
  "models": {"fields": "instruct", "reasoning": "instruct"},
  "article": {
    "context": "bounded",
    "context_tokens": 12288,
    "overlap_passages": 0,
    "identity": "reference",
    "identity_fields": [],
    "prompt": "schema",
    "grounding": "spans",
    "grounding_schedule": "unresolved",
    "evidence_policy": "schema"
  }
}
```

Selecting service defaults must omit `article` entirely. Plain rendering,
all-unit selection, token grouping and source-order routing must not add
invented strings to the request. Model keys above are illustrative: served-role
validation remains required. A recipe request retains its selected `recipe`
and adds only the saved recipe factors/budgets; generic Catalog emits no
`catalog` object. Inactive Article preferences never enter a Catalog request.

## Observable acceptance matrix

| ID | Setup / action | Required observable result | Verification seam |
| --- | --- | --- | --- |
| U1 | Fresh account; open Advanced and Explain, switch strategies/tabs | Clean draft, no saves/generation, reference summary; omission retained | Existing ProviderConfigPage component tests + browser |
| U2 | Change model and spans settings; switch tabs; Discard | Both return to saved values; other account remains unchanged | Component + account API |
| U3 | Apply succeeds, then reopen; separately fail a save | Persisted choices survive reload; failed save preserves draft and old saved state | API + guarded PostgreSQL + browser |
| U4 | Bounded + overlap 1 → Full | Choice remains visible, specific error opens section, Apply blocked; switching back resolves it | Component and keyboard browser case |
| U5 | Submit every categorical combination with a valid scalar-key fixture | TS and Python agree; valid choices reachable through UI; invalid requests rejected even without UI | Shared contract fixtures; enumerate factors, with numeric/key boundaries separate |
| U6 | Apply minima, below-minimum, non-integer, duplicate/empty key, unknown factor | Valid integers accepted; malformed inputs rejected without partial save | Configuration contract + Python method checks |
| U7 | Valid method but schema lacks a named scalar key | Start gives exact schema-related error before enqueue/provider calls | Single and batch admission |
| U8 | Keyboard tabs, disclosures and Explain; Escape; 360px and 200% zoom | No lost focus or clipped controls; errors announced; explanatory figure has text equivalent | Browser accessibility and screenshot inspection |
| U9 | Select explanatory starting point, Undo, then Use service defaults | Only intended draft fields change; no saved preset ID; default request shape restored after Apply | Component + adapter |
| P1 | Submit proposed wire example and capture worker request | Strategy, models and all active method options survive transport byte-for-value; no UI labels leak | Existing extraction adapter/workflow tests |
| P2 | Admit A with spans; save quotes; start queued A, restart and recover it | A retains spans; a newly admitted B uses quotes | Real PostgreSQL admission + Studio/Parsing Service recovery tier |
| P3 | Batch with spans; change settings before later members start | Every member retains one batch snapshot; no member reads new defaults | Batch admission/workflow integration |
| P4 | Repeat equal selection; then change only schedule; then change only inactive strategy | Equal active method reuses; changed schedule does not; inactive change still reuses | Batch equality and persisted identity tests |
| P5 | Commit request then drop response, change config, retry original ID/descriptor | Existing run returned once, no enqueue; altered descriptor under same ID conflicts | Real admission transaction test |
| P6 | Change saved settings between start preview and fresh admission, including a barrier-controlled concurrent write | Conflict before enqueue, no hidden method substitution; account write/admission ordering is explicit | HTTP + transaction boundary |
| P7 | No overrides versus explicit reference | Omitted request retains existing behavior/artifact shape; explicit mode remains attributable and distinct where necessary | Adapter + existing scripted no-model reference fixtures |
| E1 | `derived` parent, `quoted` child, inheriting child; then all leaves skipped | Eligible child verified; skipped values and reasons kept; all versus eligible denominator separate; empty eligible = not applicable | Existing schema-policy/grounding and Studio result-adapter tests |
| E2 | Routed verifier sees NONE, missing, refusal, negative attribution and truncation before late support | No early false link; unresolved fallback remains available; refusals visible | Existing grounding/routing tests |
| E3 | Source has Unicode/control chars, same number for two subjects, and a long table cell | Exact canonical ranges survive; coarse geometry not upgraded; wrong offered ID cannot create support | Existing span tests + result adapter |
| E4 | Compound claim's span covers only part of its text | Help describes the limitation; product does not claim mechanical validation guarantees entailment | Content review using Harvey diagnostic, not a fake semantic unit-test oracle |
| E5 | Recipe verification Off; other factors varied | Typed proposals remain reviewable, no accepted grounding; canonical ownership remains intact | Existing recipe tests + adapter |
| F1 | Tokenizer/model unavailable, unsupported option or oversized intact unit | Requested settings and failure retained; no hidden fallback, trimming or invented effective result | Service contract tier; generation can be scripted |
| F2 | Historical row lacks settings; separate run fails before service result | “Not recorded” versus requested settings + “Effective method unavailable”; no today's-default attribution | Persistence/read API + detail component |
| M1 | Existing populated account and queued workflow pass forward migration | Models/keys boundaries unchanged; historical snapshots not fabricated; restart resumes existing work | Disposable migration/recovery checks |
| A1 | Inspect serving imports and request call paths | No experiment/report import; no extraction policy in UI/HTTP; no runtime account lookup for pinned methods | Small structural check + independent code review |

Categorical enumeration covers full/bounded, overlap 0/1/2, both identity modes,
both prompt modes, four grounding modes and the six optional binary factors:
schedule, policy, routing, selection, rendering and grouping. Fix context_tokens
at 12,288 and use declared scalar fields when conservative. Numeric boundaries,
arbitrary field names and served models are separate partitions. This validates
compatibility, not output quality for thousands of model runs; do not launch
the Cartesian product against a provider.

## Existing commands and evidence boundaries

From the future implementation checkout, run `pnpm typecheck`, `pnpm lint` and
`pnpm test` after focused cases pass. The existing fast commands are the normal
checks; do not add a new all-purpose test runner. For focused Python verification:

```sh
cd prototypes/parsing_service
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src:. .venv/bin/python -m pytest -q \
  tests/test_extraction_methods.py tests/test_extraction_span_grounding.py \
  tests/test_extraction_routing.py tests/test_grounding_study.py \
  -m 'not postgres and not live_model'
```

Use the repository's provisioned `.venv`; a fresh worktree does not automatically
contain it. Keep all disposable database targets under the README guard:
loopback port 5432 and `free_test_*`. `pnpm test:postgres` checks persistence;
`pnpm test:e2e` checks the authenticated page and recovery browser flows;
`pnpm test:service` checks the actual Parsing Service boundary with only the
model response scripted. Run these because this change crosses those seams.
`pnpm test:safety` is needed if deployment/safety configuration changes; none is
proposed. Record actual command, candidate hash, outcome and artifact path.

A live-model smoke is a distinct gate for claims about actual provider execution.
It is not needed to establish TS/Python mapping and must never be represented by
a scripted-service pass. New accuracy/speed recommendations require separate,
properly registered evaluation; this feature does not resume the deferred study.

## Independent acceptance and simplification

After implementation and focused checks, freeze the candidate diff. Give one
fresh read-only reviewer the original request, repository instructions, these
specifications, exact diff, surrounding callers and final-candidate test receipts.
Ask for concrete correctness failures, dependency/ownership defects and removable
machinery. “No findings” is acceptable. A persuasive implementer summary is not
the evidence. This pre-implementation pass has no such independent code review.

For each proposed new abstraction ask which boundary/invariant it protects.
Specifically reject a generic settings framework, plugin registry, duplicated
saved/draft state, persisted preset name, second workflow/queue, hidden retry,
schema-policy editor in account configuration, or configuration flags for old
span protocol versions unless new requirements justify them. A useful narrow
boundary is not rejected merely for having one implementation.

Repair only concrete findings and re-run affected checks against the final tree.
Never weaken assertions or contract rules to obtain a pass. After two failed
repair rounds, revisit the design and expose the unresolved issue. Record the
candidate tree hash, reviewer disposition, tests actually run and limitations.
Any subsequent edit requires appropriate revalidation and review of that edit.

### Maintenance probe

In a disposable branch after the candidate passes, remove the new UI from the
execution path and submit a valid existing method descriptor through the
extraction package test seam. It must run using its supplied immutable settings
without provider-config React imports or reads of current account defaults.
Then add a help-only example topic: it must require only local explanation
content and its accessibility check, with no database/workflow/parser change.
Inspect affected files and discard the probe. No second design is merged.

## Specification verification receipt

Performed against baseline `4e2a5820`, using the existing Parsing Service Python
environment with bytecode writes disabled:

- OpenSpec CLI 1.13.2: `validate advanced-extraction-configuration --strict`
  passes. This validates specification structure, not implemented behavior.
- All nineteen `contract-cases.json` expectations match the existing Python
  `ArticleOptions` validator. The receipt pins the validator and fixture hashes:
  [contract-check.json](contract-check.json).
- The categorical inventory described above visits 6,144 inputs: 1,560 accepted
  and 4,584 rejected by the existing Python validator. This is a bounded inventory
  at one numeric ceiling/key fixture, not all possible configurations, UI
  coverage, TS/Python parity or an empirical quality study.
- All local Markdown links resolve. No code, migrations, dependencies, account
  state, experiment artifacts, live services or provider requests were changed.

Product tests, browser flows, migrations and model execution were not run for
this documentation-only pass. There is no independent implementation review to
claim. Implementation tasks remain unchecked.

To recheck the nineteen contract cases without a model or database, run from the
repository root using a provisioned Parsing Service environment:

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=prototypes/parsing_service/src \
  prototypes/parsing_service/.venv/bin/python - <<'PY'
import json
from pathlib import Path
from pydantic import ValidationError
from kei_exp.kie.extract.method import ArticleOptions

path = Path('openspec/changes/advanced-extraction-configuration/contract-cases.json')
cases = json.loads(path.read_text())['cases']
for case in cases:
    try:
        ArticleOptions.model_validate(case['input'])
        accepted = True
    except ValidationError:
        accepted = False
    assert accepted == case['accepted'], case['id']
print(f'{len(cases)} contract examples match')
PY
```

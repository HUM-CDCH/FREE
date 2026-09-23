# FREE service consolidation validation

Created: 2026-09-22. Updated: 2026-09-23. Status: consolidation implemented in
`b07741d`; subsequent discovery and launcher changes remain uncommitted.
Validation is incomplete. The September 23 results below supersede the older
Qwen result; see also [the coordinator handoff](2026-09-22-service-consolidation-handoff.md).

## Change under test

The backend from kei-exp `93b9435c2b9a01a5424758d917c058fc79bbc159`
now lives in `prototypes/parsing_service`, replacing the former parser.
FREE owns the API, worker, job database/schema, shared run storage, and model
servers. Studio calls the private Compose service. See
[ADR 0009](../adr/0009-own-parsing-and-extraction-service-in-free.md).
No sibling checkout, agent worktree, runtime data, or research PDF is required.

## Reproduction

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:safety
pnpm test:e2e
pnpm test:service
pnpm --filter studio build
pnpm architecture:check
```

`test:service` provisions isolated PostgreSQL and mock OIDC, uses the imported
Python environment, and starts a real API and worker. Its generated native
PDF contains a "Site catalogue" heading and two separate entries on one page. Only extraction completions are
scripted; their values are derived from actual parsed prompt text. It checks:

- authenticated upload and canonical artifact import;
- Article and Catalog extraction, each with two records and six grounded values;
- saved review and browser evidence navigation;
- API/worker restart before extraction and after accepted results;
- identical accepted artifacts after restart; with scripted completions, it also
  proves that restart makes no additional model calls.

To repeat with a real model instead of scripted completions:

```bash
FREE_REAL_EXTRACT_URL=http://127.0.0.1:PORT/v1/chat/completions \
FREE_REAL_EXTRACT_MODEL=qwen3:8b pnpm test:service
```

Database tests require caller-provisioned, guarded disposable targets; see
[the development runbook](../operations/local-development.md#verification).
The audit used its own `free-monorepo-parsing-tests` container on loopback 5432,
with `free_test_project_store`, `free_test_extraction`, and `free_test_parsing`.
Existing databases on other ports and the existing model server were not used.

## September 23 discovery prompt validation

Disabling Qwen reasoning fixed the captured token loop, but subsequent headed
inputs exposed discovery errors: the model could mistake a heading for a record
or exclude a final continuation while reporting `complete: true`. The full
[918-call investigation](../../artifacts/handoffs/2026-09-22-service-consolidation/codex-investigation/report.md)
is local evidence, not a real-catalogue accuracy benchmark. Its cases and prompt
examples were developed together.

Discovery now includes three examples with reasoning still off. The second
example uses different names from case Q and includes a continuation before
the bibliography. `PROMPT_VERSION` is 4, so the extraction fingerprint does not
reuse results from earlier prompts. No second discovery call or disagreement
policy was added.

The changed prompt was measured through the actual `discover()` function and
`OpenAIChat` adapter at the runtime 8192-token cap, twice on each A–Q input.
It scored **30/34 exact boundaries**, including a correct first request after
unloading the model. Q retained its final continuation in both runs. The failures
changed: L still returns no starts and raises `no_records_found`; **N now selects
German district headings as record starts**, with no discovery issue. The prior
three-example candidate got N right and Q wrong. Equal totals do not establish
that the revised prompt is uniformly better. Populated-value grounding and
`complete` do not prove that all source records were discovered correctly.

Focused extraction stage/client tests: **32 passed**. The existing multi-chunk
unit checks passed; real-model multi-chunk behaviour remains unvalidated.
The scanner and manual bloat review found no blockers; existing numbering
diagnostics were preserved, including their known false-positive boundary.

Reproduction and captured requests/replies are in
[`discovery-prompt-v4/`](../../artifacts/handoffs/2026-09-22-service-consolidation/discovery-prompt-v4/):

```bash
prototypes/parsing_service/.venv/bin/python -m pytest \
  prototypes/parsing_service/tests/test_extract_stages.py \
  prototypes/parsing_service/tests/test_extract_llm.py -q
prototypes/parsing_service/.venv/bin/python -B \
  artifacts/handoffs/2026-09-22-service-consolidation/discovery-prompt-v4/probe.py
```

The probe unloads only the task-owned local `qwen3:8b` at port 32769 before its
first request. It is an exploratory replay, not part of deterministic CI.

| Fresh workflow check | Result and scope |
| --- | --- |
| Local real-model service E2E | **Pass**, 6.5 minutes: authenticated headed native PDF, Article and Catalog exact values, six evidence links each, review, evidence navigation, and API/worker restart persistence |
| Spark native Catalog | **Pass**: authenticated Studio upload through development nginx/mock OIDC, two exact records, six grounded values, review, evidence navigation, and reload |
| Spark scanned Catalog | **Pass**: the same headed page rendered into an image-only PDF, real Surya OCR, and the same Catalog/browser assertions |

The local successful command was the existing Playwright service entrypoint
with `OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2` and the real
model URL/model variables above. Initial attempts failed disposable PostgreSQL
readiness and then the 180-second upload timeout, before extraction. The host
had little available memory and full swap; unrelated workloads were left alone.
Neither timeouts nor result assertions were weakened. The successful run is
recorded in `discovery-prompt-v4/local-real-service-threads2.log`; service logs
and browser evidence are retained under `local-success-results/`.
This real-model tier establishes identical artifacts after restart, not the
scripted tier's extra assertion about model call counts. The deterministic
service tier was not rerun in this continuation.

Spark validation used `/home/geba/Projects/FREE`, with explicit user approval
to copy only `stages.py` and `run.py` into the checkout and API/worker containers
and restart those two services. Saved service artifacts confirm prompt version
4 and six evidence links for both PDFs; the scanned manifest records OCR token
usage while the native manifest records none. The browser runner, PDF inputs,
page artifacts, screenshots and results are in `discovery-prompt-v4/`.
Two initial browser-runner mistakes (the `/free` resource prefix and whitespace
in a button selector) were corrected in that local validation script. The final
run passed both documents. All synthetic Studio projects from these attempts
were removed; backend run artifacts remain as evidence. The temporary SSH
tunnel was closed. Spark and the task-owned local model remain running.

The Spark checks validate patched running development containers, not freshly
rebuilt images or production Entra authentication. Recreating either parsing
container from the old image would lose its copied source changes: rebuild
from the updated checkout before recreating it. The successful Spark browser
checks cover reload, not a second restart after extraction. The local service
E2E supplies the fresh API/worker restart coverage.

## September 22 results (preserved evidence)

- Workspace type checks and lint passed; lint retains three existing React Hook warnings.
- Fast unit aggregate passed, including 583 backend tests. 73 backend cases skip
  because their exact optional upstream research PDFs are not distributed here.
- Launcher checks and all 14 safety checks passed, including CPU/GPU Compose
  rendering, nginx validation, and ordered build/stop/migration startup.
- FREE PostgreSQL checks passed: 3 Project Store and 20 extraction tests.
- Backend PostgreSQL checks passed: 106 tests; 4 optional research-fixture skips.
- Real native API + worker + PostgreSQL parsing smoke passed.
- Interrupted-worker recovery passed on a generated 300-page native PDF
  (136.82 seconds, CPU); the recovered job reached its authoritative terminal state.
- Deterministic complete service/browser workflow passed in 24.2 seconds.
- Full default browser suite passed: 50 tests, 1 expected developer-UI skip.
- Studio production build and architecture validation passed.

The first real `qwen3:8b` run passed Article extraction but failed the exact
Catalog result assertion. After a cold model load, the `Valley` record call
spent all 8192 tokens in a repeating reasoning loop (greedy decoding in Qwen3
thinking mode) and returned no content; this reproduced in 6 of 6 cold replays
of the captured requests. Extraction calls now send `reasoning_effort: "none"`
(`PROMPT_VERSION` 2). The same cold replays then answered correctly 4 of 4
times, and the complete real-model workflow passed 3 of 3 times from a cold
model load (25 seconds each). The real-model tier does not count model calls;
only the scripted tier proves no extra calls after restart. Both Docker
image builds were deliberately interrupted while resolving host disk pressure;
the host Studio build passing does **not** establish that those images build.

Validation found and repaired two defects: the Catalog DTO required diagnostics
from the removed local pipeline, and a pending provider stream read overwrote
an explicit cancellation trace. Both have regression coverage.

## Boundaries

The complete local service test uses native PDF parsing. The September 23 Spark
check additionally proves one generated scanned page through the running GPU
stack; it does not establish real-catalogue OCR quality, arbitrary GPU/image
compatibility, or production HTTPS/Entra deployment. The imported
Catalog implementation still cannot place two record starts within one parser
segment; preserving separate native blocks addresses the test's two-entry page,
not the full character-span boundary design.

The import keeps canonical file formats and the Python package names. It removes
the obsolete parser, standalone experimental web launcher, standalone model
launcher, and unused Modal dependency. Historical source specifications remain
beside the service for code-referenced contracts. Runtime data from an existing
separate kei-exp deployment is not migrated; existing FREE research data is not
reset.

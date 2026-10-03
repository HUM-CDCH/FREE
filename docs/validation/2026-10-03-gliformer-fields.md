# GLiFormer optional fields backend — October 3, 2026

Implemented on `feat/gliformer-fields`, based on `4f233aac`, in a separate
worktree. The dirty research checkout was not edited. This is a development
integration, not a production cutover or extraction-quality evaluation.

## Checks

- 195 Python checks passed (9 PostgreSQL/live-model cases deselected): native
  backend, routing, adapters, counters, grounded/unified Catalog, untrusted
  source, API reads and extraction workflow contracts.
- 169 extraction-package tests passed, including the Python-produced native
  artifact's acceptance by TypeScript with raw records, diagnostics and
  ungrounded paths intact.
- 55 Studio tests passed: Catalog review, provider configuration and model
  listing. GLiFormer is selectable for fields, absent from reasoning choices,
  and its supported scope is displayed. Decoder scores remain explicitly
  distinct from learned confidence.
- Extraction and Studio typechecks passed; changed Studio files passed ESLint.
- Compose rendered with the existing development/GPU overlays plus
  `compose.gliformer.yaml`: native model has no published port, uses the private
  app network and a 12 GiB memory cap; both parsing processes receive its URL.
- Native backend tests and TypeScript artifact acceptance were rerun after the
  final provenance-envelope and encoder call-accounting adjustments.
- Two explicit live-model checks passed against the final built service image:
  instructions enter the tokenized prompt and inference count, and oversized
  inputs / foreign identities are refused.

Commands were run with the repository's installed dependencies. Python used
the existing locked environment with `PYTHONPATH=src` pointing at this worktree.
No database was reset, migrated or used by these checks. The generated DB type
contract was emitted locally to permit TypeScript checking.

## Isolated Spark probe

The standalone image built on ARM64/GB10 from
`vllm/vllm-openai@sha256:8a69ffad015f138d7170c4ddc429e230a3bc1c1719f67e14324749df200a4b90`.
Final image: `sha256:47fab17de9aeb3ba94b0a0eedf81469f91b45cbd5477ddb2a6206da60426a13e`.
Model and framework revisions are pinned in the service source. Threshold was
0.05. Only a temporary model container was started; existing FREE and playground
containers were not restarted or reconfigured.

A canonical test source contained the supplied grave 200, 204 and 10,031
excerpts plus a separate narrative summary. Real Qwen discovery produced three
entries and classified the summary as `other`. Three native GLiFormer calls
received 105, 70 and 78 tokens respectively; no generation budget was reserved.
The result held five raw predictions, three native windows and 10 populated
ungrounded paths. The real artifact passed TypeScript acceptance with its
parse identity and execution/discovery digests intact. A separate built-image
inference probe confirmed the request count against the native collator. The
service supplies schema descriptions via the native processor's `item.prompt`;
descriptor descriptions alone do not reach that processor in the pinned library.
The final grave schema guidance adds 26 tokens to each of the three requests.
The revised prompt identity correctly refused reuse of an earlier execution.

A request exceeding 6000 input tokens returned HTTP 413 without inference. A request with a
foreign pinned identity returned HTTP 409. Unit tests separately cover retry
after a timeout: completed entries are reused and only unfinished work repeats.

Known model errors were preserved: grave 200 returned `i` as an identifier,
male/goatskin appeared in a separate record with no identifier, and 10,031 had a
separate skin record with `Adult male` under sex and no identifier. Neither these
predictions nor their native scores were corrected. Source-window isolation
does not prove semantic attribution. This was not the full Mostagedda PDF, a
human-annotated benchmark or a holdout evaluation.

## Bloat audit

Pass; no remaining blockers. Removed an unnecessary runtime-directory setting
and avoided generating/conforming placeholder records on the native path.
The explicit optional backend, private model service, URL/threshold settings,
and browser-safe native-result contract are required by this integration.
The broad exception catch in call tracing records only the exception type and
immediately rethrows, matching the existing privacy contract; it is not a
fallback. `FREE_UPDATE_GOLDEN` is the repository's existing fixture-update
mechanism. No compatibility framework, new queue or workflow sequence was added.

Remaining limits: unified Catalog and the documented string/list schema subset
only; values are unverified; model scores are uncalibrated. Production Studio
and DBOS recovery against the real native server were not exercised. The
normal launcher does not automatically include the experimental overlay.
See the [operator instructions](../../prototypes/parsing_service/model_servers/gliformer/README.md).

## PR #164: Baratheon application verification

The integration was cherry-picked onto current `dev` (`89612460`) as
`feat/gliformer-fields-dev`, without the unrelated research-branch history.
[PR #164](https://github.com/HUM-CDCH/FREE/pull/164) records the final verification
outcome, merge SHA and deployment smoke. Baratheon's isolated checkout is
`/home/geba/Projects/FREE-pr164`; its main checkout's local deployment edits are
preserved. Git bundles transfer the exact reviewed commits because Baratheon
has no working GitHub SSH credential.

The checks run on Baratheon, with the locked Python environment and
`PYTHONPATH` explicitly pointing at the PR checkout, include:

- `pnpm test:unit:node`: 2,265 passed (1,888 Studio tests and 377 Node tests).
- The complete Python fast suite: 1,353 passed, 72 skipped, 79 deselected.
  Skips include optional fixtures; PostgreSQL and live-model tests are excluded
  from this fast tier.
- Native adapter and explicit GPU protocol tests: 20 passed, including real
  token/inference agreement, over-budget refusal and foreign-identity refusal.
- Whole-workspace typecheck and lint passed. Lint reports two existing hooks
  warnings in `useExtraction.ts`, with no errors.
- Safety tier: 29 passed.
- General browser tier: 59 passed initially, two sign-in readiness timeouts,
  six not run after a serial-group failure, five intentionally skipped.
  Both failures passed unchanged with one worker; all 17 model-configuration
  tests then passed serially, covering the six deferred cases. All five
  Studio/ingestion restart-recovery browser tests passed separately.
- The native real-model application test initially passed in 46 seconds:
  authenticated upload, real PDF parsing, saved field/reasoning selection,
  PostgreSQL/DBOS admission and execution, raw output accepted unchanged by
  Studio, confidence display, parsing API/worker restart, reload and CSV export.
  Three discovered entries produced three native windows and three records.

`e2e/gliformer-route.spec.ts` is an explicit opt-in test on the existing real
service harness. It uses actual Qwen and native GLiFormer endpoints, its own
mock-OIDC accounts and disposable database, and no production research state.
The service harness clears inherited native-backend configuration unless the
real-model run explicitly names it. These tests do not prove Entra browser
login or an interrupted native GPU call's DBOS recovery; component tests cover
checkpoint reuse and identity-change refusal.

A fresh upload of the seven-page Mostagedda PDF (SHA-256
`37321a719f736c7ecc5f6d52a1f1dbfbcb5296361c9a191906a513276caead78`)
produced 289 canonical anchors. The first full application run passed transport,
persistence, restart and export, but inspection found a semantic scope error:
Qwen treated numbered discussion sections as graves and sent page-seven text to
GLiFormer. The development test schema was clarified to distinguish grave
identifiers from numbered sections. Assertions now require grave 10,031's input
and refuse page-seven or discussion-section inputs for this known PDF. No
production page-number filter, grave-ID rewrite or material repair was added.
The final rerun and artifacts are reported in the PR; the initial full result is
not a catalogue-only success or extraction-quality evidence.

Reproduction from the Baratheon checkout (use the current OCR container address):

```sh
export PYTHONPATH="$PWD/prototypes/parsing_service/src"
export FREE_CATALOG_METHOD=unified
export FREE_REAL_EXTRACT_URL=http://127.0.0.1:18080/v1/chat/completions
export FREE_REAL_EXTRACT_MODEL=nvidia/Qwen3.8-27B-NVFP4
export FREE_REAL_GLIFORMER_URL=http://127.0.0.1:17866
export FREE_REAL_EXTRACT_TIMEOUT=1800
# For the full scanned PDF also set FREE_REAL_OCR_URL and FREE_GLIFORMER_ROUTE_PDF.
# FREE_GLIFORMER_ROUTE_OUTPUT retains canonical/model/Studio artifacts and export.
pnpm --filter studio exec playwright test --config playwright.service.config.ts gliformer-route.spec.ts
```

The tested native image is the pinned image above, threshold 0.05. Parsing and
Studio images were built on Baratheon from `20904947`; subsequent code changes
are confined to the test's schema and boundary assertions. Image IDs:

- Parsing: `sha256:2a5d6823aea1b0e6bf0cfd221128289badd6f8e336d8a30f4e4c0b026b14c74f`
- Studio: `sha256:af117c4e6e8680929f6c7d984c2a286d9dbdf7f39f7757ced5d1c6ab6c55f74c`

Manual review of the full PR diff found no bloat blockers. The optional model
service and backend are required by the requested architecture; the real-model
test uses the existing durable test stack. No workflow sequence, schema
migration, production default or quality-release gate is changed. Native output
still includes wrong IDs, extra records and false material mentions; confidence
is not calibrated. This is development integration evidence, not human gold or
a held-out quality evaluation. The live deployment's unified-method gate stays
at its existing value; installing code does not activate the experimental method.

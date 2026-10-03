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

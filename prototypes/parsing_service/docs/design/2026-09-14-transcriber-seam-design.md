# Transcriber seam and VLM assembly: design

Imported from kei-exp `93b9435c2b9a01a5424758d917c058fc79bbc159`. This document
retains the original internal design or measurements. The service README and
FREE root deployment runbooks govern the current runtime and verification commands.

Current locations (2026-09-21): contracts and adapters now live in `src/kei_exp/transcription/`;
the registry and execution live in `kie/stages/ocr.py`. See the [current code organization](../../README.md#code-organization).
The original module map below records the design at the time.

Date: 2026-09-14. Status: approved in chat (approach 3 of three, one report writer with richer diagnostics, all code written by the assistant).

Source: the 2026-09-14 architecture review of kei-exp (16 agents, six candidates, none refuted), whose top recommendation was candidate 2 (deepen the VLM assembly) followed by candidate 1 (one transcriber seam over the Surya path and the Docling VLM path). Candidate 4 (one debug report writer) is folded in because the seam's outcome carries page records anyway. Candidates 3, 5 and 6 are out of scope, as are the web and API defects listed in REVIEW.md.

## 1. Problem

`convert()` in `src/kei_exp/__init__.py` is the only interface to a transcription and knows both backends' shapes: it asks "is this Surya" four times, pushes the Surya HTML stream through Docling itself, remaps its RuntimeError, and interprets Docling's ConversionStatus, ResponseFormat and vlm_response. Building Docling's converter is spread over `make_vlm_options`, `convert()` and `PreprocessedVlmPipeline`, coupled by two side channels: the stream flag rides in the request params and is sniffed back to swap the engine, and the progress emitter rides in a ContextVar because Docling constructs the pipeline from options alone (the ContextVar does not survive Docling's thread pool if batch concurrency is ever raised above 1). The render-scale rule is stated in five places. Two debug report writers with two schemas exist, and the cut commit had to edit both. Every check reaches past `convert()`'s interface to exercise the backends.

## 2. Goals

- One seam: a `Transcriber` contract that both backends satisfy and that a third backend can join without editing `convert()`.
- One outcome type: Markdown, completeness, page records and run-level facts, produced by adapters that never write files and never decide acceptance.
- One VLM assembly module owning everything between a model record and a ready Docling run, with the streaming engine and the emitter bound at build time and the scale rule stated once.
- One debug report writer with one schema for both backends, carrying more diagnostics than today.
- Unchanged CLI and API contracts: flags, exit codes, HTTP status codes, event types and shapes, output locations.
- The five scratch checks stay green after every step; each check exercises the new seams rather than mocked internals.

## 3. Non-goals

- cut.py geometry, streaming.py, runtime.start_server, docker-compose and serve.sh (candidate 5), `--cut none` as a crop producer (candidate 6).
- The web app, the SSE race, Last-Event-ID, upload limits and the other REVIEW.md items.
- Changing which pixels reach a model, prompts, allowances or generation parameters.

## 4. Module map

| File | Responsibility |
| --- | --- |
| `src/kei_exp/transcription.py` (new) | The seam's contract: `RunParams`, `Execution`, `ConversionError`, `PageRecord`, `Transcription`, the `Transcriber` Protocol. No Docling or Surya imports. |
| `src/kei_exp/vlm.py` (new) | Docling VLM adapter `DoclingVlm`: assembly (`vlm_options`, `engine_options`, `assemble`, `pipeline_class`), the run, page records, Markdown extraction. |
| `src/kei_exp/surya_ocr.py` (new) | Surya adapter `SuryaOcr`: settings, page range check, the `KeptOutputs` wrapper from the guard fix, one predictor call, page records, HTML join through Docling's HTML backend. |
| `src/kei_exp/report.py` (new) | `write_report`: report.json, page PNGs, page_stats and log events. |
| `src/kei_exp/native.py` (2026-09-14 afternoon) | `has_native_text` and the native adapter `NativeText` (`kind = "native"`, no knobs): Docling's standard PDF pipeline over the embedded text. |
| `src/kei_exp/__init__.py` | `DEFAULT_URL`, the `TRANSCRIBERS` registry, `resolve`, `convert`, `page_range`, `main`; re-exports `RunParams`, `Execution` and `ConversionError`. No Docling imports. |
| `src/kei_exp/models.py` | Records only: `Model` gains `kind` and carries a Docling `spec` for every VLM record; `vlm` becomes a property; `make_vlm_options` and `api_engine_options` move to vlm.py. |
| `src/kei_exp/cut.py` | Gains `Crop` and `region_info` beside `Region` (moved from the package root). |
| `src/kei_exp/progress.py` | Loses `current_emit`. Event rendering unchanged. |
| `src/kei_exp/api.py` | Resolves the execution at upload, before the run has a directory; `resolve`'s ValueError is its 400. `/api/models` additionally lists each record's accepted knobs. |
| `scratch/check_*.py` | Rewritten where they reached past the seam (section 11). |

## 5. The seam

```python
@dataclass(frozen=True)
class RunParams:            # unchanged fields, moved here
    pdf: Path; model: str = "granite_vision"; url: str = DEFAULT_URL; cut: str = "auto"; crop_dpi: int = 250
    max_image_size: int | None = None; max_output_tokens: int | None = None; stream: bool = False
    pages: tuple[int, int] | None = None; debug_dir: Path | None = None

@dataclass(frozen=True)
class Execution:            # what will actually run, resolved once from RunParams (2026-09-14 afternoon)
    pdf: Path; transcriber: str; model: str | None; repo: str | None; url: str | None; cut: str
    layout_model: str | None; crop_dpi: int | None; max_image_size: int | None; max_output_tokens: int | None
    stream: bool; pages: tuple[int, int] | None; debug_dir: Path | None

class ConversionError(RuntimeError):
    """A run that produced no trustworthy output; the message is what the CLI prints before exit 1."""

@dataclass(frozen=True)
class PageRecord:
    page: int                     # running number in reading order, across crops
    region: dict | None           # region_info(crop); None for whole pages
    image: Image.Image | None     # exactly what the model received, in the mode to save; None when not kept
    seconds: float | None         # generation time when the backend reports one
    input_tokens: int | None
    output_tokens: int | None
    stop: str | None              # VLM stop reason; None for Surya
    capped: bool                  # the kept output used up its token cap
    payload: dict                 # {"prediction": ...} for VLMs; {"blocks": [...], "image_bbox": [...]} for Surya
    stats: dict                   # extra page_stats event fields, exactly as rendered today; empty means no event

@dataclass(frozen=True)
class Transcription:
    markdown: str                 # "" when incomplete
    incomplete: str | None        # None when every page completed; otherwise why not, in one sentence
    header: dict                  # backend facts for the report: prompt, scale, max_size, max_output_tokens, generation_params, errors
    pages: list[PageRecord]

class Transcriber(Protocol):
    kind: str                     # registry key: the value of Model.kind, or "native"
    knobs: frozenset[str]         # RunParams fields honoured beyond pdf, model, url, cut, layout_model, crop_dpi, pages, debug_dir
    def transcribe(self, execution: Execution, crops: list[Crop] | None, emit: Emit) -> Transcription: ...
```

Registry, in the package root: `TRANSCRIBERS: dict[str, Transcriber] = {t.kind: t for t in (DoclingVlm(), SuryaOcr(), NativeText())}`. Importing the package fails if a record's `kind` is not registered. Adapters that run a model look up `MODELS[execution.model]` themselves; no `Model` travels through the seam, and the native adapter has none.

Resolution (amended 2026-09-14 afternoon; before it, native extraction bypassed the registry and `record is None` travelled through `convert()`, the report writer and the API): `resolve(params) -> Execution` makes the execution choice exactly once per run. When `has_native_text(params.pdf, params.pages)` holds, the execution names the native transcriber with no model, repo, url, layout model, crop dpi or image knob, `cut = "none"` and `stream = False`, whatever the request asked for; otherwise it names the record's transcriber with the request's settings (`layout_model` only with `cut = "auto"`) and raises ValueError naming any knob set that the transcriber does not honour (`DoclingVlm.knobs = {"stream", "max_output_tokens", "max_image_size"}`, `SuryaOcr.knobs = NativeText.knobs = frozenset()`). The CLI turns that into exit 2 and `create_run` into 400; a page range outside the PDF is a ConversionError from the predicate (exit 1). A selection mixing native and scanned pages runs one transcriber, the record's. Visible change kept from the first version: `--max-image-size` with `--model surya` is refused instead of silently ignored.

Dispatch, in `convert()`:

1. `convert(execution)` takes the resolved execution; the choice and the knob refusal already happened in `resolve`.
2. Cut when `execution.cut == "auto"`: phase event, `cut_document`, CutError becomes ConversionError, no crops becomes ConversionError, one region event per crop. Unchanged.
3. `outcome = TRANSCRIBERS[execution.transcriber].transcribe(execution, crops, emit)` timed with a wall clock.
4. If `execution.debug_dir` is set, `write_report(outcome, execution, started, seconds, execution.debug_dir, emit)`; the report is written before acceptance so it survives an incomplete run.
5. Raise `ConversionError(f"Conversion incomplete; output not written: {outcome.incomplete}")` when incomplete; otherwise return the Markdown. A complete outcome with blank Markdown is normalised to an incomplete one ("the transcriber returned no text") before step 4, so the report never claims success for a run the caller refuses.

Adapters raise ConversionError only for conditions that leave nothing to report: an out-of-range page range with whole pages, and Surya's own runtime failures (its `SpawnError` for an unreachable server or a model mismatch is a `RuntimeError`), which the Surya adapter translates. Everything else is an incomplete outcome.

## 6. Docling VLM adapter (vlm.py)

Records carry their Docling model spec directly: `granite_vision`, `granite_docling` and `nanonets_ocr2` take `model_spec` from the registered presets `VLM_CONVERT_GRANITE_VISION`, `VLM_CONVERT_GRANITE_DOCLING` and `VLM_CONVERT_NANONETS_OCR2`; `infinity_parser` keeps its inline spec. Verified equivalent to `from_preset`: every preset used has scale 2.0 (the field default), no max_size and no stage options. The MODELS key no longer has to equal a Docling preset id.

- `vlm_options(record, url, max_image_size, max_output_tokens) -> VlmConvertOptions`: API engine options with `{"model": record.repo, **record.params}` and a 600 s timeout, `model_spec` copied before editing (presets and records stay pristine), the record's allowance then the override, `max_size` set. No stream flag in the params.
- `engine_options(options) -> ApiVlmEngineOptions`: the narrowing helper, unchanged in behaviour.
- `pipeline_class(engine: BaseVlmEngine | None) -> type[VlmPipeline]`: a class defined per call. Its `__init__` swaps the engine of the first build stage when one is given. Its `_initialize_page` keeps the page image at the inference render: `page._default_image_scale = min(options.scale, options.max_size / max(page.size))` when both are known. Docling reads `page.image` for DocTags geometry and would otherwise render a second uncapped image; the override is not report-only.
- `assemble(record, params, crops, emit) -> Assembly` where `Assembly(options, pipeline_options, converter, format, scale, max_size)`: the scale rule stated once (`max_size = params.max_image_size or (largest crop edge if crops else 1200)`; `scale = 1.0` for crops because they are tagged 72 dpi, else the spec's scale), pipeline options with `enable_remote_services=True`, `generate_page_images = params.debug_dir is not None`, `images_scale = scale`; `ImageFormatOption` for crops or `PdfFormatOption` for whole pages; the engine is a `StreamingVlmEngine(enable_remote_services=True, options=engine_options(options), emit=emit)` when `params.stream`, else None. Each run builds its own `DocumentConverter`, so the per-run class cannot collide in Docling's cache.
- `DoclingVlm.transcribe`: phase event `vlm` with the total; crops go through `convert_all` over `png_stream`s named `{stem}-p{page}-r{order}.png`, whole pages through `convert(pdf, page_range=...)`; both with `raises_on_error=False`. Page records: one per Docling page across results, image from the document page when kept and normalised RGB then RGBA as Docling's API path encodes it, `seconds` from the prediction's generation time, tokens from usage, `stop` from the stop reason, `capped = stop == "length"`, `payload = {"prediction": prediction dump}`, `stats = {"input_tokens", "output_tokens", "stop"}` with "unavailable" for missing usage exactly as today. Incomplete when any result status is not SUCCESS, with the error items as the reason. Markdown: for `ResponseFormat.MARKDOWN`, the page texts joined by blank lines with an outer ```markdown fence removed; otherwise `export_to_markdown()` per result. Header: prompt, scale, max_size, max_output_tokens (the allowance in force), generation_params (the engine params), errors (error item dumps), docling_status (the first non-success status value or "success").

## 7. Surya adapter (surya_ocr.py)

- Settings: after a lazy import of `surya.settings`, assign `settings.SURYA_INFERENCE_BACKEND = "vllm"`, `settings.SURYA_INFERENCE_URL = url without /chat/completions`, `settings.SURYA_MAX_TOKENS_FULL_PAGE = record.max_new_tokens`. Verified: all three are read at call time (`_autodetect_backend`, the vllm backend's `start`, the recognizer's full-page request) and the settings model is not frozen. No environment writes, no import-order rule, no per-process URL freeze. The lazy import stays so VLM runs never load torch.
- Images: the crops' images, or whole pages through Surya's `load_from_file` at `round(72 * record.scale)` dpi with a 0-based page range; the range is checked against the page count first and raises ConversionError when outside it.
- Guard: `Kept` and `KeptOutputs` from the guard fix (the wrapper around `SuryaInferenceManager` that records per page the token count of the output Surya keeps, and which request used up its cap: `Kept.capped` is that request's description or None). The wrapper takes the page images, because Surya numbers a rebuilt page's block requests within the fallback subset and only the layout batch, whose items carry the page images themselves, reveals that subset. One `RecognitionPredictor(KeptOutputs(SuryaInferenceManager(), images))(images)` call; concurrency stays Surya's.
- Page records: image as handed to Surya (raw, never RGBA-normalised: Surya's client sends it as-is after its own scale_to_fit), `output_tokens` and `capped` from the wrapper, `payload = {**page.model_dump(mode="json")}` (blocks and image_bbox), `stats = {"blocks", "errors", "skipped", "output_tokens", "capped"}` as the guard fix renders them.
- Incomplete: `incomplete_reason(crops, pages, kept, unattributed, empty)` names every capped page with the request that capped it (the source page without cuts, any capped request no page could be attributed to, and every rebuilt page that came back without a block because its layout request failed); Markdown is then "" and the HTML join is skipped. Otherwise the non-skipped block HTML is wrapped in one HTML document and converted by Docling's HTML backend; a non-SUCCESS status there is also incomplete.
- Header: prompt None, scale `record.scale` for whole pages else None, max_size None, max_output_tokens `record.max_new_tokens`, generation_params None, errors [].

## 8. Report writer (report.py)

`write_report(outcome, execution, started, seconds, directory, emit)` writes `page-N.png` for every record with an image, exactly as handed (the VLM adapter hands RGB-normalised, RGBA images as Docling's API path encodes them; the Surya adapter hands the raw request image), emits one `page_stats` event per page with a non-empty `stats` as `{"type": "page_stats", "page": n, "image": pixels, **record.stats}`, writes `report.json`, and emits the `Debug files: <dir>` log line. The writer never branches on the backend. Schema:

```json
{
  "transcriber": "vlm | surya | native", "model": "<MODELS key>" | null, "repo": "<vLLM model id>" | null, "url": "<chat completions url>" | null,
  "source": "<pdf file name>", "pages_requested": [1, 45] | null, "cut": "auto | none", "crop_dpi": 250 | null,
  "layout_model": "<LAYOUT_MODELS key>" | null, "stream": false,
  "started": "<ISO 8601 UTC>", "seconds": 12.3,
  "status": "success | incomplete", "incomplete": null | "<reason>",
  "prompt": "<text> | null", "scale": 1.0 | null, "max_size": 1200 | null, "max_output_tokens": 16384,
  "generation_params": {} | null, "errors": [], "docling_status": "success | partial_success | failure" (VLM only),
  "tokens": {"input": 5258 | null, "output": 5588 | null},
  "versions": {"docling": "2.126.0", "surya-ocr": "0.22.1"},
  "pages": [
    {"page": 1, "region": {"source_page": 1, "kind": "column", "bbox": [..], "order": 0} | null, "image_pixels": [w, h] | null,
     "seconds": 3.2 | null, "input_tokens": 1156 | null, "output_tokens": 512 | null, "stop": "end_of_sequence" | null, "capped": false,
     "prediction": {...}}
  ]
}
```

Top-level keys come from the execution as it is (a native run reports null model, repo, url, crop dpi and layout model), `status`/`incomplete` from the outcome, the header keys from the adapter, `tokens` are the sums over pages that report them (null when none does), `versions` from importlib.metadata. Page entries are the record's diagnostics plus its payload keys. Reusing a directory overwrites matching files as today.

## 9. Callers

- CLI `main()`: unchanged flags and exit codes; `resolve` runs once, ValueError becomes `parser.error` (exit 2), ConversionError exit 1; `--start-server` starts a server only when the execution names a model.
- API `create_run`: saves the upload beside the runs, counts pages, checks the range, resolves the execution under the pdfium lock and, when a model runs, checks the server; only then does the run get its id (the model key, or `native`) and its directory. `params.json` records the execution (`transcriber`, and `model`, `repo`, `url`, `crop_dpi`, `layout_model` as null when unset); there is no `extraction` flag. The summary carries `transcriber` and a null `model` for native runs; runs recorded before this amendment have neither field derived for them. The web describes a run in one place, `describeRun(run)`. `/api/models` adds `"knobs": [...]`. `run_job` calls `convert(job.execution)`.
- Events: types and shapes unchanged (`phase`, `region`, `page_start`, `token`, `page_end`, `page_stats` in its two shapes, `log`, `status`).

## 10. Models

`Model(repo, kind="vlm", context=32768, max_new_tokens=None, params={}, spec=None, scale=3)`; `vlm` is a property `kind == "vlm"`. The Surya record is `kind="surya"`. `spec` is required for `kind == "vlm"` (asserted when MODELS is built). `scale` stays (Surya's whole-page dpi) until candidate 6.

## 11. Checks

- `check_conversion.py`: a fake transcriber registered under a test kind exercises `convert()` alone: incomplete outcome (exit 1, existing Markdown untouched), blank Markdown (exit 1), success (file written), knob refusal (exit 2), page range validation (exit 2), report written before the failure. The assembly is checked through `assemble()` and `converter.initialize_pipeline(...)`: engine type with and without streaming, scale 1.0 for crops, cap default, `generate_page_images` follows the debug flag; the page-image override through the built pipeline class with a stub page (no `object.__new__`). 
- `check_report.py` (new): the writer with hand-built VLM and Surya records: schema keys, numbering, PNG modes, both page_stats shapes, tokens totals, an incomplete report.
- `check_models.py`: unchanged VLM loop (imports from vlm.py); the Surya section asserts Surya's settings attributes instead of environment variables, region info per page instead of a top-level list, and keeps the guard-fix assertions.
- `check_streaming.py`: builds the engine through `vlm_options` and `engine_options`; the `requests.post` patch stays as is (out of scope).
- `check_api.py`: unchanged plus `knobs` present in `/api/models`.
- `check_cut.py`: unchanged.

## 12. Docs

README: delete lines 133-134 (the pre-Surya-2 report description; the accurate one is in the Surya paragraph); state that `--max-image-size` is refused for Surya; describe the report fields once. docs/surya-integration.md: settings are assigned on Surya's settings object rather than exported as environment variables; `convert_surya` becomes the Surya adapter. docs/ingest-cuts.md: `save_debug` becomes the report writer.

## 13. Visible behaviour changes

1. `--max-image-size` with `--model surya` exits 2 (was ignored); the API answers 400 for it.
2. Surya `report.json`: region per page instead of top-level `regions`; `status`, `incomplete`, run facts, `versions` and `tokens` added; `scale` is null for crops (was the whole-page value).
3. VLM `report.json`: same additions; `status` is `success`/`incomplete` with the Docling status under `docling_status`.
4. The incomplete message for Surya starts with "Conversion incomplete" like the VLM one.
5. (2026-09-14 afternoon) `params.json` names the `transcriber` instead of an `extraction` flag; a native run has null `model`, `repo`, `url`, `crop_dpi` and `layout_model`, and its id reads `…-native-…`. Runs recorded earlier keep their files as they are and list no transcriber.
6. (2026-09-14 afternoon) A debug report from before the seam, whose page entries carry no `page` or `region`, makes the boxes endpoint answer with the regions from the events log and no blocks instead of a 500.

## 14. Sequencing

Step 1 (VLM assembly, candidate 2): vlm.py, models.py, progress.py, the VLM branch of `convert()`, check updates. Independent of the pending Surya guard fix. Step 2 (the seam, candidates 1 and 4): based on the committed guard fix; transcription.py, surya_ocr.py, report.py, `convert()` rewrite, cut.py move, api.py, checks, docs. Work happens in the worktree `.claude/worktrees/transcriber-seam` on branch `transcriber-seam`; checks run with `PYTHONPATH=<worktree>/src uv run --no-sync --project /home/gennaro/projects/kei-exp python scratch/<check>.py`.

## 15. Constraints carried from the review

- Keep the one-shot HTML join and the single RecognitionPredictor call inside the Surya adapter.
- Per-page usage and stop reason stay VLM-only; page records keep two payload shapes.
- Refuse unsupported knobs before the cut.
- Keep `model_spec.model_copy()`, the page-image override, scale 1.0 for crops and the 1200 default for whole pages.
- Do not RGBA-normalise Surya PNGs; keep `generate_page_images` tied to the debug flag.
- The report survives an incomplete run.

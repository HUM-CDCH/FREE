# OCR result reuse across runs — design

Date: 2026-10-03. Status: approved in chat (design reviewed by Codex gpt-6-astra and Fable 5.1, merged).

## Goal

The same PDF bytes with the same effective parse settings reuse an earlier, verified OCR result instead of
redoing the cut and the transcription. For `page_source="ingest"`, the spread cut (ingest) is reused too.

The key is the existing result recipe fingerprint (`kei_exp.result.recipe` / `fingerprint`): source SHA-256,
transcriber, model, repo, prompt, cut, crop DPI, layout model, page source, requested pages, image/token caps,
ingest digest, `RESULT_VERSION`, text rules, dependency versions. The ingest key is the existing ingest
fingerprint (`kei_exp.kie.artifacts.fingerprint`: stage version, config, PDF SHA-256).

Today kei redoes everything for a new `convert` workflow: Studio dedupes by content only inside one project, so a
second project, a reprocess back to earlier settings, or a re-upload after deletion re-runs OCR on the GPU.

## Non-goals

- No index, no database table: candidates are found by scanning `runs/*` on disk.
- No change to Studio or to `ConvertOk` (`keiConvertOkSchema` is `.strict()`).
- No reuse in the standalone CLI; it passes no hooks and behaves as today.
- No reuse of incomplete results, and none for a run that asked for a debug report.
- No locking: two concurrent runs of one PDF may both do the work.

## Design

### `kei_exp/reuse.py` (worker only)

```python
def candidates(source_sha256: str, *, own: Path) -> Iterator[Path]
def seed_ingest(doc_dir: Path, pdf_sha256: str, cfg: IngestConfig, *, own: Path) -> None
def adopt_result(fingerprint: str, directory: Path, *, source_sha256: str, source_name: str, page_count: int,
                 pages: Collection[int], own: Path) -> pagefile.LoadedResult | None
```

- `candidates`: run directories under `runs.RUNS` whose name matches `runs.COMPONENT` (so `.prepare-*` and
  `.deleting-*` are excluded), that are not `own`, and whose `params.json` names `source_sha256`. Unreadable
  `params.json` is skipped. Order is the sorted directory listing; the first candidate that verifies wins.
- `seed_ingest`: when `IngestPaths(doc_dir).accepted` does not exist, find a candidate whose
  `<run>/input/ingest/ingest.json` envelope fingerprint equals `fingerprint(ingest.STAGE_VERSION, cfg, pdf_sha256)`
  and that `load_ingest` proves; hard-link its tree (`copytree(..., copy_function=os.link)`, falling back to
  `copy2` on `EXDEV`) into a hidden sibling and rename that onto `accepted`. Best effort: any `CacheMiss`/`OSError`
  removes the sibling and returns. `ingest_step` itself is unchanged: `_skippable` re-proves the seeded
  generation (digest, every page image, config, source hash) and reports `skipped=True`; a bad seed falls through
  to `_produce`, whose `_publish` supersedes it.
- `adopt_result`: for each candidate whose `result/result.json` names `fingerprint`, load it with
  `pagefile.load_result(..., require_complete=True)`, and require `result.fingerprint(manifest.recipe) ==
  manifest.fingerprint == fingerprint` (the loader does not recompute it). Then write it into `directory` as a new
  generation: every page with `generation` replaced, published through the same helper as `write_result`; then the
  manifest with the new `generation`, recomputed `pages`/`digest`, this run's `source_name`, and
  `reused_from={"run_id", "generation"}`. `recipe`, `fingerprint`, `started`, `seconds`, `tokens` and `effective`
  are the original's: they describe how the content was produced. Returns the published manifest, or `None`.
  `ResultError`, `OSError` and a `ValidationError` on a candidate mean "try the next one".

Reuse never depends on the candidate afterwards: hard links survive GC's rename-then-delete, and result pages are
rewritten. GC needs no new reference rule.

### Changes to existing modules

- `pagefile.Result`: optional `reused_from: dict[str, str] | None = None`. No `RESULT_VERSION` bump (it is in the
  recipe; bumping it would invalidate every existing candidate).
- `result.py`: move the page-publish loop and stray-page cleanup out of `write_result` into
  `publish_pages(directory, pages) -> dict[int, PageEntry]`, used by `write_result` and `adopt_result`.
- `kie/stages/ocr.run` gains keyword-only `adopt: Callable[[str], bool] | None = None` and
  `before_ocr: Callable[[], None] | None = None`. Right after `Source.of` and the range check, when `adopt` is
  given, it computes the fingerprint from `recipe(execution, source.sha256, book.digest or None)`; if
  `adopt(fingerprint)` is true it emits a `log` event and returns the adopted result's Markdown (pages read back
  through `load_result`), skipping cut and transcription. On a miss, `before_ocr()` runs, then the stage as today.
- `kie/runner.convert` gains the same two keywords plus `seed: Callable[[Path], None] | None`; with `seed`, it
  calls `seed(doc_dir)` before `ingest_step`, and forwards `adopt`/`before_ocr` to `ocr.run`.
- `workflows/convert.convert_run`: `serving(execution)` and the second cancel check move into `before_ocr`, so a
  reused run does not need the model server. When the run has no debug dir it passes `seed` and `adopt` bound to
  `reuse` with `own` = this run's directory. Step names and order are unchanged (no `DBOS.patch` needed).

### Failure handling

Every reuse failure falls back to doing the work and is logged as a `log` event. A crash mid-adopt leaves page files
without a matching manifest (or the previous one); the step's retry adopts again or runs, and `publish_pages`
removes stray pages. An uncheckpointed retry may publish another generation, as today.

### Freshness

The recipe carries explicit versions, not a code hash. A change to cut or transcription output must bump
`RESULT_VERSION` or the relevant text-rules version, as the recipe already requires; otherwise reuse returns the
earlier output. Documented in the service README.

## Testing

Fast tests (no Postgres, no model), against a temporary `runs.RUNS`:

- `adopt_result`: hit (new generation, pages rewritten, digest valid, `reused_from` set, `source_name` replaced,
  loads with `load_result`); miss on another fingerprint; skips own run, incomplete, tampered page, manifest whose
  recipe does not hash to its fingerprint, unreadable `params.json`; falls through to the next candidate.
- `seed_ingest`: seeds a proven donor so `ingest_step` reports `skipped=True`; no-op when `accepted` exists; a
  corrupt donor leaves nothing behind and ingest runs.
- `ocr.run`: with an adopting hook, neither the cut nor the transcriber nor `before_ocr` is called and the Markdown
  matches; on a miss `before_ocr` is called once before transcription.
- `convert_run`: a second run of the same staged PDF and settings adopts without the model server being reachable.

## Review log

- Implementation deviations (implementer): `adopt_result` takes `source_sha256` to find candidates; the seed links
  through `ingest.staging` (removed by ingest recovery if interrupted) instead of a hidden sibling; `reused_from` is
  omitted when unset so existing manifests stay byte-identical; reuse failures go to the `kei_exp.reuse` logger;
  `before_ocr` runs before the cut. DBOS-tier tests `test_delete_runs.py` and `test_lanes.py` now stage distinct
  bytes / ask for debug so they still exercise transcription.
- Codex gpt-6-astra review, accepted: (P2) the cancel check after resolution now runs before adoption, not inside
  `before_ocr`; (P2) adoption binds the donor to this run's PDF page count and the PDF pages the selection lists
  (`load_result(pages=...)`); (P3) the `adopt` hook returns the published `LoadedResult`, so `ocr.run` builds the
  Markdown from memory instead of reading every page back.
- Deferred: fault-injection tests for GC during copy and crash between page and manifest publication; the `EXDEV`
  copy fallback (one volume in every deployment).

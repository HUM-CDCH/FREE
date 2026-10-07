"""The KIE ingest cache: the canonical hashes, the loader that must prove a cache entry, whole ingest calls of the real
single-mode ingest under a temporary root, a publication interrupted at each point it can be, and OCR over the
accepted ingest through `convert`. Ported from `scratch/check_kie_cache.py` (all of it) and the runner half of
`scratch/check_kie_ocr.py`. No PDF of the catalogue and no GPU: hand-built artifacts with real PNGs, and generated
PDFs of the size each case wants.

The hashing and loader tests, up to the ingest-call banner, are independent of one another: each builds under its own
directory, or reads the one reference generation of the module-scoped `spread` fixture without changing it.

The ingest-call tests are an ordered sequence on purpose. Each builds on the accepted generation the previous one left
in one document directory (`runs/resume/catalogue` under the module-scoped workspace), because that is what a cache
decision is about: what an earlier call published, proven again by a later one. They run in file order, share the
module-scoped `workspace`, `runs`, `catalogue`, `changed` and `first` fixtures, and are not meant to run alone: `-k`
one of them and it starts from whatever generation is accepted, or from none. The OCR tests at the end use independent
trees. Every root is under the temporary workspace and never the repository's `runs/`, which the module checks it
left as it found it.
"""
import hashlib
import io
import json
import shutil
import tracemalloc
import warnings
from collections.abc import Callable
from pathlib import Path
from typing import IO, Any, ClassVar, NamedTuple
from unittest.mock import patch

import pytest
from PIL import Image

from kei_exp.canonical import canonical_json, sha256_file
from kei_exp.kie import artifacts, ingest_cache
from kei_exp.kie.artifacts import (
    CacheMiss,
    fingerprint,
    load_ingest,
    output_digest,
    save_ingest,
    seal,
)
from kei_exp.kie.ingest_model import IngestArtifact, IngestConfig
from kei_exp.kie.primitives import IngestError
from kei_exp.kie.ingest_cache import IngestCacheError, IngestPaths, IngestStep
from kei_exp.kie.runner import convert
from kei_exp.kie.stages import ingest, ocr
from kei_exp.pagefile import load_result
from kei_exp.transcription.types import ConversionError, Execution, RunParams
from tests.helpers.fake import FakeTranscriber
from tests.helpers.pdfs import PAGE_SIZE, binary_pdf, mask
from tests.helpers.synthetic import record

# stages/ingest.py owns `STAGE_VERSION`; the hashing helpers take it as a value, so these pass it.
STAGE_VERSION = 3
SPREAD_W, SPREAD_H = 400, 300
GUTTER = 240
PAGE_PT = (500.0, 350.0)
PDF_SHA256 = hashlib.sha256(b"a catalogue").hexdigest()
CREATED = "2026-09-14T12:00:00+02:00"
UNSEALED = "0" * 64  # the placeholder a producer builds its envelope with, before `seal` stamps the digest
SIDES = {"spread": ("left", "right"), "single": ("single",)}
# Inactive in single mode: these settings provably changed nothing, so re-running over them would be waste.
INACTIVE = {"gutter_window": (0.30, 0.70), "bands": 9, "dark_ink": 0.5, "overrides": {1: 7}}

SINGLE_MODE = IngestConfig(split="single")
TUNED_MODE = IngestConfig(split="single", **INACTIVE)
SPREAD_MODE = IngestConfig()  # `split` is the only setting active in single mode: the other active config
REAL_OPEN = Path.open
REAL_INGEST = ingest.run
REAL_RENAME = Path.rename
REAL_RMTREE = shutil.rmtree


@pytest.fixture(scope="module")
def workspace(tmp_path_factory) -> Path:
    return tmp_path_factory.mktemp("kie-runner")


@pytest.fixture(scope="module")
def runs(workspace) -> Path:
    return workspace / "runs"  # never the repository's `runs/`: a test that writes there would publish over real work


@pytest.fixture(scope="module")
def catalogue(workspace) -> Path:
    return binary_pdf(workspace / "first" / "catalogue.pdf", mask(), mask(every=7))


@pytest.fixture(scope="module")
def changed(workspace) -> Path:
    # The same file name in another directory, so one run directory sees both: the document id is the stem.
    return binary_pdf(workspace / "changed" / "catalogue.pdf", mask(every=5))


# --- Hand-built artifacts: a Page whose recorded hash is the PNG that is actually on disk for it ----------------
def rects(gutter: int) -> dict[str, tuple[int, int, int, int]]:
    return {
        "left": (0, 0, gutter, SPREAD_H),
        "right": (gutter, 0, SPREAD_W, SPREAD_H),
        "single": (0, 0, SPREAD_W, SPREAD_H),
    }


def placement() -> dict:
    width_pt, height_pt = PAGE_PT
    return {"a": width_pt, "b": 0.0, "c": 0.0, "d": height_pt, "e": 0.0, "f": 0.0,
            "page_width_pt": width_pt, "page_height_pt": height_pt}


def evidence() -> dict:
    return {"dark_run": (238, 244), "blank_run": (230, 238), "dark_runs": 1, "blank_runs": 1, "band_support": 0.8,
            "distance_from_midline_px": 40}


def page(index: int, side: str, directory: Path, gutter: int) -> dict:
    """A Page whose recorded hash is the PNG that is actually on disk for it."""
    left, top, right, bottom = rects(gutter)[side]
    return {
        "index": index,
        "spread": 1,
        "side": side,
        "image": f"pages/{index:03d}.png",
        "width_px": right - left,
        "height_px": bottom - top,
        "sha256": sha256_file(directory / "pages" / f"{index:03d}.png"),
        "source_rect": (left, top, right, bottom),
        "spread_width_px": SPREAD_W,
        "spread_height_px": SPREAD_H,
        "placement": placement(),
        "dpi_x": 72.0 * SPREAD_W / PAGE_PT[0],
        "dpi_y": 72.0 * SPREAD_H / PAGE_PT[1],
        "gutter_x_px": None if side == "single" else gutter,
        "gutter_method": "none" if side == "single" else "shadow",
        "gutter_reason": None,
        "gutter_evidence": None if side == "single" else evidence(),
    }


def spread_report(gutter: int) -> dict:
    return {"spread": 1, "gutter_x_px": gutter, "method": "shadow", "reason": None, "evidence": evidence(),
            "min_blank_px": 1, "min_dark_px": 1, "support_radius_px": 1}


def report(split: str, pages_written: int, gutter: int = GUTTER, **overrides) -> dict:
    fields = {
        "spreads_read": 1,
        "pages_written": pages_written,
        "methods": {"none" if split == "single" else "shadow": 1},
        "spreads": [] if split == "single" else [spread_report(gutter)],
        "weak_support": [],
        "text_layers": {},
        "extract_seconds": 1.2,
        "write_seconds": 0.6,
        "seconds": 1.8,
    }
    return {**fields, **overrides}


def envelope(**overrides) -> dict:
    fields = {
        "stage": "ingest",
        "stage_version": STAGE_VERSION,
        "fingerprint": fingerprint(STAGE_VERSION, IngestConfig(), PDF_SHA256),
        "digest": UNSEALED,
        "upstream": {},
        "created": CREATED,
    }
    return {**fields, **overrides}


def source(**overrides) -> dict:
    fields = {"pdf_name": "catalogue.pdf", "sha256": PDF_SHA256, "spreads": 1, "page_size_pt": {1: PAGE_PT}}
    return {**fields, **overrides}


def case(root: Path, name: str) -> Path:
    directory = root / name
    (directory / "pages").mkdir(parents=True)
    return directory


def write_pages(directory: Path, split: str, *, gutter: int = GUTTER, ink: tuple[int, int] = (1, 1)) -> None:
    """Real mode `1` PNGs of the sizes the Pages will state, with the header the loader reads."""
    for index, side in enumerate(SIDES[split], start=1):
        left, top, right, bottom = rects(gutter)[side]
        write_png(directory / "pages" / f"{index:03d}.png", (right - left, bottom - top), ink=ink)


def write_png(path: Path, size: tuple[int, int], *, mode: str = "1", ink: tuple[int, int] = (1, 1)) -> None:
    image = Image.new(mode, size, 1 if mode == "1" else 255)
    image.putpixel(ink, 0)
    image.save(path, format="PNG")


def artifact(directory: Path, *, split: str = "spread", gutter: int = GUTTER, **overrides) -> IngestArtifact:
    pages = [page(index, side, directory, gutter) for index, side in enumerate(SIDES[split], start=1)]
    fields = {
        "envelope": envelope(),
        "source": source(),
        "config": {"split": split},
        "pages": pages,
        "report": report(split, len(pages), gutter),
    }
    return seal(IngestArtifact.model_validate({**fields, **overrides}))


def published(directory: Path, *, split: str = "spread") -> tuple[Path, IngestArtifact]:
    """A saved artifact and the path of its `ingest.json`, with its page images beside it."""
    write_pages(directory, split)
    saved = artifact(directory, split=split)
    save_ingest(saved, directory / "ingest.json")
    return directory / "ingest.json", saved


def rewrite(path: Path, change: Callable[[dict], None]) -> Path:
    """The saved artifact edited after publication, the way a hand-edited cache entry is edited."""
    data = json.loads(path.read_text(encoding="utf-8"))
    change(data)
    edited = path.with_name("edited.json")  # beside the original, so `pages/` still resolves from it
    edited.write_text(json.dumps(data), encoding="utf-8")
    return edited


@pytest.fixture(scope="module")
def spread(workspace) -> tuple[Path, IngestArtifact]:
    """The reference generation: a spread-mode artifact saved as `ingest.json` with its two page images beside it.
    The tests read it and never change it; what they write beside it (`edited.json`, `malformed.json`) it never reads."""
    return published(case(workspace, "spread"))


# --- One canonical encoding -----------------------------------------------------------------------------------
def test_canonical_json_is_one_encoding_with_text_kept_as_text():
    assert canonical_json({"b": 1, "a": {"d": 2, "c": 3}}) == b'{"a":{"c":3,"d":2},"b":1}'
    # Text stays text, so a hash does not depend on whether the encoder escaped it.
    assert canonical_json({"name": "Großkayna"}) == '{"name":"Großkayna"}'.encode()
    with pytest.raises(ValueError):
        canonical_json({"x": float("nan")})
    assert canonical_json(IngestConfig(split="single")) == b'{"split":"single"}'


def test_sha256_file_hashes_a_file_larger_than_one_read(tmp_path):
    bulk = tmp_path / "bulk.bin"
    bulk.write_bytes(b"kei" * 500_000)  # larger than one read, so a dropped chunk would show
    assert sha256_file(bulk) == hashlib.sha256(bulk.read_bytes()).hexdigest()


# --- Fingerprint: the recipe, not the output ------------------------------------------------------------------
@pytest.mark.parametrize("split, settings, expected", [
    ("spread", {}, "3f10351f1fcb2feb862403a59d4f3903e4b135cfd1f8faca42d9838d11fb8525"),
    ("spread", INACTIVE, "a28d466cd193344f12e585999e7a0393df5ca436122cf120557bab0fd09c87a8"),
    ("single", {}, "8bfc03f6555fd46d6f47ca35796e22bdcb29b241242f1e6be734834249e63a46"),
    ("single", INACTIVE, "8bfc03f6555fd46d6f47ca35796e22bdcb29b241242f1e6be734834249e63a46"),
])
def test_fingerprint_preserves_the_existing_encoding(split, settings, expected):
    # Captured before removing IngestInputs; inactive settings must remain absent in single mode.
    assert fingerprint(STAGE_VERSION, IngestConfig(split=split, **settings), PDF_SHA256) == expected


def test_the_fingerprint_is_the_recipe_and_not_the_output():
    assert (
        fingerprint(STAGE_VERSION, IngestConfig(split="single"), PDF_SHA256)
        == hashlib.sha256(
            canonical_json(
                {
                    "stage_version": STAGE_VERSION,
                    "effective_config": {"split": "single"},
                    "inputs": {"pdf_sha256": PDF_SHA256},
                }
            )
        ).hexdigest()
    )
    assert fingerprint(2, IngestConfig(), PDF_SHA256) != fingerprint(1, IngestConfig(), PDF_SHA256)
    another = hashlib.sha256(b"another").hexdigest()
    assert fingerprint(1, IngestConfig(), another) != fingerprint(1, IngestConfig(), PDF_SHA256)
    # Inactive in single mode: these settings provably changed nothing, so re-running over them would be waste.
    assert fingerprint(1, IngestConfig(split="single", **INACTIVE), PDF_SHA256) == fingerprint(
        1, IngestConfig(split="single"), PDF_SHA256
    )
    assert fingerprint(1, IngestConfig(**INACTIVE), PDF_SHA256) != fingerprint(1, IngestConfig(), PDF_SHA256)


# --- Digest: the output, and nothing about the run that produced it -------------------------------------------
def test_the_digest_is_the_output_and_nothing_about_the_run_that_produced_it(spread, tmp_path):
    path, base = spread
    directory = path.parent
    assert base.envelope.digest == output_digest(base)
    assert output_digest(
        artifact(
            directory,
            envelope=envelope(created="2026-01-01T00:00:00Z", fingerprint=hashlib.sha256(b"other recipe").hexdigest()),
            report=report("spread", 2, seconds=99.0, extract_seconds=90.0, write_seconds=9.0),
        )
    ) == output_digest(base)

    repainted = case(tmp_path, "repainted")
    write_pages(repainted, "spread", ink=(2, 2))  # the same page sizes, other pixels, so other image hashes
    assert output_digest(artifact(repainted)) != output_digest(base)

    moved = case(tmp_path, "moved-gutter")
    write_pages(moved, "spread", gutter=200)  # a split one page dimension away from BASE
    assert output_digest(artifact(moved, gutter=200)) != output_digest(base)
    other_source = source(sha256=hashlib.sha256(b"another").hexdigest())
    assert output_digest(artifact(directory, source=other_source)) != output_digest(base)

    single = case(tmp_path, "single")
    write_pages(single, "single")
    plain = artifact(single, split="single")
    tuned = artifact(single, split="single", config={"split": "single", **INACTIVE})
    assert output_digest(tuned) == output_digest(plain)
    assert output_digest(artifact(directory, config={"split": "spread", **INACTIVE})) != output_digest(base)


# --- Saving and loading a proven artifact ---------------------------------------------------------------------
def test_a_proven_artifact_is_saved_indented_and_loads_back_equal(spread):
    path, base = spread
    assert load_ingest(path) == base
    saved = path.read_bytes()
    # Indented for reading, which is not what the hashes were taken over.
    assert b"\n  " in saved and saved != canonical_json(base)


def test_inactive_settings_persist_as_the_effective_config(tmp_path):
    # A single-mode artifact configured with inactive gutter settings persists and loads as the run that had none.
    single = case(tmp_path, "single")
    write_pages(single, "single")
    plain = artifact(single, split="single")
    tuned = single / "ingest.json"
    save_ingest(artifact(single, split="single", config={"split": "single", **INACTIVE}), tuned)
    assert json.loads(tuned.read_text(encoding="utf-8"))["config"] == {"split": "single"}
    assert output_digest(load_ingest(tuned)) == output_digest(plain)


# --- Candidates that cannot be proven -------------------------------------------------------------------------
def malformed(path: Path) -> Path:
    candidate = path.with_name("malformed.json")
    candidate.write_text("{not json", encoding="utf-8")
    return candidate


UNPROVABLE = [
    pytest.param(lambda path: path.with_name("absent.json"), id="a missing artifact"),
    pytest.param(malformed, id="malformed JSON"),
    pytest.param(lambda path: rewrite(path, lambda data: data["pages"].pop()), id="an artifact that no longer validates"),
    pytest.param(lambda path: rewrite(path, lambda data: data["envelope"].update({"digest": "1" * 64})),
                 id="a stale envelope digest"),
    pytest.param(lambda path: rewrite(path, lambda data: data["source"].update({"pdf_name": "other.pdf"})),
                 id="a namespace edited under its digest"),
]


@pytest.mark.parametrize("candidate", UNPROVABLE)
def test_a_candidate_that_cannot_be_proven_is_a_cache_miss(candidate, spread):
    path, _ = spread
    with pytest.raises(CacheMiss):
        load_ingest(candidate(path))


# --- Page images: the bytes, then the raster ------------------------------------------------------------------
class Traced(io.BufferedReader):
    """A page image handle that records its calls, so the order of the hash and the header can be asserted."""

    calls: ClassVar[list[str]] = []

    def read(self, size: int = -1) -> bytes:
        self.calls.append("read")
        return super().read(size)

    def seek(self, offset: int, whence: int = 0) -> int:
        self.calls.append("seek")
        return super().seek(offset, whence)


def traced_open(self: Path, *args: Any, **kwargs: Any) -> IO[Any]:
    handle = REAL_OPEN(self, *args, **kwargs)
    return Traced(handle.detach()) if self.suffix == ".png" else handle


def test_a_missing_page_image_is_a_cache_miss(tmp_path):
    deleted, _ = published(case(tmp_path, "deleted-image"))
    (deleted.parent / "pages" / "001.png").unlink()
    with pytest.raises(CacheMiss):
        load_ingest(deleted)


def test_other_bytes_in_a_page_image_are_refused_by_their_hash_before_the_header_is_read(tmp_path):
    replaced, _ = published(case(tmp_path, "replaced-image"))
    write_png(replaced.parent / "pages" / "001.png", (GUTTER, SPREAD_H), ink=(3, 3))
    # A valid header does not rescue other bytes: the hash is compared first, and it is what the miss names.
    with pytest.raises(CacheMiss, match="hashes to"):
        load_ingest(replaced)
    Traced.calls.clear()
    with patch.object(Path, "open", traced_open), pytest.raises(CacheMiss):
        load_ingest(replaced)
    # Other bytes are refused before the handle is rewound for the header.
    assert "read" in Traced.calls and "seek" not in Traced.calls, Traced.calls


def truncated_inside_the_header(image: Path) -> None:
    image.write_bytes(image.read_bytes()[:20])  # inside the IHDR, so the header cannot be read whole


def not_a_png(image: Path) -> None:
    image.write_bytes(b"not a portable network graphic, whatever its name says\n" * 2)


def in_mode(mode: str) -> Callable[[Path], None]:
    return lambda image: write_png(image, (GUTTER, SPREAD_H), mode=mode)  # bit depth 8; colour type 0 or 2


def tinted(image: Path) -> None:
    # Colour type alone, at bit depth 1: a header edit, so neither the depth check nor a decoder is what refuses it.
    intact = image.read_bytes()
    assert intact[24:26] == b"\x01\x00"
    image.write_bytes(intact[:25] + b"\x02" + intact[26:])


def resized(image: Path) -> None:
    write_png(image, (GUTTER + 1, SPREAD_H))


HEADER_REFUSALS = [
    pytest.param(truncated_inside_the_header, id="a page image truncated inside its header"),
    pytest.param(not_a_png, id="a page image that is not a PNG"),
    pytest.param(in_mode("L"), id="a page image that is not bilevel"),
    pytest.param(in_mode("RGB"), id="a page image in colour"),
    pytest.param(tinted, id="a page image whose header claims colour"),
    pytest.param(resized, id="a page image of another size"),
]


@pytest.mark.parametrize("corrupt", HEADER_REFUSALS)
def test_a_page_image_of_another_shape_is_refused_by_its_header_alone(corrupt, tmp_path):
    # Corrupted first, then recorded: the hash agrees, so only the 33-byte header can refuse these. Nothing is
    # decoded (spec 5): a matching hash proves the bytes are the ones ingest wrote, and the header proves ingest
    # wrote a page of the shape the Page states.
    directory = case(tmp_path, "image")
    write_pages(directory, "spread")
    corrupt(directory / "pages" / "001.png")
    save_ingest(artifact(directory), directory / "ingest.json")
    with pytest.raises(CacheMiss):
        load_ingest(directory / "ingest.json")


def test_the_verifier_uses_no_pillow_and_reads_no_process_global(spread):
    # No Pillow in the verifier: nothing here reads or writes the process-wide bomb bound, which two concurrent
    # verifiers used to capture and restore over each other.
    path, base = spread
    assert not hasattr(artifacts, "Image")
    with patch.object(Image, "MAX_IMAGE_PIXELS", 1):
        assert load_ingest(path) == base


def test_a_wrong_hash_image_of_64_mib_is_refused_with_one_read_block_allocated(tmp_path):
    # A wrong-hash candidate of 64 MiB is refused with the hash streamed through one handle: peak allocation is
    # the read block, not the file. Sparse, so the file costs no disk; recorded first, so the hash disagrees.
    huge = case(tmp_path, "huge-image")
    write_pages(huge, "spread")
    save_ingest(artifact(huge), huge / "ingest.json")
    with (huge / "pages" / "001.png").open("r+b") as big:
        big.truncate(64 << 20)
    tracemalloc.start()
    try:
        with pytest.raises(CacheMiss):
            load_ingest(huge / "ingest.json")
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak < 4 << 20, peak


# --- Failures that are not a cache miss -----------------------------------------------------------------------
@pytest.mark.parametrize("error", [OSError("read failed"), RuntimeError("reader bug")])
def test_unrelated_artifact_read_errors_propagate(spread, error):
    path, _ = spread
    with patch.object(Path, "read_bytes", side_effect=error), pytest.raises(type(error)) as caught:
        load_ingest(path)
    assert caught.value is error


def deny_png(self: Path, *args: Any, **kwargs: Any) -> IO[Any]:
    """An unreadable page image. Patched rather than chmod'ed, which does not restrict root."""
    if self.suffix == ".png":
        raise PermissionError(13, "Permission denied", str(self))
    return REAL_OPEN(self, *args, **kwargs)


def test_an_unreadable_file_keeps_its_own_error_and_is_not_a_cache_miss(spread):
    path, base = spread
    with (
        patch.object(Path, "read_bytes", side_effect=PermissionError(13, "Permission denied")),
        pytest.raises(PermissionError),
    ):
        load_ingest(path)
    with patch.object(Path, "open", deny_png), pytest.raises(PermissionError):
        load_ingest(path)
    assert load_ingest(path) == base  # and the same entry is proven again once both reads are allowed


# ================================================================================================================
# Ingest calls: whole calls of real single-mode ingest under a temporary root, a cache decision per spec 5,
# and a publication that is interrupted at each point it can be interrupted at. Nothing below knows a file name, a
# spread count or a page count of the real catalogue: every PDF is generated here at the size the case wants.
# An ordered sequence sharing one run directory, as the module docstring says.
# ================================================================================================================
def state(directory: Path) -> dict[str, tuple[int, int, str]]:
    """Every file under `directory` by size, modification time and content: what "untouched" means."""
    return {
        str(path.relative_to(directory)): (path.stat().st_size, path.stat().st_mtime_ns, sha256_file(path))
        for path in sorted(directory.rglob("*"))
        if path.is_file()
    }


@pytest.fixture(scope="module", autouse=True)
def repository_runs_untouched(root):
    """Every run root here is temporary: the repository's `runs/` must come out of this module as it went in, because
    a test that wrote there would publish over real work."""
    before = state(root / "runs") if (root / "runs").exists() else None
    yield
    assert (state(root / "runs") if (root / "runs").exists() else None) == before


def generation(paths: IngestPaths) -> IngestArtifact:
    """The one published generation, proven against the files beside it. There is never a second one."""
    assert not paths.previous.exists(), f"{paths.previous} outlived the publication that made it"
    assert sorted(entry.name for entry in paths.accepted.iterdir()) == ["ingest.json", "pages"]
    accepted = load_ingest(paths.artifact(paths.accepted))
    assert sorted(entry.name for entry in (paths.accepted / "pages").iterdir()) == [
        Path(recorded.image).name for recorded in accepted.pages
    ]
    return accepted


def step(pdf: Path, cfg: IngestConfig, *, run_id: str, runs_root: Path,
         on_spread: ingest.OnSpread | None = None) -> IngestStep:
    """One ingest call into `<runs_root>/<run_id>/<pdf stem>`, a document directory made the way `convert` makes it."""
    doc_dir = runs_root / run_id / pdf.stem
    doc_dir.mkdir(parents=True, exist_ok=True)
    return ingest_cache.ingest_step(pdf, cfg, doc_dir, on_spread)[0]


def refused(what: str, act: Callable[[], object], *naming: str) -> None:
    """`act` must fail as an ingest failure, and the failure must name each of `naming`, source and stage."""
    try:
        act()
    except IngestCacheError as error:
        silent = [text for text in naming if text not in str(error)]
        assert not silent, f"{what} failed, but the message does not say {silent}: {error}"
        return
    pytest.fail(f"{what} was accepted")


def rewrite_accepted(paths: IngestPaths, change: Callable[[dict[str, Any]], None]) -> None:
    """The accepted artifact edited in place after publication, the way a hand-edited run directory is."""
    stored = paths.artifact(paths.accepted)
    data = json.loads(stored.read_text(encoding="utf-8"))
    change(data)
    stored.write_text(json.dumps(data), encoding="utf-8")


def truncate(path: Path) -> None:
    """Half a page image, which is what a process killed while writing one leaves behind."""
    path.write_bytes(path.read_bytes()[: path.stat().st_size // 2])


class FirstRun(NamedTuple):
    step: IngestStep
    spreads_seen: list[tuple[int, int]]


@pytest.fixture(scope="module")
def first(catalogue, runs) -> FirstRun:
    """The first ingest of the catalogue, with the progress callback recording what the stage announced. Its accepted
    generation under `runs/resume/catalogue` is what every ingest-call test below starts from, in file order."""
    seen: list[tuple[int, int]] = []
    done = step(catalogue, SINGLE_MODE, run_id="resume", runs_root=runs, on_spread=lambda *a: seen.append(a))
    return FirstRun(done, seen)


@pytest.fixture(scope="module")
def paths(first, runs) -> IngestPaths:
    """The ingest directories of that document: accepted, staging and superseded."""
    return IngestPaths(runs / "resume" / "catalogue")


def test_the_stage_version_the_hashing_tests_assume_is_the_stages_own():
    assert ingest.STAGE_VERSION == STAGE_VERSION


# --- A first call: the stage runs, its artifact is published, and the step says what happened ------------------
def test_a_first_call_publishes_its_artifact_and_says_what_happened(first, paths, catalogue):
    assert first.step.skipped is False and first.step.report.pages_written == 2
    assert first.spreads_seen == [(1, 2), (2, 2)], first.spreads_seen  # the cache hands the callback to the stage
    produced = generation(paths)
    assert produced.source.sha256 == sha256_file(catalogue) and len(produced.pages) == 2
    assert produced.envelope.fingerprint == fingerprint(STAGE_VERSION, SINGLE_MODE, sha256_file(catalogue))
    assert not paths.staging.exists()


# --- A second identical call: proven, skipped, and not one byte of the accepted generation rewritten -----------
def test_a_second_identical_call_is_proven_and_skipped_without_rewriting_a_byte(first, paths, catalogue, runs):
    accepted = state(paths.accepted)
    produced = generation(paths)
    second = step(catalogue, SINGLE_MODE, run_id="resume", runs_root=runs,
                  on_spread=lambda *a: first.spreads_seen.append(a))
    assert second.skipped is True
    assert first.spreads_seen == [(1, 2), (2, 2)]  # a proven artifact is reused: nothing read, nothing announced
    assert state(paths.accepted) == accepted
    # The stage's own report is the one stored when it last ran; `seconds` is this invocation's, the check included.
    assert second.report == first.step.report
    assert generation(paths) == produced


def test_settings_inactive_in_the_chosen_mode_are_not_a_reason_to_rerun(first, paths, catalogue, runs):
    # Settings that are inactive in the chosen mode provably changed nothing, so they are not a reason to re-run.
    accepted = state(paths.accepted)
    assert step(catalogue, TUNED_MODE, run_id="resume", runs_root=runs).skipped is True
    assert state(paths.accepted) == accepted

    # The same settings on a run with nothing to skip: what is persisted is the effective config and not the
    # config in memory, so a producing run only recognises what it wrote if the two are compared as they are
    # written down. That the second call skips is what says the first one published what it returned.
    assert step(catalogue, TUNED_MODE, run_id="tuned", runs_root=runs).skipped is False
    assert step(catalogue, TUNED_MODE, run_id="tuned", runs_root=runs).skipped is True
    # And the plain single-mode config skips that same generation: inactive settings are not part of the recipe.
    assert step(catalogue, SINGLE_MODE, run_id="tuned", runs_root=runs).skipped is True
    tuned = IngestPaths(runs / "tuned" / "catalogue")
    assert generation(tuned).config.model_dump() == {"split": "single"}


def test_staging_left_by_an_interrupted_run_is_removed_before_the_decision(paths, catalogue, runs):
    # Staging left by an interrupted earlier run is never a generation: it is removed before this run decides.
    accepted = state(paths.accepted)
    (paths.staging / "pages").mkdir(parents=True)
    (paths.staging / "pages" / "001.png").write_bytes(b"half a page")
    assert step(catalogue, SINGLE_MODE, run_id="resume", runs_root=runs).skipped is True
    assert not paths.staging.exists() and state(paths.accepted) == accepted


# --- A different recipe re-runs the stage: other bytes, another stage version ----------------------------------
def test_other_bytes_under_the_same_name_are_another_recipe_and_rerun_the_stage(paths, catalogue, changed, runs):
    assert step(changed, SINGLE_MODE, run_id="resume", runs_root=runs).skipped is False
    superseded = generation(paths)
    assert superseded.source.sha256 == sha256_file(changed) and len(superseded.pages) == 1
    assert step(catalogue, SINGLE_MODE, run_id="resume", runs_root=runs).skipped is False
    assert generation(paths).source.sha256 == sha256_file(catalogue)


def test_a_bumped_stage_version_is_another_recipe_for_the_same_input(paths, catalogue, runs):
    with patch.object(ingest, "STAGE_VERSION", STAGE_VERSION + 1):
        # A bumped stage version is a different recipe even though nothing about the input changed (spec 5).
        assert step(catalogue, SINGLE_MODE, run_id="resume", runs_root=runs).skipped is False
        assert generation(paths).envelope.stage_version == STAGE_VERSION + 1
        assert step(catalogue, SINGLE_MODE, run_id="resume", runs_root=runs).skipped is True
    assert step(catalogue, SINGLE_MODE, run_id="resume", runs_root=runs).skipped is False
    assert generation(paths).envelope.stage_version == STAGE_VERSION


# --- Assets and digest: a cache entry that cannot be proven is re-run, not repaired ----------------------------
DAMAGE = [
    pytest.param(lambda paths: (paths.accepted / "pages" / "001.png").unlink(), id="a missing page image"),
    pytest.param(lambda paths: write_png(paths.accepted / "pages" / "001.png", PAGE_SIZE, ink=(5, 5)),
                 id="other bytes in a page image"),
    pytest.param(lambda paths: truncate(paths.accepted / "pages" / "001.png"), id="a truncated page image"),
    pytest.param(lambda paths: rewrite_accepted(paths, lambda data: data["envelope"].update({"digest": "1" * 64})),
                 id="a digest tampered with after publication"),
    pytest.param(lambda paths: rewrite_accepted(paths, lambda data: data["source"].update({"pdf_name": "other.pdf"})),
                 id="a namespace edited under its digest"),
]


@pytest.mark.parametrize("damage", DAMAGE)
def test_a_cache_entry_that_cannot_be_proven_is_rerun_not_repaired(damage, paths, catalogue, runs):
    damage(paths)
    assert step(catalogue, SINGLE_MODE, run_id="resume", runs_root=runs).skipped is False
    assert generation(paths).source.sha256 == sha256_file(catalogue)


def test_a_generation_of_an_earlier_version_reruns_once_under_the_current_one(paths, catalogue, runs):
    # The release check for STAGE_VERSION 2: a generation produced at version 1,
    # in the version-1 report shape without `text_layers`, reruns once under version 2, and the version-2 generation
    # then skips on an identical rerun. The report is outside the digest, so dropping the field is what a
    # version-1 run left behind and not a tampered artifact.
    with patch.object(ingest, "STAGE_VERSION", 1):
        assert step(catalogue, SINGLE_MODE, run_id="resume", runs_root=runs).skipped is False
    rewrite_accepted(paths, lambda data: data["report"].pop("text_layers"))
    legacy = json.loads(paths.artifact(paths.accepted).read_text(encoding="utf-8"))
    assert legacy["envelope"]["stage_version"] == 1 and "text_layers" not in legacy["report"]
    assert step(catalogue, SINGLE_MODE, run_id="resume", runs_root=runs).skipped is False
    assert generation(paths).envelope.stage_version == STAGE_VERSION
    assert step(catalogue, SINGLE_MODE, run_id="resume", runs_root=runs).skipped is True


def test_a_hand_edited_fingerprint_is_a_claim_and_not_evidence(paths, catalogue, changed, runs):
    # A fingerprint hand-edited to this run's recipe: it sits in the envelope, which the digest excludes, so it
    # is a claim and not evidence. The config and the source hash state the same thing from inside the digest,
    # and here they state that the run which produced this artifact read other bytes.
    assert step(changed, SINGLE_MODE, run_id="resume", runs_root=runs).skipped is False
    claimed = fingerprint(STAGE_VERSION, SINGLE_MODE, sha256_file(catalogue))
    rewrite_accepted(paths, lambda data: data["envelope"].update({"fingerprint": claimed}))
    assert step(catalogue, SINGLE_MODE, run_id="resume", runs_root=runs).skipped is False
    assert generation(paths).source.sha256 == sha256_file(catalogue)


# --- A stage that fails, and one that does not write what it returned -----------------------------------------
CALLED: list[tuple[str, Path]] = []


def refuse(pdf: Path, cfg: IngestConfig, out: Path, *, on_spread: ingest.OnSpread | None = None) -> IngestArtifact:
    """A stage that reads nothing. What it proves is that the cache called it instead of skipping."""
    CALLED.append((cfg.split, out))
    raise IngestError(f"{pdf.name} cannot be read by this stub")


def half_write(pdf: Path, cfg: IngestConfig, out: Path, *, on_spread: ingest.OnSpread | None = None) -> IngestArtifact:
    """A stage interrupted after part of its staging directory is on disk, which is the usual way to die."""
    CALLED.append((cfg.split, out))
    (out / "pages").mkdir(parents=True, exist_ok=True)
    write_png(out / "pages" / "001.png", PAGE_SIZE)
    raise OSError(28, "No space left on device", str(out / "pages" / "002.png"))


def misreport(pdf: Path, cfg: IngestConfig, out: Path, *, on_spread: ingest.OnSpread | None = None) -> IngestArtifact:
    """A stage whose returned artifact is not the one it wrote: the files are what the cache may believe."""
    written = REAL_INGEST(pdf, cfg, out)
    return written.model_copy(update={"report": written.report.model_copy(update={"seconds": 99.0})})


def test_a_stage_that_fails_half_writes_or_misreports_leaves_the_accepted_generation(paths, catalogue, changed, runs):
    CALLED.clear()
    accepted = state(paths.accepted)
    # `split` is the only setting active in single mode, so a changed active config is the change to spread mode.
    # The stage is a stub here because what this case asks is only whether the cache skipped, and it did not.
    with patch.object(ingest, "run", refuse):
        refused("a run whose active config changed",
                lambda: step(catalogue, SPREAD_MODE, run_id="resume", runs_root=runs), "catalogue.pdf", "ingest")
    assert CALLED == [("spread", paths.staging)]
    assert state(paths.accepted) == accepted and not paths.staging.exists()
    assert generation(paths).source.sha256 == sha256_file(catalogue)

    CALLED.clear()
    with patch.object(ingest, "run", half_write):
        refused("a stage interrupted while writing staging",
                lambda: step(changed, SINGLE_MODE, run_id="resume", runs_root=runs), "catalogue.pdf", "ingest")
    assert CALLED == [("single", paths.staging)]
    # The accepted generation is untouched, and the partial staging is not a second one: the next run removes it.
    assert state(paths.accepted) == accepted and paths.staging.exists()
    assert generation(paths).source.sha256 == sha256_file(catalogue)
    assert step(catalogue, SINGLE_MODE, run_id="resume", runs_root=runs).skipped is True
    assert not paths.staging.exists()

    with patch.object(ingest, "run", misreport):
        refused("a stage that returned an artifact it did not write",
                lambda: step(changed, SINGLE_MODE, run_id="resume", runs_root=runs), "catalogue.pdf", "ingest")
    assert state(paths.accepted) == accepted  # caught while the new generation is still only staged
    assert generation(paths).source.sha256 == sha256_file(catalogue)


# --- Publication interrupted between its two renames ----------------------------------------------------------
def fail_second_rename(self: Path, target: Path) -> Path:
    """Staging cannot be renamed onto the accepted name, which the previous generation has just left."""
    if self.name.endswith(".staging"):
        raise OSError(16, "Device or resource busy", str(self))
    return REAL_RENAME(self, target)


def test_a_publication_interrupted_between_its_renames_puts_the_previous_generation_back(paths, catalogue, changed,
                                                                                         runs):
    accepted = state(paths.accepted)
    with patch.object(Path, "rename", fail_second_rename):
        refused("a publication interrupted between its two renames",
                lambda: step(changed, SINGLE_MODE, run_id="resume", runs_root=runs), "catalogue.pdf", "ingest")
    assert state(paths.accepted) == accepted  # the previous generation was put back under its own name
    assert generation(paths).source.sha256 == sha256_file(catalogue)


# --- Startup recovery: a process that died between the renames left one or two directories --------------------
def test_startup_recovery_keeps_the_one_proven_generation_whatever_name_it_carries(paths, catalogue, changed, runs):
    accepted = state(paths.accepted)
    paths.accepted.rename(paths.previous)  # died after the first rename: only the superseded name is on disk
    assert not paths.accepted.exists()
    assert step(catalogue, SINGLE_MODE, run_id="resume", runs_root=runs).skipped is True
    assert state(paths.accepted) == accepted  # restored, then proven: a valid generation is never re-made
    assert generation(paths).source.sha256 == sha256_file(catalogue)

    # Died while the accepted name held a half-written directory: the superseded generation is the valid one.
    shutil.copytree(paths.accepted, paths.previous)
    paths.artifact(paths.accepted).write_text("{ truncated", encoding="utf-8")
    assert step(catalogue, SINGLE_MODE, run_id="resume", runs_root=runs).skipped is True
    assert generation(paths).source.sha256 == sha256_file(catalogue)

    # Both names hold a valid generation: the accepted one wins, and `.old` is removed only after it was verified.
    step(changed, SINGLE_MODE, run_id="other", runs_root=runs)
    shutil.copytree(IngestPaths(runs / "other" / changed.stem).accepted, paths.previous)
    assert load_ingest(paths.artifact(paths.previous)).source.sha256 == sha256_file(changed)
    kept = state(paths.accepted)
    assert step(catalogue, SINGLE_MODE, run_id="resume", runs_root=runs).skipped is True
    assert generation(paths).source.sha256 == sha256_file(catalogue)
    assert state(paths.accepted) == kept  # the older generation under `.old` never reached the accepted name


# --- Cleanup after a publication is not the publication ----------------------------------------------------
def keep_superseded(path: Path, *args: Any, **kwargs: Any) -> None:
    if str(path).endswith(".old"):
        raise OSError(39, "Directory not empty", str(path))
    REAL_RMTREE(path, *args, **kwargs)


def test_a_superseded_generation_that_cannot_be_removed_is_reported_not_rolled_back(paths, catalogue, runs):
    with (
        patch.object(ingest, "STAGE_VERSION", STAGE_VERSION + 2),
        patch.object(shutil, "rmtree", keep_superseded),
        warnings.catch_warnings(record=True) as caught,
    ):
        warnings.simplefilter("always")
        assert step(catalogue, SINGLE_MODE, run_id="resume", runs_root=runs).skipped is False
    # The new generation is published and stays published; the leftover is reported, not rolled back.
    assert [warning.category for warning in caught] == [RuntimeWarning]
    assert paths.previous.exists()
    assert load_ingest(paths.artifact(paths.accepted)).envelope.stage_version == STAGE_VERSION + 2
    # Back at the stage's own version, and the next run removed what was left.
    assert step(catalogue, SINGLE_MODE, run_id="resume", runs_root=runs).skipped is False
    assert generation(paths).envelope.stage_version == STAGE_VERSION


def test_a_document_that_is_not_there_fails_the_ingest_by_name(workspace, runs):
    refused("a document that is not there",
            lambda: step(workspace / "absent.pdf", SINGLE_MODE, run_id="missing", runs_root=runs),
            "absent.pdf", "ingest")


# --- OCR over the accepted ingest, through `convert`. Only the remote transcriber is replaced; rendering, placement
# and publication are real. ------------------------------------------------------------------------------------
@pytest.fixture
def ocr_backend(monkeypatch):
    fake = FakeTranscriber(blocks=True)
    monkeypatch.setitem(ocr.TRANSCRIBERS, "surya", fake)
    return fake


def over_ingest(pdf: Path, root: Path, **settings: Any) -> Execution:
    """Surya over the single-mode ingest of `pdf` under `root`, whole pages, publishing into `root / "result"`."""
    return ocr.resolve(RunParams(pdf=pdf, model="surya", page_source="ingest", ingest_dir=root,
                                 ingest={"split": "single"}, result_dir=root / "result", cut="none", **settings))


def ingest_reused(events: list[dict]) -> bool:
    return any(event["type"] == "log" and "skipped, cached" in event["text"] for event in events)


def test_ocr_runs_over_the_accepted_ingest_and_a_second_conversion_reuses_it(catalogue, tmp_path, ocr_backend):
    convert(over_ingest(catalogue, tmp_path), emit=lambda event: None)
    paths = IngestPaths(tmp_path / catalogue.stem)
    artifact = load_ingest(paths.artifact(paths.accepted))
    kept = state(paths.accepted)
    first = load_result(tmp_path / "result", require_complete=True)
    assert first.manifest.recipe["ingest_digest"] == artifact.envelope.digest
    assert [segment.text for number in sorted(first.pages) for segment in first.pages[number].segments] == ["x", "x"]
    execution, crops = ocr_backend.calls[0]
    assert execution.model == "surya" and execution.page_source == "ingest"
    assert len(crops) == 2 and all(region.transform.source_px is not None for _, region, _ in crops)

    events: list[dict] = []
    convert(over_ingest(catalogue, tmp_path), emit=events.append)
    assert ingest_reused(events) and len(ocr_backend.calls) == 2
    assert state(paths.accepted) == kept
    assert load_result(tmp_path / "result", require_complete=True).manifest.generation != first.manifest.generation


def test_a_resumed_conversion_can_narrow_its_page_range(catalogue, tmp_path, ocr_backend):
    convert(over_ingest(catalogue, tmp_path), emit=lambda event: None)
    events: list[dict] = []
    convert(over_ingest(catalogue, tmp_path, pages=(2, 2)), emit=events.append)
    assert ingest_reused(events)
    execution, crops = ocr_backend.calls[-1]
    assert execution.pages == (2, 2) and [page for page, _, _ in crops] == [2]
    assert sorted(load_result(tmp_path / "result").pages) == [2]


def test_an_incomplete_ocr_fails_the_conversion_and_the_ingest_stays_accepted(catalogue, tmp_path, ocr_backend):
    ocr_backend.records = [record(1, incomplete="token cap"), record(2)]
    with pytest.raises(ConversionError, match="token cap"):
        convert(over_ingest(catalogue, tmp_path), emit=lambda event: None)
    paths = IngestPaths(tmp_path / catalogue.stem)
    assert len(load_ingest(paths.artifact(paths.accepted)).pages) == 2
    assert load_result(tmp_path / "result").manifest.status == "incomplete"

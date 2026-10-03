"""Reuse across runs (`kei_exp.reuse`): another run's complete result of the same recipe adopted as a new generation
of this run, and another run's proven ingest of the same recipe seeded into this one; every candidate that cannot be
proven is passed over. Runs under a temporary `runs.RUNS`; results hand-built by the writer, ingests by the real
single-mode ingest over a generated PDF."""
import json
import shutil
from pathlib import Path

import pytest

from kei_exp import reuse, runs
from kei_exp.canonical import sha256_file
from kei_exp.kie.ingest_cache import IngestPaths, ingest_step
from kei_exp.kie.ingest_model import IngestConfig
from kei_exp.pagefile import Result, load_result
from kei_exp.result import write_result
from tests.helpers.pdfs import binary_pdf, mask
from tests.helpers.synthetic import cases as synthetic_cases

SINGLE = IngestConfig(split="single")


@pytest.fixture
def root(tmp_path, monkeypatch) -> Path:
    monkeypatch.setattr(runs, "RUNS", tmp_path / "runs")
    (tmp_path / "runs").mkdir()
    return tmp_path / "runs"


def donor(name: str, pdf: Path, root: Path) -> Result:
    """Run `name` as a finished conversion leaves it: a complete result over pages 3 and 4, and its params.json."""
    played = synthetic_cases()["whole-pages"](pdf, root.parent / name)
    written = write_result(played.outcome, played.execution, played.inventory, played.source, ingest_digest=None,
                           directory=root / name / "result")
    runs.write_json(root / name / "params.json", {"id": name, "source_sha256": played.source.sha256})
    return written


def adopt(donated: Result, root: Path, own: str = "run-own") -> Result | None:
    (root / own).mkdir(exist_ok=True)
    return reuse.adopt_result(donated.fingerprint, root / own / "result", source_sha256=donated.recipe["source_sha256"],
                              source_name="another name.pdf", own=root / own)


def edit_json(path: Path, change) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    change(data)
    path.write_text(json.dumps(data), encoding="utf-8")


def test_a_result_of_the_same_recipe_is_adopted_as_a_new_generation(digital_pdf, root):
    donated = donor("run-a", digital_pdf, root)
    adopted = adopt(donated, root)
    assert adopted is not None and adopted.generation != donated.generation
    assert adopted.reused_from == {"run_id": "run-a", "generation": donated.generation}
    assert adopted.source_name == "another name.pdf"
    for field in ("recipe", "fingerprint", "started", "seconds", "tokens", "effective", "page_count", "status"):
        assert getattr(adopted, field) == getattr(donated, field), field
    loaded = load_result(root / "run-own" / "result", require_complete=True)  # every page file names the new generation
    assert loaded.manifest == adopted and adopted.digest != donated.digest
    original = load_result(root / "run-a" / "result")
    assert {n: page.model_dump(exclude={"generation"}) for n, page in loaded.pages.items()} == \
        {n: page.model_dump(exclude={"generation"}) for n, page in original.pages.items()}
    assert json.loads((root / "run-own" / "result" / "result.json").read_text())["reused_from"]["run_id"] == "run-a"


def test_another_fingerprint_adopts_nothing_and_writes_nothing(digital_pdf, root):
    donated = donor("run-a", digital_pdf, root)
    assert adopt(donated.model_copy(update={"fingerprint": "0" * 64}), root) is None
    assert not (root / "run-own" / "result").exists()


def incomplete(directory: Path) -> None:
    edit_json(directory / "result" / "result.json", lambda m: m.update({"status": "incomplete", "incomplete": "cap"}))


def tampered(directory: Path) -> None:
    edit_json(directory / "result" / "pages" / "4.json", lambda p: p.update({"markdown": "edited"}))


def unhashed(directory: Path) -> None:
    """The recipe edited under its fingerprint: the loader proves the files, not the fingerprint."""
    edit_json(directory / "result" / "result.json", lambda m: m["recipe"].update({"crop_dpi": 300}))


def unreadable(directory: Path) -> None:
    (directory / "params.json").write_text("{not json", encoding="utf-8")


def hidden(directory: Path) -> None:
    directory.rename(directory.with_name(".prepare-run-a"))


@pytest.mark.parametrize("damage", [incomplete, tampered, unhashed, unreadable, hidden])
def test_a_candidate_that_cannot_be_proven_is_passed_over(digital_pdf, root, damage):
    donated = donor("run-a", digital_pdf, root)
    damage(root / "run-a")
    assert adopt(donated, root) is None


def test_a_run_never_adopts_its_own_result(digital_pdf, root):
    assert adopt(donor("run-a", digital_pdf, root), root, own="run-a") is None


def test_a_candidate_passed_over_falls_through_to_the_next(digital_pdf, root):
    donor("run-a", digital_pdf, root)
    tampered(root / "run-a")
    donated = donor("run-b", digital_pdf, root)
    adopted = adopt(donated, root)
    assert adopted is not None and adopted.reused_from == {"run_id": "run-b", "generation": donated.generation}


# --- The ingest: another run's proven generation of the same recipe, hard-linked in ----------------------------------
@pytest.fixture
def scanned(tmp_path) -> Path:
    return binary_pdf(tmp_path / "scan.pdf", mask(), mask(every=7))


def ingested(name: str, pdf: Path, root: Path) -> Path:
    """Run `name` with its own copy of `pdf` as `input.pdf`, ingested as `convert` does; its document directory."""
    doc_dir = document(pdf, root, name)
    runs.write_json(root / name / "params.json", {"id": name, "source_sha256": sha256_file(pdf)})
    ingest_step(root / name / "input.pdf", SINGLE, doc_dir)
    return doc_dir


def document(pdf: Path, root: Path, name: str = "run-own") -> Path:
    """Run `name`'s document directory, empty, beside its own copy of `pdf`."""
    (root / name / "input").mkdir(parents=True)
    shutil.copy(pdf, root / name / "input.pdf")
    return root / name / "input"


def test_a_proven_ingest_of_the_same_recipe_is_seeded_and_the_ingest_skips(scanned, root):
    donated = IngestPaths(ingested("run-a", scanned, root)).accepted
    doc_dir = document(scanned, root)
    (doc_dir / "ingest.staging" / "pages").mkdir(parents=True)  # left by an ingest of this run that was interrupted
    reuse.seed_ingest(doc_dir, sha256_file(scanned), SINGLE, own=root / "run-own")
    assert (doc_dir / "ingest" / "pages" / "001.png").samefile(donated / "pages" / "001.png")  # linked, not copied
    step, artifact = ingest_step(root / "run-own" / "input.pdf", SINGLE, doc_dir)
    assert step.skipped is True and len(artifact.pages) == 2
    assert sorted(entry.name for entry in doc_dir.iterdir()) == ["ingest"]


def test_an_ingest_already_accepted_is_not_seeded(scanned, root):
    ingested("run-a", scanned, root)
    doc_dir = document(scanned, root)
    (doc_dir / "ingest").mkdir()
    reuse.seed_ingest(doc_dir, sha256_file(scanned), SINGLE, own=root / "run-own")
    assert list((doc_dir / "ingest").iterdir()) == []


def test_another_ingest_recipe_is_not_seeded(scanned, root):
    ingested("run-a", scanned, root)
    doc_dir = document(scanned, root)
    reuse.seed_ingest(doc_dir, sha256_file(scanned), IngestConfig(split="spread"), own=root / "run-own")
    assert list(doc_dir.iterdir()) == []


def corrupt(donated: Path, monkeypatch) -> None:
    page = donated / "pages" / "001.png"
    page.write_bytes(page.read_bytes()[: page.stat().st_size // 2])


def unlinkable(donated: Path, monkeypatch) -> None:
    """Proven, but the copy fails once it has begun: what was made so far is removed again."""
    def refuse(source: str, target: str) -> None:
        raise PermissionError(target)
    monkeypatch.setattr(reuse, "_link", refuse)


@pytest.mark.parametrize("damage", [corrupt, unlinkable])
def test_a_seed_that_fails_leaves_nothing_behind_and_the_ingest_runs(scanned, root, monkeypatch, damage):
    damage(IngestPaths(ingested("run-a", scanned, root)).accepted, monkeypatch)
    doc_dir = document(scanned, root)
    reuse.seed_ingest(doc_dir, sha256_file(scanned), SINGLE, own=root / "run-own")
    assert list(doc_dir.iterdir()) == []
    step, _ = ingest_step(root / "run-own" / "input.pdf", SINGLE, doc_dir)
    assert step.skipped is False

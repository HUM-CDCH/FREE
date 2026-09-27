"""KIE reads the OCR stage's accepted result in place: the reader proves the files, the loader binds them to the
ingest and projects segments in memory (canonical evidence design §5, §6). Hand-built page files over a hand-built
spread-mode ingest; no PDF, no GPU."""
import subprocess
import sys

import pytest

from kei_exp.kie.document import Document, EvidenceRef
from kei_exp.kie.evidence import Evidence, EvidenceError, crop_overlaps, load_evidence
from kei_exp.pagefile import CropResult, ResultError, load_result, read_page
from tests.helpers.ingest import fixture, fixture_files, page_segment, spread_ingest

INGEST = spread_ingest()


@pytest.fixture(scope="module")
def loaded(tmp_path_factory) -> tuple[Evidence, object]:
    directory = fixture(tmp_path_factory.mktemp("good"), INGEST)
    return load_evidence(directory, INGEST), directory


def test_ids_are_positional_per_unit_and_a_rejected_entry_keeps_its_number(loaded):
    evidence, _ = loaded
    assert [segment.id for segment in evidence.segments] == ["p1_s1", "p1_s3", "p1_s5", "p2_s1", "p2_s2", "p3_s1", "p4_s1"]
    assert [segment.page for segment in evidence.segments] == [1, 1, 1, 2, 2, 3, 4]
    assert [segment.crop for segment in evidence.segments] == [1, 1, 3, 2, 2, 4, 5]
    assert [(segment.source.page, segment.source.index) for segment in evidence.segments] == [
        (1, 0), (1, 2), (1, 4), (1, 5), (1, 6), (2, 0), (2, 1)]
    assert [(r.page, r.unit, r.crop, r.index, r.reason) for r in evidence.report.rejected] == [
        (1, 1, 1, 1, "no_box"), (1, 1, 1, 3, "empty_after_clamp")]
    assert evidence.report.rejected[0].bbox_px is None
    assert evidence.report.rejected[1].bbox_px == (110.0, 0.0, 115.0, 10.0)


def test_boxes_are_book_page_pixels_through_the_recorded_rectangle(loaded):
    evidence, _ = loaded
    assert [segment.bbox for segment in evidence.segments] == [
        (12, 27, 30, 42), (220, 20, 230, 50), (200, 0, 240, 300), (0, 0, 160, 300), (0, 0, 2, 2), (0, 0, 240, 300),
        (0, 0, 160, 300)]
    by_id = {segment.id: segment for segment in evidence.segments}
    assert by_id["p1_s1"].text == "Kreis Wanzleben" and by_id["p1_s1"].conf == 0.9 and by_id["p1_s1"].label == "Text"
    assert by_id["p1_s5"].label == "PageHeader" and by_id["p2_s2"].text == "" and by_id["p2_s2"].status == "skipped"


def test_the_report_counts_and_names_the_overlapping_crops(loaded):
    evidence, _ = loaded
    report = evidence.report
    assert (report.pages_read, report.spreads_without_pages, report.segments, report.clamped) == (2, [], 7, 1)
    assert report.by_label == {"Text": 6, "PageHeader": 1} and report.by_status == {"ok": 6, "skipped": 1}
    assert report.empty_text == 1 and report.overlaps == {1: [(1, 3)]} and report.seconds >= 0


def test_every_evidence_reference_resolves_to_its_page_file_entry(loaded):
    """A reference names the generation, the PDF page and the position in that page file: resolvable and immutable."""
    evidence, directory = loaded
    result = load_result(directory)
    assert evidence.report.generation == result.manifest.generation and evidence.report.digest == result.manifest.digest
    for segment in evidence.segments:
        assert isinstance(segment.source, EvidenceRef) and segment.source.generation == evidence.report.generation
        entry = read_page(directory, segment.source.page, result.manifest).segments[segment.source.index]
        assert (entry.text, entry.unit, entry.crop, entry.label) == (segment.text, segment.page, segment.crop, segment.label)


def test_segments_assemble_into_a_document_with_the_ingest_pages(loaded):
    evidence, _ = loaded
    document = Document(source=INGEST.source, pages=INGEST.pages, segments=evidence.segments)
    assert len(document.segments) == 7


def test_a_page_range_result_records_the_spreads_without_pages(tmp_path):
    directory = fixture(tmp_path, INGEST, files={2: fixture_files()[2]})
    evidence = load_evidence(directory, INGEST)
    assert [segment.id for segment in evidence.segments] == ["p3_s1", "p4_s1"]
    assert evidence.report.spreads_without_pages == [1] and evidence.report.pages_read == 1


def test_crop_overlaps_are_the_pairs_sharing_a_native_pixel():
    crops = [CropResult.model_validate(c) for c in fixture_files("x")[1]["units"][0]["crops"]]
    assert crop_overlaps(crops) == [(1, 3)]
    assert crop_overlaps(crops[:1]) == []


def test_the_loader_imports_without_the_converter():
    """kie.evidence must not import the cut and with it docling: reading stored evidence needs no model stack."""
    subprocess.run([sys.executable, "-c", ("import sys, kei_exp.pagefile, kei_exp.kie.evidence; "
                                            "assert 'kei_exp.cut' not in sys.modules, 'the cut'; "
                                            "assert 'docling.document_converter' not in sys.modules, 'docling'")],
                   check=True)


def refusal(what, prepare, *naming, error=(ResultError, EvidenceError)):
    return pytest.param(prepare, naming, error, id=what)


REFUSALS = [
    refusal("an incomplete run", lambda m, f: m.update({"status": "incomplete", "incomplete": "page 1 capped"}),
            "incomplete", "page 1 capped", error=ResultError),
    refusal("a result over the PDF's own pages", lambda m, f: m["recipe"].update({"page_source": "pdf"}), "page_source"),
    refusal("another transcriber", lambda m, f: m["recipe"].update({"transcriber": "vlm"}), "transcriber", "vlm"),
    refusal("another result version", lambda m, f: m.update({"result_version": 99}), "result_version", "99"),
    refusal("another source", lambda m, f: m["recipe"].update({"source_sha256": "0" * 64}), "source_sha256"),
    refusal("another ingest", lambda m, f: m["recipe"].update({"ingest_digest": "0" * 64}), "ingest_digest"),
    refusal("no pages listed", lambda m, f: m.update({"pages": []}), "pages"),
    # The manifest's own page count bounds its pages, so the reader refuses this before the ingest is consulted.
    refusal("a spread the ingest has not", lambda m, f: (m.update({"pages": [1, 2, 3]}),
                                                          f.update({3: {**f[2], "page": 3}})), "3", error=ResultError),
    refusal("a listed page file that is missing", lambda m, f: f.pop(2), "pages/2.json", error=ResultError),
    refusal("a page file that is not listed", lambda m, f: m.update({"pages": [1]}), "pages/2.json"),
    refusal("a page file naming another page", lambda m, f: f[2].update({"page": 1}), "pages/2.json"),
    refusal("a page file of another generation", lambda m, f: f[2].update({"generation": "other"}), "pages/2.json",
            "generation"),
    refusal("an incomplete page under a successful run", lambda m, f: f[1].update({"complete": False}),
            "complete", "pages/1.json"),
    refusal("a unit that is the PDF page itself", lambda m, f: f[1]["units"][0].update({"index": 0, "kind": "pdf_page"}),
            "unit 0", error=EvidenceError),
    refusal("a unit whose kind contradicts its index", lambda m, f: f[1]["units"][0].update({"kind": "pdf_page"}),
            "unit 1", "pdf_page", error=ResultError),
    refusal("a unit the ingest has not", lambda m, f: f[1]["units"][1].update({"index": 9}), "unit 9"),
    refusal("a page file missing one of its spread's book pages", lambda m, f: f[1]["units"].pop(1), "unit 2"),
    refusal("a segment whose crop is not in its unit", lambda m, f: f[1]["segments"][0].update({"crop": 7}), "crop 7"),
    refusal("a segment from a crop of another unit", lambda m, f: f[1]["segments"][0].update({"crop": 2}), "crop 2"),
    refusal("a crop without its native rectangle", lambda m, f: f[2]["units"][0]["crops"][0].update({"source_px": None}),
            "source_px", "crop 4"),
    refusal("a whole-page segment", lambda m, f: f[2]["segments"][0].update({"crop": None}), "crop", "pages/2.json"),
    refusal("a segment with no label", lambda m, f: f[2]["segments"][0].update({"label": ""}), "label"),
    refusal("a segment with a confidence that is not a number",
            lambda m, f: f[2]["segments"][0].update({"confidence": float("nan")}), "confidence"),
    refusal("a page file that is not JSON", lambda m, f: f.update({2: "not json"}), "pages/2.json"),
    refusal("a page file of another shape", lambda m, f: f[2].update({"blocks": []}), "pages/2.json"),
]


@pytest.mark.parametrize("prepare, naming, error", REFUSALS)
def test_refusals_name_what_is_wrong(prepare, naming, error, tmp_path):
    directory = fixture(tmp_path, INGEST, prepare=prepare)
    with pytest.raises(error) as caught:
        load_evidence(directory, INGEST)
    silent = [text for text in naming if text not in str(caught.value)]
    assert not silent, f"refused, but the message does not say {silent}: {caught.value}"


def test_a_run_without_a_manifest_is_refused_by_the_reader(tmp_path):
    directory = fixture(tmp_path, INGEST)
    (directory / "result.json").unlink()
    with pytest.raises(ResultError, match="result.json"):
        load_evidence(directory, INGEST)


def test_a_whole_page_entry_is_no_evidence_over_the_ingest(tmp_path):
    """Over the ingest every input is a crop; the reference fixture pins the message for the one in page file 2."""
    directory = fixture(tmp_path, INGEST, prepare=lambda m, f: f[1]["segments"].append(page_segment(1, None, (0, 0, 1, 1))))
    with pytest.raises(EvidenceError, match="crop None"):
        load_evidence(directory, INGEST)


def test_a_book_page_id_resolves_through_its_reference_never_by_string_resemblance(loaded):
    """Internal ids count per book page; canonical ids are the PDF page and the page-file position. The right half
    of spread 1 is book page 2 on PDF page 1, and a rejected entry before it shifts every later position, so the
    strings differ and only the reference resolves one to the other."""
    evidence, directory = loaded
    by_id = {segment.id: segment for segment in evidence.segments}
    assert by_id["p2_s1"].source.segment_id == "p1_s5"
    assert by_id["p1_s3"].source.segment_id == "p1_s2"
    result = load_result(directory)
    for segment in evidence.segments:
        assert result.pages[segment.source.page].segments[segment.source.index].text == segment.text


def test_the_extraction_view_names_every_internal_segment_by_its_canonical_id(loaded, tmp_path):
    """What reaches Studio is the extraction view's id; it must be the resolved reference of the internal segment."""
    import shutil

    from kei_exp.kie.passages import load as load_view
    evidence, directory = loaded
    shutil.copytree(directory, tmp_path / "run" / "result")
    view = {passage.id: passage for passage in load_view(tmp_path / "run").passages}
    for segment in evidence.segments:
        if segment.status == "ok" and segment.text.strip():
            assert view[segment.source.segment_id].text == segment.text

"""Synthetic source identity stays stable when the same PDF fixture is generated again."""
from time import gmtime
from types import SimpleNamespace

from PIL import PdfImagePlugin

from tests.helpers.pdfs import binary_pdf, mask


def test_regenerating_the_same_pdf_across_a_second_keeps_its_bytes(tmp_path, monkeypatch):
    path = tmp_path / "scan.pdf"
    monkeypatch.setattr(PdfImagePlugin, "time", SimpleNamespace(gmtime=lambda: gmtime(1_700_000_000)))
    first = binary_pdf(path, mask()).read_bytes()
    monkeypatch.setattr(PdfImagePlugin, "time", SimpleNamespace(gmtime=lambda: gmtime(1_700_000_001)))
    second = binary_pdf(path, mask()).read_bytes()
    assert first == second

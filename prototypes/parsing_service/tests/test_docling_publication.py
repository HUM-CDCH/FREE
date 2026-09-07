from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import pypdfium2 as pdfium
from PIL import Image, ImageDraw

from docling_core.types.doc import (
    BoundingBox, ContentLayer, CoordOrigin, DocItemLabel, DoclingDocument, GroupLabel,
    ProvenanceItem, Size,
)

from app.docling_parser import DoclingParser
from support import PDF_BYTES


def provenance(x: float, y: float, width: float = 180, height: float = 25):
    return ProvenanceItem(
        page_no=1, charspan=(0, 0),
        bbox=BoundingBox(l=x, t=y, r=x + width, b=y + height, coord_origin=CoordOrigin.TOPLEFT),
    )


def publish(document: DoclingDocument):
    converter = SimpleNamespace(convert=lambda *args, **kwargs: SimpleNamespace(
        status="success", document=document, errors=[],
    ))
    digest = hashlib.sha256(PDF_BYTES).hexdigest()
    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / "source.pdf"
        source.write_bytes(PDF_BYTES)
        return DoclingParser(converter=converter).parse(source, {
            "document_id": f"sha256:{digest}", "content_sha256": digest,
            "preprocess_id": "publication-test", "source_name": source.name,
            "created_at": "2026-09-07T00:00:00+00:00",
        })


class DoclingPublicationTests(unittest.TestCase):
    def test_scanned_columns_keep_original_pdf_pages_and_evidence_coordinates(self):
        scan = Image.new('RGB', (1000, 700), 'white')
        draw = ImageDraw.Draw(scan)
        for left, right in ((60, 250), (270, 470), (580, 770), (790, 960)):
            for y in range(90, 620, 15):
                draw.rectangle((left, y, right, y + 4), fill='black')
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'spread.pdf'
            scan.save(source, 'PDF', resolution=72)
            original = source.read_bytes()
            digest = hashlib.sha256(original).hexdigest()
            def convert(path, **options):
                self.assertNotEqual(path, source)
                with pdfium.PdfDocument(path) as pdf:
                    self.assertEqual(len(pdf), 4)
                    document = DoclingDocument(name='four columns')
                    for index in range(4):
                        width, height = pdf[index].get_size()
                        document.add_page(index + 1, Size(width=width, height=height))
                        document.add_text(DocItemLabel.PAGE_HEADER if index == 2 else DocItemLabel.TEXT,
                            f'{index + 1}. Entry', content_layer=ContentLayer.FURNITURE if index == 2 else ContentLayer.BODY,
                            prov=ProvenanceItem(
                            page_no=index + 1, charspan=(0, 7),
                            bbox=BoundingBox(l=10, t=110, r=60, b=130, coord_origin=CoordOrigin.TOPLEFT),
                        ))
                return SimpleNamespace(status='success', document=document, errors=[])
            result = DoclingParser(converter=SimpleNamespace(convert=convert)).parse(source, {
                'document_id': f'sha256:{digest}', 'content_sha256': digest,
                'preprocess_id': 'columns-test', 'source_name': source.name,
                'created_at': '2026-09-07T00:00:00+00:00', 'max_num_pages': 1,
            })
            self.assertEqual(source.read_bytes(), original)
        parsed = result.parsed_document
        self.assertEqual(parsed['page_count'], 1)
        self.assertEqual(parsed['pages'][0]['width_pt'], 1000)
        self.assertEqual(parsed['document']['source']['byte_size'], len(original))
        observations = [a['producer_observations'][0] for a in parsed['evidence_index']['anchors']]
        self.assertEqual([o['page_number'] for o in observations], [1] * 4)
        for observation, minimum in zip(observations, (0, 250, 470, 770)):
            self.assertGreater(observation['bbox']['x0'], minimum)
            self.assertEqual(observation['bbox']['y0'], 110)
        self.assertEqual([b['text'] for b in parsed['content_stream']], [f'{i}. Entry' for i in range(1, 5)])

    def test_four_columns_read_left_to_right_with_exact_item_evidence(self):
        document = DoclingDocument(name="scanned spread")
        document.add_page(1, Size(width=1000, height=700))
        group = document.add_group(label=GroupLabel.LIST)
        # Docling can visit a right-column group before the lower left column,
        # and place each description before its own numbered entry.
        for column in (1, 0, 3, 2):
            x = 50 + column * 235
            document.add_text(DocItemLabel.TEXT, f"Finds {column + 1}.", prov=provenance(x, 145))
            document.add_list_item(f"Fündort {column + 1}.", marker=f"{column + 1}.",
                                   enumerated=True, parent=group, prov=provenance(x, 110))
        result = publish(document)
        blocks = result.parsed_document["content_stream"]
        text = [b["items"][0] if b["kind"] == "list" else b["text"] for b in blocks]
        expected = [value for n in range(1, 5) for value in (f"{n}. Fündort {n}.", f"Finds {n}.")]
        self.assertEqual(text, expected)
        markdown = result.markdown.encode("utf8")
        spans = []
        for block, value in zip(blocks, expected):
            span = block["markdown_span"]
            self.assertEqual(markdown[span["start"]:span["end"]].decode("utf8"), value)
            spans.append((span["start"], span["end"]))
        self.assertEqual(len(set(spans)), len(blocks))
        self.assertEqual(result.parsed_document["pages"][0]["ordered_content"],
                         [block["block_id"] for block in blocks])
        self.assertEqual(len(result.parsed_document["evidence_index"]["anchors"]), len(blocks))

    def test_wide_headings_separate_column_bands(self):
        document = DoclingDocument(name="column bands")
        document.add_page(1, Size(width=1000, height=700))
        for text, x, y in (("Upper right", 530, 80), ("Lower right", 530, 300),
                           ("Lower left", 50, 300), ("Upper left", 50, 80)):
            document.add_text(DocItemLabel.TEXT, text, prov=provenance(x, y, 400))
        document.add_heading("Middle heading", prov=provenance(50, 200, 880))
        document.add_heading("Title", prov=provenance(50, 20, 880))
        result = publish(document)
        self.assertEqual([b["text"] for b in result.parsed_document["content_stream"]],
                         ["Title", "Upper left", "Upper right", "Middle heading", "Lower left", "Lower right"])

    def test_preserves_source_markers_without_inventing_list_numbers(self):
        document = DoclingDocument(name="list markers")
        document.add_page(1, Size(width=600, height=800))
        group = document.add_group(label=GroupLabel.LIST)
        for text, marker, y in (("Catalogue site", "29.", 40), ("Grave description", "b)", 100),
                                ("Museum reference", "", 150)):
            document.add_list_item(text, marker=marker, enumerated=True, parent=group,
                                   prov=provenance(50, y, 400))
        result = publish(document)
        self.assertEqual([b["items"][0] for b in result.parsed_document["content_stream"]],
                         ["29. Catalogue site", "b) Grave description", "Museum reference"])
        self.assertIn("\n\nb) Grave description\n\nMuseum reference", result.markdown)


if __name__ == "__main__":
    unittest.main()

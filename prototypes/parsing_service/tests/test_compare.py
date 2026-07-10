import os
import tempfile
import types
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import compare

PDF_BYTES = b"%PDF-1.4\n% test\n"


class FakeDocument:
    def export_to_markdown(self):
        return "# Fake Markdown"


class FakeDocumentResult:
    document = FakeDocument()


class FakeDocumentConverter:
    def convert(self, source):
        return FakeDocumentResult()


class FakeDocumentConverterModule(types.ModuleType):
    DocumentConverter = FakeDocumentConverter


class TestCompareBehavior(unittest.TestCase):
    def test_average_time_per_page_handles_empty_document(self):
        self.assertEqual(compare.average_time_per_page(4.2, 0), 0.0)
        self.assertEqual(compare.average_time_per_page(4.2, 2), 2.1)

    def _write_pdf(self, path):
        try:
            with open(path, "wb") as output_file:
                output_file.write(PDF_BYTES)
        except OSError as exc:
            self.fail(f"Could not write PDF fixture: {exc}")

    def _fake_docling_modules(self):
        docling = types.ModuleType("docling")
        document_converter = FakeDocumentConverterModule("docling.document_converter")
        return {"docling": docling, "docling.document_converter": document_converter}

    def _args(self, pdf_path, output_dir, pipeline):
        return SimpleNamespace(
            source=pdf_path,
            output_dir=output_dir,
            dpi=150,
            device="cpu",
            images_dir=None,
            pipeline=pipeline,
        )

    def test_cli_requires_source_and_defaults_to_cpu(self):
        with patch("sys.argv", ["compare.py", "--source", "fixture.pdf"]):
            args = compare.parse_args()
        self.assertEqual(args.device, "cpu")
        self.assertEqual(args.source, "fixture.pdf")

    @patch("compare.convert_pdf_to_images")
    def test_all_mode_rasterizes_once_and_reuses_local_images(self, mock_convert):
        with tempfile.TemporaryDirectory() as tmp_dir:
            pdf_path = os.path.join(tmp_dir, "source.pdf")
            image_path = os.path.join(tmp_dir, "page_01.png")
            self._write_pdf(pdf_path)
            mock_convert.return_value = [image_path]
            with (
                patch(
                    "compare.parse_args",
                    return_value=self._args(pdf_path, tmp_dir, "all"),
                ),
                patch("compare.subprocess.run") as mock_run,
            ):
                compare.main()

        mock_convert.assert_called_once()
        self.assertEqual(mock_run.call_count, 2)
        for call in mock_run.call_args_list:
            command = call.args[0]
            self.assertEqual(command[command.index("--source") + 1], pdf_path)
            self.assertIn("--images-dir", command)

    @patch("compare.convert_pdf_to_images")
    def test_docling_pdf_skips_rasterization_and_writes_stable_output(
        self, mock_convert
    ):
        with (
            tempfile.TemporaryDirectory() as tmp_dir,
            patch.dict("sys.modules", self._fake_docling_modules()),
        ):
            pdf_path = os.path.join(tmp_dir, "source.pdf")
            self._write_pdf(pdf_path)
            with patch(
                "compare.parse_args",
                return_value=self._args(pdf_path, tmp_dir, "docling_pdf"),
            ):
                compare.main()

            mock_convert.assert_not_called()
            self.assertTrue(
                os.path.exists(
                    os.path.join(tmp_dir, "source", "docling_pdf", "document.md")
                )
            )
            self.assertTrue(
                os.path.exists(os.path.join(tmp_dir, "source", "stats_docling.json"))
            )

    @patch("compare.convert_pdf_to_images")
    def test_image_pipeline_rasterizes_pages(self, mock_convert):
        with (
            tempfile.TemporaryDirectory() as tmp_dir,
            patch.dict("sys.modules", self._fake_docling_modules()),
        ):
            pdf_path = os.path.join(tmp_dir, "source.pdf")
            image_path = os.path.join(tmp_dir, "page_01.png")
            self._write_pdf(pdf_path)
            mock_convert.return_value = [image_path]
            with patch(
                "compare.parse_args",
                return_value=self._args(pdf_path, tmp_dir, "docling_images"),
            ):
                compare.main()

            mock_convert.assert_called_once()


if __name__ == "__main__":
    unittest.main()

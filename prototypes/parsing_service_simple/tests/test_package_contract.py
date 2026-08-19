from __future__ import annotations

import hashlib
import io
import json
import stat
import tempfile
import unittest
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import create_app
from support import PDF_BYTES, ImmediateParser, submit_pdf, wait_for_status


ENTRY_CONTRACT = (
    ("source.pdf", "application/pdf"),
    ("parsed_document.json", "application/json"),
    ("artifacts/document.llm.md", "text/markdown; charset=utf-8"),
)


class CanonicalPackageContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.data_root = Path(self.temporary.name)

    def test_download_is_a_deterministic_fixed_layout_package(self) -> None:
        app = create_app(parser=ImmediateParser(), data_root=self.data_root)
        with TestClient(app) as client:
            created = submit_pdf(client).json()
            wait_for_status(client, created["task_id"], "completed")
            first = client.get(f"/tasks/{created['task_id']}/download")
            second = client.get(f"/tasks/{created['task_id']}/download")
            public_document = client.get(f"/tasks/{created['task_id']}/source").json()
            public_markdown = client.get(
                f"/tasks/{created['task_id']}/markdown"
            ).content

        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.content, second.content)

        with zipfile.ZipFile(io.BytesIO(first.content)) as archive:
            infos = archive.infolist()
            names = [info.filename for info in infos]
            self.assertEqual(
                names,
                ["manifest.json", *(path for path, _ in ENTRY_CONTRACT)],
            )
            self.assertEqual(len(names), 4)
            self.assertTrue(all(not name.endswith("/") for name in names))
            # A fixed DOS epoch prevents archive bytes changing with wall time.
            self.assertTrue(
                all(info.date_time == (1980, 1, 1, 0, 0, 0) for info in infos),
                [info.date_time for info in infos],
            )
            for info in infos:
                self.assertEqual(info.compress_type, zipfile.ZIP_STORED)
                self.assertEqual(info.create_system, 3)
                self.assertEqual(info.create_version, 20)
                self.assertEqual(info.extract_version, 20)
                self.assertEqual(
                    info.external_attr >> 16,
                    stat.S_IFREG | 0o644,
                )
            entries = {name: archive.read(name) for name in names}

        manifest = json.loads(entries["manifest.json"])
        document = json.loads(entries["parsed_document.json"])

        self.assertEqual(
            set(manifest),
            {
                "package_version",
                "parsed_document_schema_version",
                "source_sha256",
                "preprocess_id",
                "entries",
            },
        )
        self.assertEqual(manifest["package_version"], "canonical-ingestion-package.v1")
        self.assertEqual(
            manifest["parsed_document_schema_version"], "parsed_document.v2"
        )
        self.assertEqual(
            [(entry["path"], entry["media_type"]) for entry in manifest["entries"]],
            list(ENTRY_CONTRACT),
        )
        for entry in manifest["entries"]:
            self.assertEqual(
                set(entry), {"path", "media_type", "size", "sha256"}
            )
            artifact = entries[entry["path"]]
            self.assertEqual(entry["size"], len(artifact))
            self.assertEqual(entry["sha256"], hashlib.sha256(artifact).hexdigest())

        source_sha256 = hashlib.sha256(PDF_BYTES).hexdigest()
        self.assertEqual(entries["source.pdf"], PDF_BYTES)
        self.assertEqual(manifest["source_sha256"], source_sha256)
        self.assertEqual(document["schema_version"], "parsed_document.v2")
        self.assertEqual(document["document"]["content_sha256"], source_sha256)
        self.assertEqual(document["document"]["document_id"], created["document_id"])
        self.assertEqual(
            document["preprocessing"]["preprocess_id"], manifest["preprocess_id"]
        )
        self.assertEqual(
            document["arbitration"]["primary_document_parser"], "docling"
        )
        self.assertTrue(
            any(
                run["parser"]
                == document["arbitration"]["primary_document_parser"]
                for run in document["parser_runs"]
            )
        )
        self.assertEqual(document, public_document)
        self.assertEqual(entries["artifacts/document.llm.md"], public_markdown)


if __name__ == "__main__":
    unittest.main()

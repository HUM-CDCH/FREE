import os
import sys
import unittest
import tempfile
from unittest.mock import AsyncMock, patch, MagicMock
from fastapi.testclient import TestClient

# Add workspace folder to path if not already there
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from main import app, DATA_DIR, load_metadata, save_metadata

class TestService(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        # Ensure DATA_DIR exists
        os.makedirs(DATA_DIR, exist_ok=True)

    def test_status_endpoint(self):
        response = self.client.get("/status")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("status", data)
        self.assertIn("gpu_available", data)
        self.assertEqual(data["status"], "online")

    def test_tasks_validation(self):
        # Neither file nor url
        response = self.client.post("/tasks")
        self.assertEqual(response.status_code, 400)
        self.assertIn("Must provide either", response.json()["detail"])

        # Both file and url
        response = self.client.post(
            "/tasks",
            data={"url": "https://arxiv.org/pdf/2408.09869"},
            files={"file": ("dummy.pdf", b"%PDF-1.4 ...", "application/pdf")}
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("Provide either 'file' or 'url', not both", response.json()["detail"])

    @patch("main.convert_pdf_to_images")
    def test_convert_images_endpoint_returns_png_data_urls(self, mock_convert):
        with tempfile.TemporaryDirectory() as tmp_dir:
            image_path = os.path.join(tmp_dir, "page_01.png")
            with open(image_path, "wb") as image_file:
                image_file.write(b"page")
            mock_convert.return_value = [image_path]

            response = self.client.post(
                "/convert/images",
                data={"dpi": "150"},
                files={"file": ("report.pdf", b"%PDF-1.4", "application/pdf")},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "pages": 1,
                "images": [
                    {
                        "filename": "page_01.png",
                        "media_type": "image/png",
                        "data_url": "data:image/png;base64,cGFnZQ==",
                    }
                ],
            },
        )

    @patch("main.asyncio.create_subprocess_exec")
    @patch("main.run_in_threadpool")
    def test_create_task_with_url(self, mock_threadpool, mock_subproc):
        # Mock download success
        mock_threadpool.return_value = None

        # Mock subprocess completion
        mock_process = AsyncMock()
        mock_process.wait.return_value = 0
        mock_subproc.return_value = mock_process

        response = self.client.post(
            "/tasks",
            data={"url": "https://example.com/test.pdf"}
        )
        self.assertEqual(response.status_code, 202)
        res_data = response.json()
        self.assertIn("task_id", res_data)
        self.assertEqual(res_data["status"], "pending")

        task_id = res_data["task_id"]

        # Load task metadata directly to verify
        metadata = load_metadata(task_id)
        self.assertEqual(metadata["params"]["source_name"], "test.pdf")
        self.assertEqual(metadata["status"], "completed")

        # Clean up task dir
        task_dir = os.path.join(DATA_DIR, task_id)
        if os.path.exists(task_dir):
            import shutil
            shutil.rmtree(task_dir)

    def test_get_nonexistent_task(self):
        response = self.client.get("/tasks/nonexistent-id")
        self.assertEqual(response.status_code, 404)

    @patch("main.asyncio.create_subprocess_exec")
    @patch("main.run_in_threadpool")
    def test_create_task_with_json_params(self, mock_threadpool, mock_subproc):
        # Mock download success
        mock_threadpool.return_value = None

        # Mock subprocess completion
        mock_process = AsyncMock()
        mock_process.wait.return_value = 0
        mock_subproc.return_value = mock_process

        response = self.client.post(
            "/tasks",
            data={
                "url": "https://example.com/test.pdf",
                "pipeline": '{"type": "paddleocr"}',
                "device": '{"type": "cpu"}'
            }
        )
        self.assertEqual(response.status_code, 202)
        res_data = response.json()
        self.assertIn("task_id", res_data)

        task_id = res_data["task_id"]
        metadata = load_metadata(task_id)
        self.assertEqual(metadata["params"]["pipeline"], "paddleocr")
        self.assertEqual(metadata["params"]["device"], "cpu")

        # Clean up task dir
        task_dir = os.path.join(DATA_DIR, task_id)
        if os.path.exists(task_dir):
            import shutil
            shutil.rmtree(task_dir)


    def test_get_task_markdown_endpoint(self):
        task_id = "test-markdown-direct-id"
        task_dir = os.path.join(DATA_DIR, task_id)
        os.makedirs(task_dir, exist_ok=True)

        # Save metadata
        metadata = {
            "task_id": task_id,
            "status": "completed",
            "created_at": "2026-06-23T00:00:00Z",
            "updated_at": "2026-06-23T00:00:00Z",
            "params": {"pipeline": "all", "device": "cpu", "source_name": "test.pdf"},
            "stats": {},
            "error": None
        }
        save_metadata(task_id, metadata)

        # Create output directories for the various pipelines
        output_dir = os.path.join(task_dir, "output", "test_doc")

        docling_pdf_dir = os.path.join(output_dir, "docling_pdf")
        docling_img_dir = os.path.join(output_dir, "docling_images")
        paddle_img_dir = os.path.join(output_dir, "paddleocr_images")

        os.makedirs(docling_pdf_dir, exist_ok=True)
        os.makedirs(docling_img_dir, exist_ok=True)
        os.makedirs(paddle_img_dir, exist_ok=True)

        # 1. Write docling_pdf markdown
        with open(os.path.join(docling_pdf_dir, "document.md"), "w") as f:
            f.write("# Docling PDF Content")

        # 2. Write docling_images page markdowns
        with open(os.path.join(docling_img_dir, "page_01.md"), "w") as f:
            f.write("# Docling Img Page 1")
        with open(os.path.join(docling_img_dir, "page_02.md"), "w") as f:
            f.write("# Docling Img Page 2")

        # 3. Write paddleocr page markdowns
        os.makedirs(os.path.join(paddle_img_dir, "page_01"), exist_ok=True)
        os.makedirs(os.path.join(paddle_img_dir, "page_02"), exist_ok=True)
        with open(os.path.join(paddle_img_dir, "page_01", "page_01.md"), "w") as f:
            f.write("# Paddle Page 1")
        with open(os.path.join(paddle_img_dir, "page_02", "page_02.md"), "w") as f:
            f.write("# Paddle Page 2")

        try:
            # A. Test auto-detect (defaults to docling_pdf)
            response = self.client.get(f"/tasks/{task_id}/markdown")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers.get("content-type"), "text/markdown; charset=utf-8")
            self.assertEqual(response.text, "# Docling PDF Content")

            # B. Test explicit docling_pdf pipeline
            response = self.client.get(f"/tasks/{task_id}/markdown?pipeline=docling_pdf")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.text, "# Docling PDF Content")

            # C. Test explicit docling_images pipeline
            response = self.client.get(f"/tasks/{task_id}/markdown?pipeline=docling_images")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.text, "# Docling Img Page 1\n\n# Docling Img Page 2")

            # D. Test explicit paddleocr pipeline
            response = self.client.get(f"/tasks/{task_id}/markdown?pipeline=paddleocr")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.text, "# Paddle Page 1\n\n# Paddle Page 2")

            # E. Test invalid pipeline
            response = self.client.get(f"/tasks/{task_id}/markdown?pipeline=invalid")
            self.assertEqual(response.status_code, 400)
        finally:
            if os.path.exists(task_dir):
                import shutil
                shutil.rmtree(task_dir)

    def test_openapi_schema_custom_objects(self):
        response = self.client.get("/openapi.json")
        self.assertEqual(response.status_code, 200)
        openapi = response.json()

        # Check that PipelineConfig and DeviceConfig exist in components/schemas
        schemas = openapi["components"]["schemas"]
        self.assertIn("PipelineConfig", schemas)
        self.assertIn("DeviceConfig", schemas)

        # Check that /tasks POST requestBody schema properties use these schemas
        body_schema = schemas["Body_create_task_tasks_post"]
        multipart_properties = body_schema["properties"]
        self.assertEqual(multipart_properties["pipeline"]["$ref"], "#/components/schemas/PipelineConfig")
        self.assertEqual(multipart_properties["device"]["$ref"], "#/components/schemas/DeviceConfig")

if __name__ == "__main__":
    unittest.main()

import os
import sys
import unittest
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

if __name__ == "__main__":
    unittest.main()

import unittest

from fastapi.testclient import TestClient

import main
from application import ApplicationServices


class ApplicationServicesTests(unittest.TestCase):
    def test_lifespan_exposes_only_route_facing_pipelines(self) -> None:
        with TestClient(main.app) as client:
            services = client.app.state.services

        self.assertIsInstance(services, ApplicationServices)
        self.assertEqual(
            set(services.__dataclass_fields__),
            {"chat", "extract", "generate_template", "markdown"},
        )
        self.assertFalse(hasattr(services, "model_gateway"))
        self.assertFalse(hasattr(services, "source_document"))
        self.assertFalse(hasattr(services, "source_context"))


if __name__ == "__main__":
    unittest.main()

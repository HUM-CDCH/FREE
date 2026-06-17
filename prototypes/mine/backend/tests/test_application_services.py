import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from config import Settings
import main
from application import ApplicationServices, build_application_services
from shared.nuextract_request import NuExtractTaskControlChannel


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

    def test_application_services_select_ollama_message_text_channel(self) -> None:
        services = self.build_services_for_provider("ollama")

        self.assertEqual(
            services.extract._nuextract_requests._task_control_channel,
            NuExtractTaskControlChannel.MESSAGE_TEXT,
        )

    def test_application_services_select_vllm_template_kwargs_channel(self) -> None:
        services = self.build_services_for_provider("vllm")

        self.assertEqual(
            services.extract._nuextract_requests._task_control_channel,
            NuExtractTaskControlChannel.TEMPLATE_KWARGS,
        )

    def test_application_services_select_openai_template_kwargs_channel(self) -> None:
        services = self.build_services_for_provider("openai")

        self.assertEqual(
            services.extract._nuextract_requests._task_control_channel,
            NuExtractTaskControlChannel.TEMPLATE_KWARGS,
        )

    def build_services_for_provider(self, provider: str) -> ApplicationServices:
        settings = Settings(provider=provider)
        with patch("application.create_model_provider") as create_provider:
            create_provider.return_value = object()
            return build_application_services(settings, client=None)  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()

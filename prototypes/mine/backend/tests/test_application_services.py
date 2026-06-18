import unittest

from fastapi.testclient import TestClient

from config import Settings
import main
from application import ApplicationServices, build_application_services
from shared.model_command import ChatTask, ModelCommand


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
        self.assertFalse(hasattr(services, "model_executor"))
        self.assertFalse(hasattr(services, "request_compiler"))
        self.assertFalse(hasattr(services, "provider_transport"))
        self.assertFalse(hasattr(services, "source_document"))
        self.assertFalse(hasattr(services, "source_context"))

    def test_application_services_configure_provider_compiler_profile(self) -> None:
        cases = {
            "ollama": "http://example.test/v1/chat/completions",
            "vllm": "http://example.test/chat/completions",
            "openai": "http://example.test/chat/completions",
        }
        for provider, expected_url in cases.items():
            with self.subTest(provider=provider):
                services = self.build_services_for_provider(provider)
                compiler = services.chat._model_executor._compiler
                prepared = compiler.compile(
                    ModelCommand(
                        task=ChatTask(),
                        content=[{"type": "text", "text": "Hello"}],
                    )
                )

                self.assertEqual(prepared.url, expected_url)

    def build_services_for_provider(self, provider: str) -> ApplicationServices:
        settings = Settings(provider=provider, base_url="http://example.test")
        return build_application_services(settings, client=None)  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()

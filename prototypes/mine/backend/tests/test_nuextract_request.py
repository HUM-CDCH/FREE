import unittest

from shared.nuextract_request import (
    NuExtractRequestBuilder,
    NuExtractTaskControlChannel,
    TEMPLATE_GENERATION_TASK_INSTRUCTIONS,
    nuextract_control_channel_for_provider,
)


class NuExtractRequestBuilderTests(unittest.TestCase):
    def test_provider_control_channel_mapping(self) -> None:
        self.assertEqual(
            nuextract_control_channel_for_provider("ollama"),
            NuExtractTaskControlChannel.MESSAGE_TEXT,
        )
        self.assertEqual(
            nuextract_control_channel_for_provider("vllm"),
            NuExtractTaskControlChannel.TEMPLATE_KWARGS,
        )
        self.assertEqual(
            nuextract_control_channel_for_provider("openai"),
            NuExtractTaskControlChannel.TEMPLATE_KWARGS,
        )

    def test_message_text_structured_extraction_places_controls_in_content(self) -> None:
        builder = NuExtractRequestBuilder(
            task_control_channel=NuExtractTaskControlChannel.MESSAGE_TEXT
        )
        content = [{"type": "text", "text": "Document body"}]

        request = builder.structured_extraction(
            content=content,
            template_json='{"name": "string"}',
            instruction="Use source text only.",
            reasoning=True,
            temperature=0.2,
        )

        self.assertIn("Return ONLY a single JSON object", request.content[0]["text"])
        self.assertEqual(request.content[1], content[0])
        self.assertEqual(
            request.content[2]["text"],
            'Instructions:\nUse source text only.\n\n'
            'Extraction template:\n```json\n{"name": "string"}\n```',
        )
        self.assertEqual(request.template_kwargs, {"enable_thinking": True})
        self.assertTrue(request.reasoning)
        self.assertEqual(request.temperature, 0.2)

    def test_template_kwargs_structured_extraction_places_controls_in_kwargs(self) -> None:
        builder = NuExtractRequestBuilder(
            task_control_channel=NuExtractTaskControlChannel.TEMPLATE_KWARGS
        )

        request = builder.structured_extraction(
            content=[{"type": "text", "text": "Document body"}],
            template_json='{"name": "string"}',
            instruction="Use source text only.",
            reasoning=True,
            temperature=0.2,
        )

        self.assertEqual(request.content, [{"type": "text", "text": "Document body"}])
        self.assertEqual(
            request.template_kwargs,
            {
                "mode": "structured",
                "enable_thinking": True,
                "template": '{"name": "string"}',
                "instructions": "Use source text only.",
            },
        )

    def test_message_text_content_extraction_places_instruction_in_content(self) -> None:
        builder = NuExtractRequestBuilder(
            task_control_channel=NuExtractTaskControlChannel.MESSAGE_TEXT
        )

        request = builder.content_extraction(
            content=[{"type": "text", "text": "Document body"}],
            instruction="Summarize the site.",
            reasoning=False,
            temperature=None,
        )

        self.assertIn("<answer>", request.content[0]["text"])
        self.assertEqual(request.content[1]["text"], "Document body")
        self.assertEqual(request.content[2]["text"], "Instructions:\nSummarize the site.")
        self.assertEqual(request.template_kwargs, {"enable_thinking": False})
        self.assertFalse(request.reasoning)
        self.assertIsNone(request.temperature)

    def test_template_kwargs_content_extraction_places_instruction_in_kwargs(self) -> None:
        builder = NuExtractRequestBuilder(
            task_control_channel=NuExtractTaskControlChannel.TEMPLATE_KWARGS
        )

        request = builder.content_extraction(
            content=[{"type": "text", "text": "Document body"}],
            instruction="Summarize the site.",
            reasoning=False,
            temperature=None,
        )

        self.assertEqual(request.content, [{"type": "text", "text": "Document body"}])
        self.assertEqual(
            request.template_kwargs,
            {
                "mode": "content",
                "enable_thinking": False,
                "instructions": "Summarize the site.",
            },
        )
        self.assertFalse(request.reasoning)
        self.assertIsNone(request.temperature)

    def test_message_text_schema_suggestion_places_mode_guidance_in_content(self) -> None:
        builder = NuExtractRequestBuilder(
            task_control_channel=NuExtractTaskControlChannel.MESSAGE_TEXT
        )

        request = builder.schema_suggestion(
            content=[
                {
                    "type": "image_url",
                    "image_url": {"url": "data:image/png;base64,AA=="},
                }
            ],
            guidance="Generate a concise JSON extraction template.",
            temperature=0.3,
        )

        self.assertIn(
            "Generate a concise JSON extraction template", request.content[0]["text"]
        )
        self.assertEqual(request.content[1]["type"], "image_url")
        self.assertEqual(
            request.content[2]["text"],
            "Generate a concise JSON extraction template.",
        )
        self.assertEqual(request.template_kwargs, {"enable_thinking": False})
        self.assertFalse(request.reasoning)
        self.assertEqual(request.temperature, 0.3)

    def test_message_text_schema_suggestion_does_not_repeat_base_task_guidance(self) -> None:
        builder = NuExtractRequestBuilder(
            task_control_channel=NuExtractTaskControlChannel.MESSAGE_TEXT
        )
        annotation_guidance = (
            f"{TEMPLATE_GENERATION_TASK_INSTRUCTIONS}\n\n"
            "Design the extraction template from the whole source document."
        )

        request = builder.schema_suggestion(
            content=[
                {
                    "type": "image_url",
                    "image_url": {"url": "data:image/png;base64,AA=="},
                }
            ],
            guidance=annotation_guidance,
            temperature=None,
        )

        self.assertEqual(
            request.content[0]["text"], TEMPLATE_GENERATION_TASK_INSTRUCTIONS
        )
        self.assertEqual(request.content[1]["type"], "image_url")
        self.assertEqual(
            request.content[2]["text"],
            "Design the extraction template from the whole source document.",
        )
        rendered_text = "\n\n".join(
            part["text"] for part in request.content if part.get("type") == "text"
        )
        self.assertEqual(rendered_text.count(TEMPLATE_GENERATION_TASK_INSTRUCTIONS), 1)

    def test_template_kwargs_schema_suggestion_keeps_guidance_in_content(self) -> None:
        builder = NuExtractRequestBuilder(
            task_control_channel=NuExtractTaskControlChannel.TEMPLATE_KWARGS
        )

        request = builder.schema_suggestion(
            content=[{"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}}],
            guidance="Generate a concise JSON extraction template.",
            temperature=0.3,
        )

        self.assertEqual(request.content[0]["type"], "image_url")
        self.assertEqual(
            request.content[1]["text"],
            "Generate a concise JSON extraction template.",
        )
        self.assertEqual(
            request.template_kwargs,
            {"mode": "template-generation", "enable_thinking": False},
        )
        self.assertFalse(request.reasoning)
        self.assertEqual(request.temperature, 0.3)

    def test_template_generation_alias_preserves_route_compatibility(self) -> None:
        builder = NuExtractRequestBuilder(
            task_control_channel=NuExtractTaskControlChannel.TEMPLATE_KWARGS
        )

        request = builder.template_generation(
            content=[{"type": "text", "text": "Document body"}],
            guidance="Generate fields.",
            temperature=None,
        )

        self.assertEqual(
            request.template_kwargs,
            {"mode": "template-generation", "enable_thinking": False},
        )

    def test_message_text_markdown_places_mode_in_content(self) -> None:
        builder = NuExtractRequestBuilder(
            task_control_channel=NuExtractTaskControlChannel.MESSAGE_TEXT
        )

        request = builder.markdown(
            content=[{"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}}],
            reasoning=True,
            temperature=0.1,
        )

        self.assertIn("Markdown", request.content[0]["text"])
        self.assertEqual(request.content[1]["type"], "image_url")
        self.assertEqual(request.template_kwargs, {"enable_thinking": True})
        self.assertTrue(request.reasoning)
        self.assertEqual(request.temperature, 0.1)

    def test_template_kwargs_markdown_places_mode_in_kwargs(self) -> None:
        builder = NuExtractRequestBuilder(
            task_control_channel=NuExtractTaskControlChannel.TEMPLATE_KWARGS
        )

        request = builder.markdown(
            content=[{"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}}],
            reasoning=True,
            temperature=0.1,
        )

        self.assertEqual(request.content[0]["type"], "image_url")
        self.assertEqual(
            request.template_kwargs,
            {"mode": "markdown", "enable_thinking": True},
        )
        self.assertTrue(request.reasoning)
        self.assertEqual(request.temperature, 0.1)


if __name__ == "__main__":
    unittest.main()

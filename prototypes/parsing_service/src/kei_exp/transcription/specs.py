"""Docling VLM specifications used by transcription and parse recipes."""
from docling.datamodel.pipeline_options_vlm_model import ResponseFormat
from docling.datamodel.stage_model_specs import (
    VLM_CONVERT_GRANITE_DOCLING,
    VLM_CONVERT_GRANITE_VISION,
    VLM_CONVERT_NANONETS_OCR2,
    VlmModelSpec,
)


# Official doc2md prompt: https://github.com/infly-ai/INF-MLLM/tree/main/Infinity-Parser2
INFINITY_PROMPT = r"""
You are an AI assistant specialized in converting PDF images to Markdown format. Please follow these instructions for the conversion:

1. Text Processing:
- Accurately recognize all text content in the PDF image without guessing or inferring.
- Convert the recognized text into Markdown format.
- Maintain the original document structure, including headings, paragraphs, lists, etc.
2. Mathematical Formula Processing:
- Convert all mathematical formulas to LaTeX format.
- Enclose inline formulas with $ $. For example: This is an inline formula $E = mc^2$
- Enclose block formulas with $$ $$. For example: $$\frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$$

3. Table Processing:
- Convert tables to HTML format.

4. Figure Handling:
- Ignore figures content in the PDF image. Do not attempt to describe or convert images.
5. Output Format:
- Ensure the output Markdown document has a clear structure with appropriate line breaks between elements.
- For complex layouts, try to maintain the original document's structure and format as closely as possible.

Please strictly follow these guidelines to ensure accuracy and consistency in the conversion. Your task is to accurately convert the content of the PDF image into Markdown format without adding any extra explanations or comments.
"""


VLM_SPECS: dict[str, VlmModelSpec] = {
    "granite_vision": VLM_CONVERT_GRANITE_VISION.model_spec,
    "granite_docling": VLM_CONVERT_GRANITE_DOCLING.model_spec,
    "nanonets_ocr2": VLM_CONVERT_NANONETS_OCR2.model_spec,
    "infinity_parser": VlmModelSpec(
        name="Infinity-Parser2-Flash", default_repo_id="infly/Infinity-Parser2-Flash",
        prompt=INFINITY_PROMPT, response_format=ResponseFormat.MARKDOWN, max_new_tokens=16384,
    ),
}

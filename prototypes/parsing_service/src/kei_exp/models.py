import os
from dataclasses import dataclass, field

from docling.datamodel.pipeline_options_vlm_model import ResponseFormat
from docling.datamodel.stage_model_specs import (
    VLM_CONVERT_GRANITE_DOCLING,
    VLM_CONVERT_GRANITE_VISION,
    VLM_CONVERT_NANONETS_OCR2,
    VlmModelSpec,
)


@dataclass(frozen=True)
class Model:
    repo: str                          # vLLM model id
    kind: str = "vlm"                  # the transcriber that runs it: vlm (Docling's VLM pipeline) or surya
    context: int = 32768               # vLLM --max-model-len
    max_new_tokens: int | None = None  # None = keep the spec's allowance
    params: dict = field(default_factory=dict)  # extra generation params: vLLM request fields for a vlm record,
                                                 # Surya settings assigned by transcription.surya.configure for surya
    spec: VlmModelSpec | None = None   # Docling model spec: prompt, response format, allowance; vlm records need one
    scale: float = 3                   # render scale when there are no VLM options (Surya: 192 dpi)

    def __post_init__(self) -> None:
        if self.kind == "vlm" and self.spec is None:
            raise ValueError(f"{self.repo}: a vlm record needs a Docling model spec")

    @property
    def vlm(self) -> bool:
        return self.kind == "vlm"


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


MODELS: dict[str, Model] = {
    # Docling's presets share their specs across calls; vlm_options copies before editing.
    # repetition_penalty prevents the whitespace loop reproduced on ordinary text pages.
    "granite_vision": Model("ibm-granite/granite-vision-4.1-4b", max_new_tokens=8192,
                            params={"repetition_penalty": 1.05}, spec=VLM_CONVERT_GRANITE_VISION.model_spec),
    # 6144 reserves room for image/prompt tokens in this model's 8192-token context.
    "granite_docling": Model("ibm-granite/granite-docling-258M", context=8192, max_new_tokens=6144,
                             params={"skip_special_tokens": False}, spec=VLM_CONVERT_GRANITE_DOCLING.model_spec),
    "nanonets_ocr2": Model("nanonets/Nanonets-OCR2-3B", spec=VLM_CONVERT_NANONETS_OCR2.model_spec),
    "infinity_parser": Model(
        "infly/Infinity-Parser2-Flash",
        params={"chat_template_kwargs": {"enable_thinking": False}, "top_p": 1.0},
        spec=VlmModelSpec(
            name="Infinity-Parser2-Flash", default_repo_id="infly/Infinity-Parser2-Flash",
            prompt=INFINITY_PROMPT, response_format=ResponseFormat.MARKDOWN, max_new_tokens=16384,
        ),
    ),
    # Render DPI follows Surya's own vLLM launcher default. Its 18,000-token context and 12,288
    # full-page output cap do not: the whole Beier spread needs 13,062 output tokens after 6,259
    # for image and prompt (measured at Surya's client-side image cap, so prefill cannot grow much),
    # and the overflow is lost silently (see transcription.surya). 24,576 = 16,384 output + 8,192 prefill.
    # The four decoding settings Surya would otherwise read from the environment, pinned so a run's recipe names
    # them: guided layout JSON, no full-page regeneration rounds, and the layout and block token ceilings (the
    # installed defaults).
    "surya": Model("datalab-to/surya-ocr-2", kind="surya", context=24576, max_new_tokens=16384, scale=192 / 72,
                   params={"SURYA_GUIDED_LAYOUT": True, "SURYA_FULLPAGE_REGEN": False,
                           "SURYA_MAX_TOKENS_LAYOUT": 3072, "SURYA_MAX_TOKENS_BLOCK_CEILING": 8192}),
}

# The OCR model a new parse runs on when its owner chose none. M3 wires KEI_OCR_MODEL through Compose and makes
# `convert` resolve an omitted choice from this same value; until then Studio's KEI_EXP_MODEL (also surya) is sent.
DEFAULT_OCR_MODEL = os.environ.get("KEI_OCR_MODEL", "surya")
if DEFAULT_OCR_MODEL not in MODELS:
    raise ValueError(f"KEI_OCR_MODEL names no known OCR model: {DEFAULT_OCR_MODEL!r}")

"""OCR model records shared by the API and worker, without Docling imports."""
import os
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Model:
    repo: str                          # vLLM model id
    kind: str = "vlm"                  # the transcriber that runs it: vlm (Docling's VLM pipeline) or surya
    context: int = 32768               # vLLM --max-model-len
    max_new_tokens: int | None = None  # None = keep the spec's allowance
    params: dict = field(default_factory=dict)  # extra generation params: vLLM request fields for a vlm record,
                                                 # Surya settings assigned by transcription.surya.configure for surya
    spec_key: str | None = None        # key in transcription.specs.VLM_SPECS; vlm records need one
    scale: float = 3                   # render scale when there are no VLM options (Surya: 192 dpi)

    def __post_init__(self) -> None:
        if self.kind == "vlm" and self.spec_key is None:
            raise ValueError(f"{self.repo}: a vlm record needs a Docling model spec key")

    @property
    def vlm(self) -> bool:
        return self.kind == "vlm"


MODELS: dict[str, Model] = {
    # repetition_penalty prevents the whitespace loop reproduced on ordinary text pages.
    "granite_vision": Model("ibm-granite/granite-vision-4.1-4b", max_new_tokens=8192,
                            params={"repetition_penalty": 1.05}, spec_key="granite_vision"),
    # 6144 reserves room for image/prompt tokens in this model's 8192-token context.
    "granite_docling": Model("ibm-granite/granite-docling-258M", context=8192, max_new_tokens=6144,
                             params={"skip_special_tokens": False}, spec_key="granite_docling"),
    "nanonets_ocr2": Model("nanonets/Nanonets-OCR2-3B", spec_key="nanonets_ocr2"),
    "infinity_parser": Model(
        "infly/Infinity-Parser2-Flash",
        params={"chat_template_kwargs": {"enable_thinking": False}, "top_p": 1.0},
        spec_key="infinity_parser",
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

# The OCR model a new parse runs on when its owner chose none. Studio sends the owner's Ingestion Model Choice, frozen
# when the upload was admitted, in its `convert` handoff; `convert` resolves an omitted (null) choice from this value,
# which Compose sets from KEI_OCR_MODEL.
DEFAULT_OCR_MODEL = os.environ.get("KEI_OCR_MODEL", "surya")
if DEFAULT_OCR_MODEL not in MODELS:
    raise ValueError(f"KEI_OCR_MODEL names no known OCR model: {DEFAULT_OCR_MODEL!r}")

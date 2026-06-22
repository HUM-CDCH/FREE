"""Static few-shot examples for structured extraction requests.

Each example shows the model that _evidence snippets should be broader source
passages — containing the extracted value plus surrounding words — rather than
verbatim copies of the extracted field value.

The _evidence structure is intentionally flexible: the frontend collects
{snippet, page} leaves recursively regardless of nesting shape.
"""

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class FewShotExample:
    schema_json: str
    result_json: str


STRUCTURED_EXTRACTION_EXAMPLE = FewShotExample(
    schema_json="""{
    "site_id": "string",
    "finds": [
        {
            "type": "string",
            "description": "string"
        }
    ],
    "_evidence": {
        "site_id": {
            "snippet": "string",
            "page": "number"
        },
        "finds": [
            {
                "type": {
                    "snippet": "string",
                    "page": "number"
                },
                "description": {
                    "snippet": "string",
                    "page": "number"
                }
            }
        ]
    }
}""",
    result_json="""{
    "site_id": "Site 14B",
    "finds": [
        {
            "type": "ceramic",
            "description": "Fragment of wheel-thrown vessel"
        },
        {
            "type": "flint",
            "description": "Retouched blade with use-wear"
        }
    ],
    "_evidence": {
        "site_id": {
            "snippet": "Excavation unit designated Site 14B was opened in the northwest quadrant",
            "page": 1
        },
        "finds": [
            {
                "type": {
                    "snippet": "ceramic sherds recovered from layer 3, consistent with wheel-thrown production",
                    "page": 2
                },
                "description": {
                    "snippet": "a fragment of a wheel-thrown vessel with orange fabric and smoothed exterior",
                    "page": 2
                }
            },
            {
                "type": {
                    "snippet": "two flint artefacts were identified including a retouched blade",
                    "page": 2
                },
                "description": {
                    "snippet": "retouched blade measuring 4.2 cm with clear use-wear along the right edge",
                    "page": 2
                }
            }
        ]
    }
}""",
)

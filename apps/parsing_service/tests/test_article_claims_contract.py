"""A scripted Article extraction whose claims end in every verifier state, pinned for the TypeScript accounting.

The fixture is the artifact `run.dispatch` returns (records, evidence, ungrounded, issues, grounding_eligibility,
grounding) for: a currency the two contexts disagree on (contested: no claim is made of it), an item description
printed nowhere (unsupported), an item whose own fields cannot fit any request (not completed, refused per context),
and a `notes` field whose schema policy is `unverified` (excluded). `packages/extraction` derives the same dict
from the persisted evidence, ungrounded paths, issues and skipped paths; this file is the consistency rule.
"""
import json
import re
from pathlib import Path

from kei_exp.kie.extract import run
from kei_exp.kie.extract.schema import Schema
from tests.test_article_grounding_scale import SCHEMA, item
from tests.test_extract_grounded import CountingChat, WordCounter
from tests.test_extract_stages import evidence, passages

FIXTURE = Path(__file__).parent / "fixtures" / "contracts" / "article-claims.json"
KEYS = ("records", "evidence", "ungrounded", "unverified", "issues", "grounding", "grounding_eligibility", "options")


def quoting(system, user, reply_schema):
    """A careful quoted grounder: each claim gets the first offered evidence that prints its value, quoted verbatim."""
    claims = re.findall(r"^(C\d+) \([^\n]*\): ([^\n]+)$", user, re.MULTILINE)
    shown = re.findall(r"^(E\d+): ([^\n]+)$", user, re.MULTILINE)
    replies = {}
    for claim, value in claims:
        offered = reply_schema["properties"][claim]["properties"]["label"]["enum"]
        label = next((label for label, text in shown if value in text and label in offered), "NONE")
        replies[claim] = {"label": label, "quote": value if label != "NONE" else "", "attribution": label != "NONE"}
    return replies


def scripted_artifact() -> dict:
    nodes = SCHEMA.model_dump(by_alias=True, exclude_none=True)["schemaNodes"]
    nodes.append({"id": "x", "name": "notes", "type": "string", "evidencePolicy": "unverified"})
    schema = Schema.model_validate({"recordDescription": "One price list.", "schemaNodes": nodes})
    texts = ["Viega price list. Currency USD. Notes: see back. 77000 elbow 0 per 100 7.5" + " filler" * 2600,
             "Viega price list. Currency EUR. 77001 per 100 7.5. 77002 elbow 2 per 100 7.5" + " filler" * 2600]

    def script(system, user, reply_schema):
        if "items" in reply_schema["properties"]:
            first = "USD" in user
            return {"publisher": "Viega", "currency": "USD" if first else "EUR", "notes": "see back",
                    "items": [item(0)] if first else [item(1) | {"description": "not printed"},
                                                       item(2) | {"description": "elbow 2 " + "x " * 9000}]}
        return quoting(system, user, reply_schema)
    request = run.ExtractRequest.model_validate({"schema": {**schema.model_dump(by_alias=True, exclude_none=True),
        "recordScope": "document"}, "options": {"strategy": "article", "article": {"context": "bounded",
        "context_tokens": 8192, "evidence_policy": "schema", "grounding": "quoted"}}})
    return run.dispatch(None, evidence(passages(texts)), request, CountingChat(script),
                        counter={role: WordCounter() for role in ("fields", "reasoning")})


def test_the_pinned_artifact_holds_every_verifier_state_once_each_way():
    result = scripted_artifact()
    assert result["grounding"]["excluded"] >= 1 and result["grounding"]["unsupported"] >= 1
    assert result["grounding"]["not_completed"] >= 1 and result["grounding"]["supported"] >= 1
    pinned = {key: result[key] for key in KEYS}
    if not FIXTURE.exists():
        FIXTURE.write_text(json.dumps(pinned, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    assert json.loads(FIXTURE.read_text(encoding="utf-8")) == json.loads(json.dumps(pinned))

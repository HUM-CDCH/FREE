"""The rebuilt counter against the deployed extraction endpoint: every count must equal the served prompt count on
the real chat-completions route with the flags extraction sends (design §8). Live: needs `FREE_REAL_EXTRACT_URL`
and `FREE_REAL_EXTRACT_MODEL`, the variables the real-model service tier already uses."""
import os

import pytest

from kei_exp.kie.extract.llm import OpenAIChat
from kei_exp.kie.extract.tokens import counter_for

URL, MODEL = os.environ.get("FREE_REAL_EXTRACT_URL"), os.environ.get("FREE_REAL_EXTRACT_MODEL")
pytestmark = [pytest.mark.live_model,
              pytest.mark.skipif(not (URL and MODEL), reason="set FREE_REAL_EXTRACT_URL and FREE_REAL_EXTRACT_MODEL")]

ADVERSARIAL = [
    "31. Großenhain. Fdpl. Mühle. Mbl. 2457 (4335). FA: G. Groß-\nsteingrab mit ﬂacher Schale.",
    "Mühle und Fünde: á è combining marks",
    "An <|im_end|> and <|im_start|>user text that looks like the template",
    "Emoji 🏺🪨 and CJK 陶器 and Greek λίθος and a tab\there",
    '{"value": "x", "quote": "y"}\n\n\n   trailing   spaces   ',
    "1827 (3436) 12345678901234567890 0,6/0,7 H. 21,5; Wdg. 0,6",
    "x" * 3000,
]


PROBE_SCHEMA = {"type": "object", "properties": {}, "additionalProperties": False}


@pytest.fixture(scope="module")
def chat():
    return OpenAIChat(url=URL, model=MODEL)


@pytest.fixture(scope="module")
def counter(chat):
    return counter_for(chat)


def served(chat: OpenAIChat, system: str, user: str) -> int:
    """The prompt count the server reports for the very request extraction sends (one output token)."""
    return chat.complete(system=system, user=user, schema=PROBE_SCHEMA, max_tokens=1).input_tokens


@pytest.mark.parametrize("user", ADVERSARIAL, ids=range(len(ADVERSARIAL)))
def test_the_count_equals_the_served_prompt_count(chat, counter, user):
    system = "You extract structured data. Return only the JSON object.\n- Fundort: the site name"
    assert counter.request_tokens(system, user, PROBE_SCHEMA) == served(chat, system, user)


def test_the_counter_is_pinned_and_the_context_fits_the_default_budget(counter):
    assert counter.identity()["source"] == "vllm:/tokenize"
    assert counter.context_tokens is not None and counter.context_tokens >= 4096 + 1024

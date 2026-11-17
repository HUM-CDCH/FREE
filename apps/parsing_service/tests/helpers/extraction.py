"""Scripted, counted model replies shared by Article and Catalog tests."""
from kei_exp.kie.extract.llm import Reply
from tests.helpers.chat import FakeChat

class WordCounter:
    """Counts words plus a fixed template overhead: a stand-in with the served counter's interface."""
    template_tokens = 5
    context_tokens = 16_384

    def __init__(self):
        self.counted: list[int] = []
        self.schemas: list[dict | None] = []

    def request_tokens(self, system: str, user: str, schema: dict | None = None) -> int:
        count = len(system.split()) + len(user.split()) + self.template_tokens
        self.counted.append(count)
        self.schemas.append(schema)
        return count

    def identity(self) -> dict:
        return {"source": "words", "model": "fake/extractor", "model_digest": "w" * 64, "template_tokens": 5}


class CountingChat(FakeChat):
    """Reports the served input count an honest server would: the same words-plus-template the counter counts."""
    def complete(self, *, system, user, schema, max_tokens=None):
        reply = super().complete(system=system, user=user, schema=schema, max_tokens=max_tokens)
        if reply.input_tokens == 10:  # FakeChat's placeholder, not a scripted Reply
            reply = Reply(reply.text, len(system.split()) + len(user.split()) + WordCounter.template_tokens,
                          reply.output_tokens, reply.finish, reply.seconds)
        return reply


def resolving(user: str) -> bool:
    """An Article resolution call (`resolution.resolve`)."""
    return user.startswith("### Document opening\n") and "\n### Places\n" in user


def keeps_every_reading(schema: dict) -> dict:
    """A resolution answer that settles nothing away: each place's first candidate, every list item its own."""
    return {key: {label: {"of": "", "label": "OWN"} for label in spec["properties"]} if "properties" in spec
            else spec["enum"][0] for key, spec in schema["properties"].items()}


SCHEMA = {"recordDescription": "One numbered entry of an archaeological catalogue.", "schemaNodes": [
    {"id": "n", "name": "entry_no", "type": "integer"},
    {"id": "s", "name": "site_name", "type": "string", "description": "the find place after the number"},
    {"id": "b", "name": "bezirk", "type": "string"},
    {"id": "k", "name": "kreis", "type": "string"},
    {"id": "m", "name": "mbl_old", "type": "integer", "description": "map sheet number after Mbl."},
    {"id": "f", "name": "fundart", "type": "string", "description": "find category after FA:"},
]}

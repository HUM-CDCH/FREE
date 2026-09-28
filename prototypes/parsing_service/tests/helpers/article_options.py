"""The shared Article-method fixture (`tests/fixtures/contracts/article-options.json`) as this service decides it.

Studio's `packages/extraction/src/extraction-method.test.ts` enumerates the same categorical inventory from the
fixture's own factor lists and must reach the same verdicts, so TS/Python parity is a test on both sides. After an
intended `ArticleOptions` change, regenerate from `prototypes/parsing_service`:
`PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src:. .venv/bin/python -m tests.helpers.article_options --write`
"""
from __future__ import annotations

import itertools
import json
import sys
from collections.abc import Iterator

from pydantic import ValidationError

from kei_exp.kie.extract.method import ArticleOptions
from tests.helpers.contracts import FIXTURES

PATH = FIXTURES / "article-options.json"


def inputs(inventory: dict) -> Iterator[dict]:
    factors = inventory["factors"]
    names = list(factors)
    for values in itertools.product(*(factors[name] for name in names)):
        chosen = dict(zip(names, values))
        yield {**{name: value for name, value in chosen.items() if value is not None},
               "context_tokens": inventory["context_tokens"],
               "identity_fields": inventory["identity_fields"] if chosen["identity"] == "conservative" else []}


def accepted(value: dict) -> bool:
    try:
        ArticleOptions.model_validate(value)
    except ValidationError:
        return False
    return True


def verdicts(inventory: dict) -> str:
    return "".join("1" if accepted(value) else "0" for value in inputs(inventory))


def regenerated(fixture: dict) -> dict:
    cases = []
    for case in fixture["cases"]:
        kept = {key: case[key] for key in ("id", "input", "accepted")}
        if accepted(case["input"]):
            kept["canonical"] = ArticleOptions.model_validate(case["input"]).model_dump(mode="json")
        cases.append(kept)
    vector = verdicts(fixture["inventory"])
    inventory = {**fixture["inventory"], "accepted": vector.count("1"), "rejected": vector.count("0"),
                 "verdicts": vector}
    return {**fixture, "cases": cases, "inventory": inventory}


if __name__ == "__main__":
    current = json.loads(PATH.read_text(encoding="utf-8"))
    if sys.argv[1:] != ["--write"]:
        sys.exit("usage: python -m tests.helpers.article_options --write")
    PATH.write_text(json.dumps(regenerated(current), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

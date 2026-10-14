"""One paper, one condition: Article parts read once, assembly alone and resolution captured from the same readings.

Run inside the parsing worker image with the e4516d3c source on the path:
    python run_paper.py CONDITION SOURCE_DIR OUTPUT.json
CONDITION is N (fields NuExtract, reasoning Qwen) or Q (both Qwen). SOURCE_DIR holds the canonical `result/`.
"""
from __future__ import annotations

import json
import sys
import time
from copy import deepcopy
from dataclasses import asdict
from pathlib import Path

from kei_exp.kie.extract import article, resolution
from kei_exp.kie.extract.method import ArticleOptions, LimitedCounter
from kei_exp.kie.extract.models import EXTRACT_MODELS, Router
from kei_exp.kie.extract.schema import Schema, conform
from kei_exp.kie.extract.tokens import counters_for
from kei_exp.kie.passages import load

ROUTES = {"N": {"fields": "nuextract", "reasoning": "instruct"}, "Q": {"fields": "instruct", "reasoning": "instruct"}}
SCHEMA = json.loads((Path(__file__).parent / "schema.json").read_text())


def keyed(sources: dict) -> list:
    return [[list(key), value] for key, value in sources.items()]


def main(condition: str, source: Path, output: Path) -> None:
    started = time.time()
    schema = Schema.model_validate(SCHEMA)
    method = ArticleOptions(context="bounded", context_tokens=12288)
    keys = ROUTES[condition]
    clients = {key: EXTRACT_MODELS[key].chat() for key in set(keys.values())}
    router = Router(fields=clients[keys["fields"]], reasoning=clients[keys["reasoning"]])
    counters = {role: LimitedCounter(each, method.context_tokens) for role, each in counters_for(router).items()}
    captured: dict = {}
    prompts: list[dict] = []
    original_resolve, original_complete = article.resolve, resolution.complete

    def wrapped_resolve(readings, groups, root, contested, repeats, joined, schema_, chat, counter, *, item_sources):
        captured["assembly"] = deepcopy({"root": root, "contested": contested, "repeats": repeats, "joined": joined,
                                         "item_sources": keyed(item_sources)})
        result = original_resolve(readings, groups, deepcopy(root), deepcopy(contested), deepcopy(repeats),
                                  deepcopy(joined), schema_, chat, counter, item_sources=item_sources)
        root2, contested2, repeats2, joined2, calls2, issues2 = result
        captured["resolution"] = deepcopy({"root": root2, "contested": contested2, "repeats": repeats2,
                                           "joined": joined2, "item_sources": keyed(item_sources),
                                           "calls": [asdict(call) for call in calls2],
                                           "issues": [asdict(issue) for issue in issues2]})
        return result

    def wrapped_complete(chat, **kwargs):
        answer, attempts = original_complete(chat, **kwargs)
        prompts.append({"system": kwargs["system"], "user": kwargs["user"], "schema": kwargs["schema"],
                        "answer": answer, "calls": [asdict(call) for call in attempts]})
        return answer, attempts

    article.resolve, resolution.complete = wrapped_resolve, wrapped_complete
    evidence = load(source)
    readings: list = []
    original_extract = article.extract_record

    def wrapped_extract(*args, **kwargs):
        fields, attempts, problems = original_extract(*args, **kwargs)
        readings.append({"passages": [p.id for p in args[0]], "pages": sorted({p.page for p in args[0]}),
                         "fields": deepcopy(fields), "calls": [asdict(call) for call in attempts],
                         "issues": [asdict(issue) for issue in problems]})
        return fields, attempts, problems

    article.extract_record = wrapped_extract
    try:
        records = article.document_root(evidence.passages, schema, router, counters=counters,
                                        record_chars=1_000_000, method=method)
    finally:
        article.resolve, resolution.complete, article.extract_record = (original_resolve, original_complete,
                                                                        original_extract)
    nodes = schema.record_nodes
    final_root = records.slices[0][1]
    result = {
        "condition": condition, "routes": {role: EXTRACT_MODELS[key].repo for role, key in keys.items()},
        "source": source.name, "source_name": evidence.source_name, "generation": evidence.generation,
        "digest": evidence.digest, "method": method.model_dump(mode="json"),
        "context_tokens": {role: each.context_tokens for role, each in counters.items()},
        "parts": [group.dumped() | {"pages": sorted({p.page for p in group.passages})}
                  for group in records.value_contexts[0]],
        "readings": readings,
        "resolved_called": "assembly" in captured,
        "assembly_alone": conform(deepcopy(captured["assembly"]["root"]), nodes) if "assembly" in captured else None,
        "resolved": conform(deepcopy(captured["resolution"]["root"]), nodes) if "resolution" in captured else None,
        "final_root": final_root,
        "capture": captured, "resolution_prompts": prompts,
        "calls": [asdict(call) for call in records.calls], "issues": [asdict(issue) for issue in records.issues],
        "seconds": round(time.time() - started, 1),
    }
    output.write_text(json.dumps(result, ensure_ascii=False, indent=1, default=str))
    print(json.dumps({"source": source.name, "condition": condition, "parts": len(result["parts"]),
                      "resolved_called": result["resolved_called"], "calls": len(result["calls"]),
                      "failed": sum(not c["ok"] for c in result["calls"]), "seconds": result["seconds"]}))


if __name__ == "__main__":
    main(sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3]))

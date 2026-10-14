"""One document, one condition: parts read once; assembly, the fix's resolution and the baseline's from those readings.

Run inside the parsing worker image with the fix's source (`1181e93e`) on the path:
    python run_paired.py CONDITION SCHEMA.json SOURCE_DIR OUTPUT.json
CONDITION is N (fields NuExtract, reasoning Qwen) or Q (both Qwen). SOURCE_DIR holds the canonical `result/`.

The fix's `resolution.resolve` runs live and drives the rest of the run. The baseline (`resolution_b.py`, the accepted
`dev` resolver, blob 5a284de0) then resolves the same assembled input: a request byte-identical to one the fix sent
reuses the fix's reply (`reused`); any other request is sent live. So where both send the same requests, every
difference between the two results is the decision rule's; where they differ (a list too long for one 60-item part),
the requests themselves show it. The capture layout of the PR #267 comparison is kept (`resolution` is the fix), so
its `score.py` scores the fix unchanged; `baseline` holds the same fields for the baseline.
"""
from __future__ import annotations

import json
import sys
import time
from copy import deepcopy
from dataclasses import asdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import resolution_b  # noqa: E402
from kei_exp.kie.extract import article, resolution  # noqa: E402
from kei_exp.kie.extract.method import ArticleOptions, LimitedCounter  # noqa: E402
from kei_exp.kie.extract.models import EXTRACT_MODELS, Router  # noqa: E402
from kei_exp.kie.extract.schema import Schema, conform  # noqa: E402
from kei_exp.kie.extract.tokens import counters_for  # noqa: E402
from kei_exp.kie.passages import load  # noqa: E402

ROUTES = {"N": {"fields": "nuextract", "reasoning": "instruct"}, "Q": {"fields": "instruct", "reasoning": "instruct"}}


def keyed(sources: dict) -> list:
    return [[list(key), value] for key, value in sources.items()]


def request_key(kwargs: dict) -> str:
    return json.dumps([kwargs["system"], kwargs["user"], kwargs["schema"]], ensure_ascii=False)


def main(condition: str, schema_path: Path, source: Path, output: Path) -> None:
    started = time.time()
    schema = Schema.model_validate(json.loads(schema_path.read_text()))
    method = ArticleOptions(context="bounded", context_tokens=12288)
    keys = ROUTES[condition]
    clients = {key: EXTRACT_MODELS[key].chat() for key in set(keys.values())}
    router = Router(fields=clients[keys["fields"]], reasoning=clients[keys["reasoning"]])
    counters = {role: LimitedCounter(each, method.context_tokens) for role, each in counters_for(router).items()}
    captured: dict = {}
    prompts: list[dict] = []
    baseline_prompts: list[dict] = []
    replies: dict[str, tuple] = {}
    original_resolve, original_complete = article.resolve, resolution.complete
    baseline_complete = resolution_b.complete

    def fix_complete(chat, **kwargs):
        answer, attempts = original_complete(chat, **kwargs)
        replies[request_key(kwargs)] = (deepcopy(answer), deepcopy(attempts))
        prompts.append({"system": kwargs["system"], "user": kwargs["user"], "schema": kwargs["schema"],
                        "answer": answer, "calls": [asdict(call) for call in attempts]})
        return answer, attempts

    def paired_complete(chat, **kwargs):
        key = request_key(kwargs)
        reused = key in replies
        answer, attempts = deepcopy(replies[key]) if reused else baseline_complete(chat, **kwargs)
        baseline_prompts.append({"system": kwargs["system"], "user": kwargs["user"], "schema": kwargs["schema"],
                                 "answer": answer, "calls": [asdict(call) for call in attempts], "reused": reused})
        return answer, attempts

    def wrapped_resolve(readings, groups, root, contested, repeats, joined, schema_, chat, counter, *, item_sources):
        before = deepcopy(item_sources)
        captured["assembly"] = deepcopy({"root": root, "contested": contested, "repeats": repeats, "joined": joined,
                                         "item_sources": keyed(item_sources)})
        result = original_resolve(readings, groups, deepcopy(root), deepcopy(contested), deepcopy(repeats),
                                  deepcopy(joined), schema_, chat, counter, item_sources=item_sources)
        root2, contested2, repeats2, joined2, calls2, issues2 = result
        captured["resolution"] = deepcopy({"root": root2, "contested": contested2, "repeats": repeats2,
                                           "joined": joined2, "item_sources": keyed(item_sources),
                                           "calls": [asdict(call) for call in calls2],
                                           "issues": [asdict(issue) for issue in issues2]})
        sources_b = deepcopy(before)
        try:
            root3, contested3, repeats3, joined3, calls3, issues3 = resolution_b.resolve(
                readings, groups, deepcopy(captured["assembly"]["root"]), deepcopy(contested), deepcopy(repeats),
                deepcopy(joined), schema_, chat, counter, item_sources=sources_b)
            captured["baseline"] = deepcopy({"root": root3, "contested": contested3, "repeats": repeats3,
                                             "joined": joined3, "item_sources": keyed(sources_b),
                                             "calls": [asdict(call) for call in calls3],
                                             "issues": [asdict(issue) for issue in issues3]})
        except Exception as error:  # the baseline never changes the run; its failure is recorded
            captured["baseline"] = {"error": f"{type(error).__name__}: {error}"}
        return result

    article.resolve, resolution.complete, resolution_b.complete = wrapped_resolve, fix_complete, paired_complete
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
        resolution_b.complete = baseline_complete
    nodes = schema.record_nodes
    final_root = records.slices[0][1]
    called = "assembly" in captured
    result = {
        "condition": condition, "routes": {role: EXTRACT_MODELS[key].repo for role, key in keys.items()},
        "schema": schema_path.name,
        "source": source.name, "source_name": evidence.source_name, "generation": evidence.generation,
        "digest": evidence.digest, "method": method.model_dump(mode="json"),
        "context_tokens": {role: each.context_tokens for role, each in counters.items()},
        "parts": [group.dumped() | {"pages": sorted({p.page for p in group.passages})}
                  for group in records.value_contexts[0]],
        "readings": readings,
        "resolved_called": called,
        "assembly_alone": conform(deepcopy(captured["assembly"]["root"]), nodes) if called else None,
        "resolved": conform(deepcopy(captured["resolution"]["root"]), nodes) if called else None,
        "baseline_resolved": (conform(deepcopy(captured["baseline"]["root"]), nodes)
                              if called and "root" in captured.get("baseline", {}) else None),
        "final_root": final_root,
        "capture": captured, "resolution_prompts": prompts, "baseline_prompts": baseline_prompts,
        "calls": [asdict(call) for call in records.calls], "issues": [asdict(issue) for issue in records.issues],
        "seconds": round(time.time() - started, 1),
    }
    output.write_text(json.dumps(result, ensure_ascii=False, indent=1, default=str))
    print(json.dumps({"source": source.name, "condition": condition, "parts": len(result["parts"]),
                      "resolved_called": called, "calls": len(result["calls"]),
                      "failed": sum(not c["ok"] for c in result["calls"]),
                      "fix_requests": len(prompts), "baseline_requests": len(baseline_prompts),
                      "baseline_reused": sum(p["reused"] for p in baseline_prompts),
                      "baseline_error": captured.get("baseline", {}).get("error"), "seconds": result["seconds"]}))


if __name__ == "__main__":
    main(sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4]))

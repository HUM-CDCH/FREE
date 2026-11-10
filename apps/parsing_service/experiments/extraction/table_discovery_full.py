"""Validate a full, versioned extraction over an existing immutable canonical generation.

  python -m experiments.extraction.table_discovery_full REQUEST.json OUTPUT --ssh-host HOST \
      --model-container fields=FIELDS_CONTAINER --model-container reasoning=REASONING_CONTAINER --reference GOLD.json

REQUEST names runId, generation and the actual {schema, options} request. GOLD owns complete expected entries
(id, ranges, end, parent where applicable) and field records. No prompt constant is patched. Run a candidate
worker image to validate its implementation; historical method versions keep their own prompts.

The runner captures final HTTP attempts without headers or credential URLs, loaded application source hashes,
worker/model image ids and the served model revisions. Unavailable serving metadata is reported explicitly;
greedy execution is not a promise of byte-identical future output.
No result is published to product state.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
from importlib.metadata import distributions
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import threading
import time
import unicodedata
from urllib.parse import urlsplit
from unittest.mock import patch


def container_identity(host, container):
    """Keep the immutable image id, without reading credentials or environment dumps."""
    inspect = shlex.join(["docker", "inspect", "--format", "{{json .Image}}", container])
    return {"image": json.loads(subprocess.check_output(["ssh", "-o", "BatchMode=yes", host, inspect], text=True))}


@contextmanager
def capture_http(clients, emit):
    """Observe actual HTTP attempts after adapter/template construction; never retain headers or credential URLs."""
    import requests
    endpoints = {}
    for role, client in clients.chats().items():
        parsed = urlsplit(client.url)
        endpoints.setdefault((parsed.netloc, parsed.path), []).append(role)
    send = requests.Session.send

    def observed(session, request, **kwargs):
        endpoint = urlsplit(request.url)
        roles = endpoints.get((endpoint.netloc, endpoint.path))
        if roles is None:
            return send(session, request, **kwargs)
        started = time.monotonic()
        item = {"roles": roles, "request": json.loads(request.body), "path": endpoint.path}
        try:
            response = send(session, request, **kwargs)
            item["status"] = response.status_code
            # Error bodies can echo credentials. Their status is sufficient to identify a retry or format fallback.
            if response.ok:
                item["response"] = response.json()
            return response
        except Exception as error:
            item["error"] = type(error).__name__
            raise
        finally:
            item["seconds"] = round(time.monotonic() - started, 3)
            emit({"capture": item})

    with patch.object(requests.Session, "send", observed):
        yield


def assess_records(result, reference):
    """Score fields only after the same complete ownership check the discovery experiment uses."""
    from experiments.extraction.table_discovery import score
    discovery = result["discovery"]
    structure = score(discovery["entries"], reference["entries"],
                      [i["code"] for i in discovery["issues"]], discovery["ledger"])
    verdict = {"records": len(result["records"]), "expected": len(reference["records"]),
               "structure": structure}
    if not structure["pass"]:
        return {**verdict, "field_result": None}
    if len(result["records"]) != len(reference["records"]):
        raise ValueError("record count differs from aligned discovery entries")
    def normalized(value):
        return " ".join(unicodedata.normalize("NFKC", value).casefold().split()) if isinstance(value, str) else value
    errors = []
    for number, (expected, actual) in enumerate(zip(reference["records"], result["records"], strict=True), 1):
        fields = {key: {"expected": value, "actual": actual.get(key)} for key, value in expected.items()
                  if normalized(value) != normalized(actual.get(key))}
        if fields:
            errors.append({"row": number, "fields": fields})
    return {**verdict, "field_result": {"rows_correct": len(reference["records"]) - len(errors),
            "cells_correct": sum(len(r) for r in reference["records"]) - sum(len(e["fields"]) for e in errors),
            "cells_total": sum(len(r) for r in reference["records"]), "errors": errors}}


def worker(payload):
    from kei_exp.kie.extract import models, run, unified
    from kei_exp.kie.passages import load

    config = payload["config"]
    directory = Path(os.environ["KEI_RUNS"]) / config["runId"]
    request = run.ExtractRequest.model_validate(config["request"])
    source = load(directory)
    if source.generation != config["generation"]:
        raise ValueError("canonical generation differs from the original extraction")
    def canonical_hashes():
        return {str(p.relative_to(directory)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in sorted((directory / "result").rglob("*.json"))}
    before = canonical_hashes()
    lock = threading.Lock()
    def emit(item):
        with lock:
            print(json.dumps(item, ensure_ascii=False), flush=True)
    clients = models.chats_for(request.options)
    import requests
    servers = {}
    for role, client in clients.chats().items():
        try:
            response = requests.get(client.url.split('/v1/', 1)[0] + '/server_info',
                params={"config_format": "json"}, headers=client.headers, timeout=30)
            response.raise_for_status()
            config_ = response.json()["vllm_config"]["model_config"]
            servers[role] = {key: config_.get(key) for key in (
                "model", "revision", "tokenizer", "tokenizer_revision", "dtype", "quantization", "max_model_len")}
            hf = config_.get("hf_config")
            servers[role]["model_commit"] = hf.get("_commit_hash") if isinstance(hf, dict) else None
        except (requests.RequestException, KeyError, TypeError) as error:
            servers[role] = {"unavailable": type(error).__name__}
    runtime = {**payload["runtime"], "servers": servers, "python": sys.version,
               "packages": dict(sorted((d.metadata['Name'], d.version) for d in distributions()))}
    print(json.dumps({"protocol": {"experimental": True, "config": config, "models": clients.models,
          "runtime": runtime,
          "chunks": 4, "canonical_hashes": before,
          "canonical_tables": [{"segment": p.id, "cells": len(p.table.cells)} for p in source.passages if p.table],
          "base_unified_sha256": hashlib.sha256(Path(unified.__file__).read_bytes()).hexdigest()}}), flush=True)
    started = time.monotonic()
    with capture_http(clients, emit):
        result = run.extract(directory, request, clients, generation=config["generation"], chunks=4)
    after = canonical_hashes()
    if before != after:
        raise RuntimeError("canonical files changed during the experiment")
    source_hashes = {name: hashlib.sha256(Path(m.__file__).read_bytes()).hexdigest()
                     for name, m in sys.modules.items() if name.startswith("kei_exp.") and
                     getattr(m, "__file__", None) and Path(m.__file__).is_file()}
    print(json.dumps({"result": result, "runtime_source_hashes": source_hashes,
                      "seconds": round(time.monotonic() - started, 3),
                      "canonical_unchanged": True, "experimental": True}, ensure_ascii=False), flush=True)


def main():
    if sys.argv[1:] == ["--worker"]:
        worker(json.load(sys.stdin))
        return
    from experiments.extraction.table_discovery import remote  # host side: the container has no experiments package
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("request", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--ssh-host", required=True)
    parser.add_argument("--model-container", action="append", required=True, metavar="ROLE=CONTAINER")
    parser.add_argument("--reference", type=Path, help="PDF-annotated field reference with canonical starts")
    parser.add_argument("--container", default="free-parsing_worker-1")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    source = Path(__file__).read_text()
    (args.output / "runner.py").write_text(source)
    containers = dict(item.split("=", 1) for item in args.model_container)
    if set(containers) != {"fields", "reasoning"}:
        parser.error("provide the fields and reasoning model containers")
    runtime = {}
    for role, container in {"worker": args.container, **containers}.items():
        runtime[role] = container_identity(args.ssh_host, container)
    final = False
    with (args.output / "captures.jsonl").open("w") as captures:
        payload = {"config": json.loads(args.request.read_text()), "runtime": runtime}
        for item in remote(args.ssh_host, args.container, source, payload):
            if "capture" in item:
                captures.write(json.dumps(item, ensure_ascii=False) + "\n")
                captures.flush()
                c = item["capture"]
                print(json.dumps({"roles": c["roles"], "status": c.get("status"), "seconds": c["seconds"]}), flush=True)
            elif "protocol" in item:
                item["protocol"]["runner_sha256"] = hashlib.sha256(source.encode()).hexdigest()
                (args.output / "protocol.json").write_text(json.dumps(item["protocol"], indent=2))
            else:
                result = args.output / "result.json"
                result.write_text(json.dumps(item, ensure_ascii=False, indent=2))  # before scoring can fail
                final = True
                print(json.dumps({"records": len(item["result"]["records"]), "seconds": item["seconds"],
                                  "canonical_unchanged": item["canonical_unchanged"]}), flush=True)
                if args.reference:
                    item["assessment"] = assess_records(item["result"], json.loads(args.reference.read_text()))
                    result.write_text(json.dumps(item, ensure_ascii=False, indent=2))
    if not final:
        raise RuntimeError("full extraction failed; partial evidence retained")

if __name__ == "__main__":
    main()

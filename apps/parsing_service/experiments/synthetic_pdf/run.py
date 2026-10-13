"""Frozen inputs, production parsing/extraction, exact captures and HTTP-free replay."""
from __future__ import annotations

import importlib.metadata
import json
import os
import platform
import random
import shutil
import sys
import time
import traceback
from contextlib import contextmanager
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import requests

from experiments.extraction.manifest import digest, read, write_new
from experiments.extraction.replay_reference import Captured, key, stable
from experiments.extraction.study import Capture
from kei_exp.kie.extract.llm import OpenAIChat
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.run import ExtractRequest, extract
from kei_exp.kie.extract.tokens import TokenCounter, counter_for
from kei_exp.kie.passages import load

from .evaluate import controls, evaluate, inference_cost
from .generate import generate, identifier, schemas, validate_truth

SERVICE = Path(__file__).resolve().parents[2]
PACKAGES = ("reportlab", "pypdfium2", "docling", "docling-core", "pillow", "jsonschema", "torch")


def code_files() -> dict:
    paths = [p for base in (SERVICE / "src", SERVICE / "experiments/extraction", Path(__file__).parent)
             for p in base.rglob("*") if p.suffix in {".py", ".json", ".yaml"}]
    paths += [SERVICE / "pyproject.toml", SERVICE / "uv.lock"]
    return {str(p.relative_to(SERVICE)): digest(p.read_bytes()) for p in sorted(paths)}


def seal(root: Path, paths) -> dict:
    return {str(p.relative_to(root)): digest(p.read_bytes()) for p in sorted(paths)}


def checked(root: Path, pins: dict):
    for name, sha256 in pins.items():
        if digest(root.joinpath(name).read_bytes()) != sha256:
            raise ValueError(f"changed pinned artifact: {name}")


def validate_config(config: dict):
    if set(config) - {"seed", "documents", "providers", "methods", "repeats", "parsing"}:
        raise ValueError("unknown experiment settings")
    for section in ("documents", "providers", "methods"):
        if not config.get(section):
            raise ValueError(f"configuration requires {section}")
        ids = [identifier(item["id"]) for item in config[section]]
        if len(ids) != len(set(ids)):
            raise ValueError(f"duplicate IDs in {section}")
    if type(config.get("repeats", 1)) is not int or config.get("repeats", 1) < 1:
        raise ValueError("repeats must be a positive integer")
    if type(config["seed"]) is not int:
        raise ValueError("experiment seed must be an integer")
    cell_ids = [cell["id"] for cell in cells(config)]
    if len(cell_ids) != len(set(cell_ids)):
        raise ValueError("duplicate cell IDs; choose unambiguous document/provider/method IDs")
    # Validate method/scope pairings before either parsing or inference.
    for method in config["methods"]:
        strategy = method["options"]["strategy"]
        ExtractRequest.model_validate({"schema": schemas()[strategy], "options": method["options"]})


def create(config_path: Path, root: Path):
    config = read(config_path)
    validate_config(config)
    root.mkdir(parents=True, exist_ok=False)
    write_new(root / "config.json", config)
    for spec in config["documents"]:
        generate(spec, root / "documents" / spec["id"])
        print(f"generated {spec['id']}", flush=True)
    code = code_files()
    for name in code:
        archived = root / "source-code" / name
        archived.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(SERVICE / name, archived)
    versions = {name: importlib.metadata.version(name) for name in PACKAGES}
    write_new(root / "inputs.json", {"version": 1, "code": code, "python": sys.version,
                                    "platform": platform.platform(), "packages": versions,
                                    "files": seal(root, [p for p in root.rglob("*") if p.is_file()])})


def check_inputs(root: Path) -> dict:
    inputs = read(root / "inputs.json")
    checked(root, inputs["files"])
    if code_files() != inputs["code"]:
        raise ValueError("code changed since generation; generate a new dataset revision")
    if {name: importlib.metadata.version(name) for name in PACKAGES} != inputs["packages"]:
        raise ValueError("benchmark dependency versions changed since generation")
    config = read(root / "config.json")
    validate_config(config)
    for spec in config["documents"]:
        directory = root / "documents" / spec["id"]
        truth = read(directory / "truth.json")
        if digest((directory / "source.pdf").read_bytes()) != truth["pdf_sha256"]:
            raise ValueError("PDF differs from ground truth")
        validate_truth(truth, directory / "source.native.pdf")
    return config


def parse(root: Path):
    from kei_exp.kie.runner import convert
    from kei_exp.kie.stages.ocr import resolve
    from kei_exp.transcription.types import RunParams

    config = check_inputs(root)
    if (root / "parses.json").exists():
        checked(root, read(root / "parses.json")["files"])
        return
    settings = config.get("parsing", {})
    for spec in config["documents"]:
        directory = root / "documents" / spec["id"]
        run = directory / "parse"
        if (run / "result/result.json").exists():
            raise ValueError("unsealed parse exists; retain it and generate a new dataset revision")
        run.mkdir()
        params = RunParams(pdf=directory / "source.pdf", result_dir=run / "result", debug_dir=run / "debug",
                           cut="none", model=settings.get("model", "granite_vision"),
                           url=os.environ[settings["url_env"]] if "url_env" in settings else "http://127.0.0.1:8000")
        execution = resolve(params)
        clock = time.monotonic()
        with (run / "events.jsonl").open("x") as events:
            def emit(event):
                events.write(json.dumps(event) + "\n")
                events.flush()
            convert(execution, emit)
        evidence = load(run)
        write_new(run / "parsing.json", {"transcriber": execution.transcriber, "model": execution.repo,
                                         "pages": evidence.page_count, "passages": len(evidence.passages),
                                         "generation": evidence.generation, "digest": evidence.digest,
                                         "wall_seconds": time.monotonic() - clock})
        print(f"parsed {spec['id']}: {evidence.page_count} pages, {len(evidence.passages)} passages", flush=True)
    write_new(root / "parses.json", {"files": seal(root, [p for p in root.joinpath("documents").rglob("*")
                                                        if p.is_file() and "/parse/" in p.as_posix()])})


@contextmanager
def capture_calls(chats: dict, captures: dict, directory: Path, *, offline=False):
    # Production only permits whitespace recovery on exact OpenAIChat instances. Observe the method for this
    # sequential run without changing those instances; dataclasses.replace preserves each role's headers object.
    roles = {id(chat.headers): role for role, chat in chats.items()}
    if len(roles) != len(chats):
        raise ValueError("capture roles require distinct headers dictionaries")
    original = OpenAIChat.complete

    def complete(client, **request):
        role = roles[id(client.headers)]
        capture = captures[role]
        prefix = directory / f"{role}-{capture.index + 1:04}"
        payload_path = prefix.with_suffix(".payload.json")
        payload = client.request_body(**request)
        if offline:
            if read(payload_path) != payload:
                raise ValueError("HTTP request body changed during replay")
        else:
            write_new(payload_path, payload)
            capture.chat = SimpleNamespace(complete=lambda **kwargs: original(client, **kwargs))
        reply = capture.complete(**request)
        return replace(reply, attempts=tuple(reply.attempts))  # JSON replay restores arrays as lists.

    with patch.object(OpenAIChat, "complete", complete):
        yield


class Probes(TokenCounter):
    def __init__(self, directory: Path, live=None, *, identity=None, context=None):
        identity = live.identity() if live else identity
        super().__init__(identity["source"], identity["model"], live.context_tokens if live else context)
        self.live, self.directory, self._identity = live, directory, identity

    def identity(self):
        return self._identity

    def request_tokens(self, system, user, schema=None):
        request = {"system": system, "user": user, "schema": schema}
        path = self.directory / (digest(key(request).encode()) + ".json")
        if path.exists():
            probe = read(path)
            if probe["request"] != request or probe["identity"] != self.identity():
                raise ValueError("tokenizer probe changed")
            return probe["count"]
        if self.live is None:
            raise ValueError("missing tokenizer probe; offline replay refuses network")
        count = self.live.request_tokens(system, user, schema)
        write_new(path, {"request": request, "identity": self.identity(), "count": count})
        return count


def provider_settings(config: dict) -> dict:
    # Credentials stay in memory. Only the names of credential environment variables enter the configuration.
    provider = {**config, "base_url": os.environ[config["base_url_env"]].rstrip("/")}
    provider["model"] = os.environ[config["model_env"]] if "model_env" in config else config["model"]
    return provider


def cells(config: dict) -> list[dict]:
    result = [{"id": f"{doc['id']}--{provider['id']}--{method['id']}--{repeat}",
               "document": doc["id"], "provider": provider["id"], "method": method["id"], "repeat": repeat}
              for doc in config["documents"] for provider in config["providers"] for method in config["methods"]
              for repeat in range(config.get("repeats", 1))]
    random.Random(config["seed"]).shuffle(result)
    return result


def run(root: Path, output: Path):
    config = check_inputs(root)
    parse(root)
    output.mkdir(parents=True, exist_ok=False)
    providers = {p["id"]: provider_settings(p) for p in config["providers"]}
    registered = {"config": config, "providers": providers, "cells": cells(config), "code": code_files(),
                  "dataset": seal(root, [root / "inputs.json", root / "parses.json"])}
    write_new(output / "manifest.json", registered)
    failures = 0
    for cell in registered["cells"]:
        directory = output / "cells" / cell["id"]
        directory.mkdir(parents=True)
        source = root / "documents" / cell["document"]
        truth, evidence = read(source / "truth.json"), load(source / "parse")
        method = next(m for m in config["methods"] if m["id"] == cell["method"])
        strategy = method["options"]["strategy"]
        request = {"schema": truth["schemas"][strategy], "options": method["options"]}
        provider = providers[cell["provider"]]
        write_new(directory / "started.json", {"at": datetime.now(UTC).isoformat(), "cell": cell, "request": request,
                                               "provider": provider, "generation": evidence.generation})
        clock = time.monotonic()
        phase, metrics = "extraction", None
        print(f"running {cell['id']}", flush=True)
        try:
            headers = {"Authorization": "Bearer " + os.environ[provider["api_key_env"]]} if "api_key_env" in provider else {}
            response = requests.get(provider["base_url"] + "/v1/models", headers=headers, timeout=30)
            response.raise_for_status()
            served = next(m for m in response.json()["data"] if m["id"] == provider["model"])
            if served.get("max_model_len") != provider["context_tokens"]:
                raise ValueError("serving context differs from registered configuration")
            write_new(directory / "served.json", served)
            chats, counters, captures = {}, {}, {}
            for role in ("fields", "reasoning"):
                client = OpenAIChat(url=provider["base_url"] + "/v1/chat/completions", model=provider["model"],
                                    timeout=provider.get("timeout", 300), max_tokens=provider.get("max_tokens", 4096), headers=dict(headers))
                counter = counter_for(client)
                if counter.context_tokens != provider["context_tokens"]:
                    raise ValueError("tokenizer serving context differs from registration")
                captures[role] = Capture(client, directory / "calls", role)
                chats[role] = client
                counters[role] = Probes(directory / "tokens" / role, counter)
                write_new(directory / f"{role}-counter.json", {"identity": counter.identity(), "context": counter.context_tokens})
            with capture_calls(chats, captures, directory / "calls"):
                artifact = extract(source / "parse", ExtractRequest.model_validate(request), Router(**chats),
                                   counter=counters, generation=evidence.generation)
            write_new(directory / "artifact.json", artifact)
            phase = "scoring"
            write_new(directory / "cost.json", inference_cost(artifact))
            metrics = evaluate(truth, artifact, evidence)
            write_new(directory / "controls.json", controls(truth, artifact, evidence))
            status = "completed"
        except Exception as error:  # noqa: BLE001 -- Every failed experimental cell must receive a terminal receipt.
            failures += 1
            status = phase + "_failed"
            if phase == "extraction":
                metrics = evaluate(truth, {"strategy": strategy, "records": []}, evidence)
                metrics["cost"] = {"available": False,
                                   "captured_replies": len(list(directory.joinpath("calls").glob("*.reply.json")))}
            else:
                metrics = None  # Real predictions and cost survive; an evaluator crash is not zero accuracy.
            write_new(directory / "error.json", {"phase": phase, "type": type(error).__name__,
                                                 "message": str(error), "traceback": traceback.format_exc()})
            print(f"{status} {cell['id']}: {type(error).__name__}: {error}", flush=True)
        if metrics is not None:
            write_new(directory / "metrics.json", metrics)
        write_new(directory / "finished.json", {"status": status, "wall_seconds": time.monotonic() - clock,
                                                "files": seal(directory, [p for p in directory.rglob("*") if p.is_file()])})
    write_new(output / "seal.json", {"files": seal(output, [p for p in output.rglob("*") if p.is_file()])})
    summarize(output)
    if failures:
        raise RuntimeError(f"{failures} failed cells; receipts and failed denominators retained")


def verify_run(root: Path, output: Path) -> dict:
    check_inputs(root)
    checked(root, read(root / "parses.json")["files"])
    checked(output, read(output / "seal.json")["files"])
    manifest = read(output / "manifest.json")
    checked(root, manifest["dataset"])
    if manifest["code"] != code_files():
        raise ValueError("code changed after registration")
    return manifest


def replay(root: Path, output: Path, report: Path):
    manifest = verify_run(root, output)
    results = []
    for cell in manifest["cells"]:
        directory = output / "cells" / cell["id"]
        if not (directory / "artifact.json").exists():
            results.append({"cell": cell["id"], "status": "retained_failed"})
            continue
        receipt = read(directory / "started.json")
        provider, chats, counters, captures = receipt["provider"], {}, {}, {}
        for role in ("fields", "reasoning"):
            saved = read(directory / f"{role}-counter.json")
            captures[role] = Captured(directory / "calls", role, provider["model"], saved["context"])
            chats[role] = OpenAIChat(url=provider["base_url"] + "/v1/chat/completions", model=provider["model"],
                                    timeout=provider.get("timeout", 300), max_tokens=provider.get("max_tokens", 4096))
            counters[role] = Probes(directory / "tokens" / role, identity=saved["identity"], context=saved["context"])
        with capture_calls(chats, captures, directory / "calls", offline=True):
            actual = extract(root / "documents" / cell["document"] / "parse", ExtractRequest.model_validate(receipt["request"]),
                             Router(**chats), counter=counters, generation=receipt["generation"])
        if json.loads(json.dumps(stable(actual))) != stable(read(directory / "artifact.json")):
            raise ValueError(f"replay changed output for {cell['id']}")
        if any(c.index != len(c.calls) for c in captures.values()):
            raise ValueError("unconsumed captured replies")
        results.append({"cell": cell["id"], "identical_except_top_level_clocks": True,
                        "captured_calls": sum(c.index for c in captures.values())})
    write_new(report, {"kind": "offline replay, not fresh inference", "fresh_model_calls": 0, "cells": results})


def score(root: Path, output: Path, report: Path):
    manifest = verify_run(root, output)
    results = []
    for cell in manifest["cells"]:
        directory = output / "cells" / cell["id"]
        status = read(directory / "finished.json")["status"]
        if not (directory / "artifact.json").exists():
            results.append({"cell": cell, "status": status, "metrics": read(directory / "metrics.json")})
            continue
        source = root / "documents" / cell["document"]
        if status == "scoring_failed":
            error = read(directory / "error.json")
            try:
                artifact, truth, evidence = read(directory / "artifact.json"), read(source / "truth.json"), load(source / "parse")
                evaluate(truth, artifact, evidence)
                controls(truth, artifact, evidence)
            except Exception as reproduced:
                if type(reproduced).__name__ != error["type"] or str(reproduced) != error["message"]:
                    raise ValueError("scoring failure changed during recomputation") from reproduced
            else:
                raise ValueError("scoring failure no longer reproduced")
            results.append({"cell": cell, "status": status, "error": error})
            continue
        metrics = evaluate(read(source / "truth.json"), read(directory / "artifact.json"), load(source / "parse"))
        if metrics != read(directory / "metrics.json"):
            raise ValueError("recomputed scores changed")
        results.append({"cell": cell, "status": "completed", "metrics": metrics})
    write_new(report, {"cells": results})


def summarize(output: Path):
    print("document | method | status | field P/R | record P/R | evidence P/R | object evidence R | oracle object R | calls | tokens in/out", flush=True)
    for cell in read(output / "manifest.json")["cells"]:
        directory = output / "cells" / cell["id"]
        status = read(directory / "finished.json")["status"]
        if not (directory / "metrics.json").exists():
            print(f"{cell['document']} | {cell['method']} | {status} | metrics unavailable; raw artifact and cost retained", flush=True)
            continue
        metrics = read(directory / "metrics.json")
        pairs = ["/".join("n/a" if metrics[name][k] is None else f"{metrics[name][k]:.3f}"
                          for k in ("precision", "recall")) for name in ("fields", "records", "evidence")]
        cost = metrics["cost"]
        oracle = read(directory / "controls.json")["oracle"]["evidence"] if (directory / "controls.json").exists() else {}
        def recall(result):
            value = result.get("objects", {}).get("recall")
            return "n/a" if value is None else f"{value:.3f}"
        print(" | ".join([cell["document"], cell["method"], status, *pairs, recall(metrics["evidence"]), recall(oracle),
                          str(cost.get("calls", "unknown")),
                          f"{cost.get('input_tokens', 'unknown')}/{cost.get('output_tokens', 'unknown')}"]), flush=True)

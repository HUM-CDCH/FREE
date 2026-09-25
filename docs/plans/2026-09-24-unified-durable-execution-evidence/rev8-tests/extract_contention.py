"""Rev-8 extraction contention test: a big Catalog extraction and a small one through kei's own `extract()` on the
Spark's extraction servers, routed per role exactly as the worker routes them (`chats_for`).

Each extraction works on a fresh copy of its run directory (extract() publishes the segmentation into it). A sampler
polls /metrics of extraction_model and nuextract_model every 0.5 s.

  alone  RUN [--strategy catalog|article]
  inject BIG SMALL --delay S [--small-strategy catalog|article]
                     the big Catalog extraction starts; S seconds later the small one starts in a second thread of
                     the same process, as it would with two slots on a kei extraction queue
  split  RUN --chunks K
                     one Catalog extraction with its segmented entries cut into K contiguous chunks, each extracted
                     in its own thread under the full headings and glossary; the records are saved for comparison
                     with an unsplit run of the same document
"""
import argparse
import json
import os
import re
import shutil
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

from kei_exp.kie.extract import grounded
from kei_exp.kie.extract.evidence import load
from kei_exp.kie.extract.models import chats_for
from kei_exp.kie.extract.run import ExtractRequest, extract
from kei_exp.kie.extract.tokens import counter_for
from kei_exp.kie.recipe import load_recipe
from kei_exp.kie.segmentation import obtain

SERVERS = {role: os.environ[variable].split("/v1/")[0] + "/metrics"  # the servers the routed chats talk to
           for role, variable in (("qwen", "KEI_EXTRACT_URL"), ("nuextract", "KEI_NUEXTRACT_URL"))}
WANTED = {"vllm:num_requests_running": "running", "vllm:num_requests_waiting": "waiting",
          "vllm:kv_cache_usage_perc": "kv", "vllm:num_preemptions_total": "preemptions"}
SCHEMA = {"recordDescription": "One numbered entry of an archaeological catalogue.", "schemaNodes": [
    {"id": "n", "name": "entry_no", "type": "integer"},
    {"id": "s", "name": "site_name", "type": "string", "description": "the find place right after the number"},
    {"id": "b", "name": "bezirk", "type": "string"},
    {"id": "k", "name": "kreis", "type": "string"},
    {"id": "f", "name": "fundart", "type": "string", "description": "the find category after FA:"},
]}
OPTIONS = {"catalog": {"strategy": "catalog", "catalog": {"recipe": "numbered-catalogue-de@1"}},
           "article": {"strategy": "article"}}
T0 = time.monotonic()


def now() -> float:
    return round(time.monotonic() - T0, 2)


def scrape(url: str) -> dict[str, float]:
    found: dict[str, float] = {}
    for line in urllib.request.urlopen(url, timeout=5).read().decode().splitlines():
        match = re.match(r"^(vllm:[a-z_]+)\{[^}]*\} (\S+)$", line)
        if match and match.group(1) in WANTED:
            found[WANTED[match.group(1)]] = float(match.group(2))
    return found


class Sampler(threading.Thread):
    def __init__(self) -> None:
        super().__init__(daemon=True)
        self.samples: list[dict] = []
        self.stop = threading.Event()

    def run(self) -> None:
        while not self.stop.is_set():
            row: dict = {"t": now()}
            for name, url in SERVERS.items():
                try:
                    row[name] = scrape(url)
                except Exception as error:  # noqa: BLE001
                    row[name] = {"error": str(error)}
            self.samples.append(row)
            self.stop.wait(0.5)

    def window(self, start: float, end: float) -> dict:
        summary = {}
        for name in SERVERS:
            rows = [s[name] for s in self.samples if start <= s["t"] <= end and "error" not in s[name]]
            if rows:
                summary[name] = {"running_mean": round(sum(r["running"] for r in rows) / len(rows), 2),
                                 "running_max": max(r["running"] for r in rows),
                                 "waiting_max": max(r["waiting"] for r in rows),
                                 "preemptions": rows[-1]["preemptions"] - rows[0]["preemptions"]}
        return summary


def run_extraction(name: str, source: Path, strategy: str, results: dict) -> None:
    record: dict = {"run": source.name, "strategy": strategy, "start": now()}
    results[name] = record
    try:
        run_dir = Path(tempfile.mkdtemp()) / source.name
        shutil.copytree(source, run_dir)
        request = ExtractRequest.model_validate({"schema": SCHEMA, "options": OPTIONS[strategy]})
        result = extract(run_dir, request, chats_for(request.options))
        record.update(records=len(result["records"]), calls=len(result["calls"]), complete=result.get("complete"),
                      issues=sorted({issue["code"] for issue in result.get("issues", [])}),
                      extracted=result["records"])
    except Exception as error:  # noqa: BLE001 - the harness reports it
        record["error"] = f"{type(error).__name__}: {error}"
    record["end"] = now()
    record["seconds"] = round(record["end"] - record["start"], 2)


def run_split(source: Path, chunks: int, results: dict, sequential: bool = False) -> None:
    """The recipe path of `extract()` (run.py `_grounded`), with the segmentation's entries in K chunks: in parallel
    threads, or one after another (same prompts, one request at a time) to separate the split from batching."""
    record: dict = {"run": source.name, "strategy": f"catalog split {chunks}{' sequential' if sequential else ''}",
                    "start": now()}
    results["split"] = record
    try:
        run_dir = Path(tempfile.mkdtemp()) / source.name
        shutil.copytree(source, run_dir)
        request = ExtractRequest.model_validate({"schema": SCHEMA, "options": OPTIONS["catalog"]})
        options = request.options
        evidence = load(run_dir)
        recipe = load_recipe(options.catalog.recipe)
        segmentation = obtain(run_dir, evidence, recipe)
        chat = chats_for(options)
        by_client = {id(client): counter_for(client) for client in chat.chats().values()}
        counter = {role: by_client[id(client)] for role, client in chat.chats().items()}
        blocks = segmentation.blocks
        size = -(-len(blocks) // chunks)
        parts = [segmentation.model_copy(update={"blocks": blocks[i:i + size]}) for i in range(0, len(blocks), size)]
        bodies: list = [None] * len(parts)

        def work(index: int) -> None:
            bodies[index] = grounded.extract_grounded(evidence, request.schema_, recipe, options.catalog,
                                                      parts[index], chat, counter)

        if sequential:
            for index in range(len(parts)):
                work(index)
        else:
            threads = [threading.Thread(target=work, args=(i,)) for i in range(len(parts))]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
        extracted = [row for body in bodies for row in body["records"]]
        record.update(records=len(extracted), calls=sum(len(body["calls"]) for body in bodies),
                      complete=all(body["complete"] for body in bodies),
                      issues=sorted({issue["code"] for body in bodies for issue in body["issues"]}),
                      chunk_sizes=[len(part.blocks) for part in parts], extracted=extracted)
    except Exception as error:  # noqa: BLE001 - the harness reports it
        record["error"] = f"{type(error).__name__}: {error}"
    record["end"] = now()
    record["seconds"] = round(record["end"] - record["start"], 2)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["alone", "inject", "split"])
    parser.add_argument("--chunks", type=int, default=4)
    parser.add_argument("--sequential", action="store_true", help="split mode: run the chunks one after another")
    parser.add_argument("runs", type=Path, nargs="+")
    parser.add_argument("--strategy", choices=list(OPTIONS), default="catalog")
    parser.add_argument("--small-strategy", choices=list(OPTIONS), default="catalog")
    parser.add_argument("--delay", type=float, default=60.0)
    parser.add_argument("--label", required=True)
    parser.add_argument("--out", type=Path, default=Path("/work/results"))
    args = parser.parse_args()

    before = {name: scrape(url) for name, url in SERVERS.items()}
    sampler = Sampler()
    sampler.start()
    results: dict = {}
    if args.mode == "alone":
        run_extraction("doc", args.runs[0], args.strategy, results)
    elif args.mode == "split":
        run_split(args.runs[0], args.chunks, results, args.sequential)
    else:
        big, small = args.runs
        worker = threading.Thread(target=run_extraction, args=("big", big, "catalog", results))
        worker.start()
        time.sleep(args.delay)
        run_extraction("small", small, args.small_strategy, results)
        worker.join()
    sampler.stop.set()
    sampler.join()
    for record in results.values():
        record["servers"] = sampler.window(record["start"], record["end"])
    report = {"label": args.label, "busy_before": before, "results": results}
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / f"{args.label}.json").write_text(json.dumps(report, indent=2))
    (args.out / f"{args.label}.samples.json").write_text(json.dumps(sampler.samples))
    print(json.dumps({"label": args.label, **{name: {k: r.get(k) for k in (
        "seconds", "records", "calls", "complete", "issues", "error", "servers")} for name, r in results.items()}}))


if __name__ == "__main__":
    main()

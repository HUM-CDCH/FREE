"""M3 Catalog chunk measurement, a copy of rev-8's `extract_contention.py`: big Catalog extractions and a small one
through kei's own `extract()` at the M3 commit, on the Spark's extraction servers, routed per role exactly as the
worker routes them (`chats_for`). M3's `extract(..., chunks=K)` runs a Catalog's entries in K parallel contiguous
chunks after one prelude (segmentation, budget checks, document fields), so rev-8's `split` mode is gone.

Each extraction works on a fresh copy of its run directory (extract() publishes the segmentation into it). A sampler
polls /metrics of extraction_model and nuextract_model every 0.5 s.

`--chunks K` (default 1) is the big Catalog's chunk count in every mode (the Article path ignores it); the small
extraction uses `--small-chunks` (default 1, as in its alone runs).

  alone  RUN [--strategy catalog|article] [--chunks K]
  inject BIG SMALL --delay S [--small-strategy catalog|article] [--chunks K]
                     the big Catalog extraction starts; S seconds later the small one starts in a second thread of
                     the same process, as it would with two slots on a kei extraction queue
  pair   BIG BIG2 SMALL --delay S [--small-strategy catalog|article] [--chunks K]
                     two big Catalog extractions start together, each with K chunks; S seconds later the small one
                     starts in a third thread, as two busy `kei-extract` slots plus a waiting small extraction would
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

from kei_exp.kie.extract.models import chats_for
from kei_exp.kie.extract.run import ExtractRequest, extract

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


def run_extraction(name: str, source: Path, strategy: str, results: dict, chunks: int = 1) -> None:
    record: dict = {"run": source.name, "strategy": strategy, "chunks_asked": chunks, "start": now()}
    results[name] = record
    try:
        run_dir = Path(tempfile.mkdtemp()) / source.name
        shutil.copytree(source, run_dir)
        request = ExtractRequest.model_validate({"schema": SCHEMA, "options": OPTIONS[strategy]})
        result = extract(run_dir, request, chats_for(request.options), chunks=chunks)
        record.update(chunks=result.get("chunks"), records=len(result["records"]), calls=len(result["calls"]),
                      complete=result.get("complete"),
                      issues=sorted({issue["code"] for issue in result.get("issues", [])}),
                      extracted=result["records"])
    except Exception as error:  # noqa: BLE001 - the harness reports it
        record["error"] = f"{type(error).__name__}: {error}"
    record["end"] = now()
    record["seconds"] = round(record["end"] - record["start"], 2)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["alone", "inject", "pair"])
    parser.add_argument("runs", type=Path, nargs="+")
    parser.add_argument("--chunks", type=int, default=1, help="the big Catalog's chunks, in every mode")
    parser.add_argument("--small-chunks", type=int, default=1, help="the small extraction's chunks (inject, pair)")
    parser.add_argument("--strategy", choices=list(OPTIONS), default="catalog")
    parser.add_argument("--small-strategy", choices=list(OPTIONS), default="catalog")
    parser.add_argument("--delay", type=float, default=60.0)
    parser.add_argument("--label", required=True)
    parser.add_argument("--out", type=Path, default=Path("/work/results"))
    args = parser.parse_args()
    wanted = {"alone": 1, "inject": 2, "pair": 3}[args.mode]
    if len(args.runs) != wanted:
        parser.error(f"{args.mode} takes {wanted} run directories")

    before = {name: scrape(url) for name, url in SERVERS.items()}
    sampler = Sampler()
    sampler.start()
    results: dict = {}
    if args.mode == "alone":
        run_extraction("doc", args.runs[0], args.strategy, results, args.chunks)
    else:
        *bigs, small = args.runs
        workers = [threading.Thread(target=run_extraction, args=(name, big, "catalog", results, args.chunks))
                   for name, big in zip(("big", "big2"), bigs)]
        for worker in workers:
            worker.start()
        time.sleep(args.delay)
        run_extraction("small", small, args.small_strategy, results, args.small_chunks)
        for worker in workers:
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
        "seconds", "chunks", "records", "calls", "complete", "issues", "error", "servers")}
        for name, r in results.items()}}))


if __name__ == "__main__":
    main()

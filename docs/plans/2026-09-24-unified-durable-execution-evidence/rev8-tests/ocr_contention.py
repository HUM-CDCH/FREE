"""Rev-8 OCR contention test: a book and a small document through kei's own conversion on the Spark's ocr_model.

Runs inside a throwaway container of the parsing image on the Compose network (see run.sh). Each document goes
through `ocr.resolve` + `kie.runner.convert` exactly as a worker would, with Studio's settings (surya, cut=auto,
page_source=pdf). SURYA_INFERENCE_PARALLEL comes from the environment. A sampler polls the vLLM /metrics endpoint
every 0.5 s, so each result records how many requests the server ran and queued, its KV-cache use and preemptions.

  alone  PDF                        one document, after a 1-page warm-up
  inject BOOK SMALL --after PHASE --delay S
                                    the book starts; S seconds after it enters PHASE (cut|ocr) the small document
                                    starts in a second thread of the same process, as it would in one kei worker
"""
import argparse
import json
import os
import re
import threading
import time
import urllib.request
from pathlib import Path

from kei_exp.kie.runner import convert
from kei_exp.kie.stages import ocr
from kei_exp.transcription.types import RunParams

OCR_URL = os.environ.get("KEI_VLLM_URL", "http://ocr_model:8000/v1/chat/completions")
METRICS_URL = OCR_URL.split("/v1/")[0] + "/metrics"
WANTED = {
    "vllm:num_requests_running": "running",
    "vllm:num_requests_waiting": "waiting",
    "vllm:kv_cache_usage_perc": "kv",
    "vllm:num_preemptions_total": "preemptions",
}
T0 = time.monotonic()


def now() -> float:
    return round(time.monotonic() - T0, 2)


def scrape() -> dict[str, float]:
    text = urllib.request.urlopen(METRICS_URL, timeout=5).read().decode()
    found: dict[str, float] = {}
    for line in text.splitlines():
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
            try:
                self.samples.append({"t": now(), **scrape()})
            except Exception as error:  # noqa: BLE001 - a missed sample is recorded, not fatal
                self.samples.append({"t": now(), "error": str(error)})
            self.stop.wait(0.5)

    def window(self, start: float, end: float) -> dict:
        rows = [s for s in self.samples if start <= s["t"] <= end and "error" not in s]
        if not rows:
            return {}
        return {
            "samples": len(rows),
            "running_mean": round(sum(r["running"] for r in rows) / len(rows), 2),
            "running_max": max(r["running"] for r in rows),
            "waiting_mean": round(sum(r["waiting"] for r in rows) / len(rows), 2),
            "waiting_max": max(r["waiting"] for r in rows),
            "kv_max": round(max(r["kv"] for r in rows), 3),
            "preemptions": rows[-1]["preemptions"] - rows[0]["preemptions"],
        }


def run_doc(name: str, pdf: Path, results: dict, phases: dict[str, threading.Event] | None = None,
            pages: tuple[int, int] | None = None) -> None:
    record: dict = {"pdf": pdf.name, "start": now(), "phases": []}
    results[name] = record

    def emit(event: dict) -> None:
        if event.get("type") == "phase":
            record["phases"].append({"t": now(), "name": event["name"], "total": event.get("total")})
            if phases and event["name"] in phases:
                phases[event["name"]].set()

    try:
        execution = ocr.resolve(RunParams(pdf=pdf, model="surya", url=OCR_URL, cut="auto", pages=pages,
                                          page_source="pdf", source_name=pdf.name))
        record["chars"] = len(convert(execution, emit))
    except Exception as error:  # noqa: BLE001 - the harness reports it
        record["error"] = f"{type(error).__name__}: {error}"
    record["end"] = now()
    record["seconds"] = round(record["end"] - record["start"], 2)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["alone", "inject"])
    parser.add_argument("pdfs", type=Path, nargs="+")
    parser.add_argument("--after", choices=["cut", "ocr"], default="ocr")
    parser.add_argument("--delay", type=float, default=30.0)
    parser.add_argument("--label", required=True)
    parser.add_argument("--out", type=Path, default=Path("/work/results"))
    args = parser.parse_args()

    before = scrape()
    if before.get("running") or before.get("waiting"):
        print(f"WARNING: ocr_model already busy before the test: {before}")
    sampler = Sampler()
    sampler.start()
    results: dict = {}

    run_doc("warmup", Path("/work/pdfs/small1.pdf"), results)  # loads the layout model; excluded from timings
    if args.mode == "alone":
        run_doc("doc", args.pdfs[0], results)
    else:
        book, small = args.pdfs
        entered = {args.after: threading.Event()}
        book_thread = threading.Thread(target=run_doc, args=("book", book, results, entered))
        book_thread.start()
        entered[args.after].wait()
        time.sleep(args.delay)
        run_doc("small", small, results)
        book_thread.join()
    sampler.stop.set()
    sampler.join()

    for name, record in results.items():
        if "start" in record and "end" in record:
            record["server"] = sampler.window(record["start"], record["end"])
    report = {
        "label": args.label,
        "surya_parallel": os.environ.get("SURYA_INFERENCE_PARALLEL", "default"),
        "busy_before": before,
        "results": results,
    }
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / f"{args.label}.json").write_text(json.dumps(report, indent=2))
    (args.out / f"{args.label}.samples.json").write_text(json.dumps(sampler.samples))
    brief = {name: {k: r.get(k) for k in ("seconds", "error", "server")} for name, r in results.items()}
    print(json.dumps({"label": args.label, "parallel": report["surya_parallel"], **brief}))


if __name__ == "__main__":
    main()

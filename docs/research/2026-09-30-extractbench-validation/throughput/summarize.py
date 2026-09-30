"""Recompute saved statistics read-only; optionally write new copies with --output NEW_DIRECTORY."""
import argparse
import csv
import json
import statistics
from pathlib import Path

out = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path)
args = parser.parse_args()
rows = json.loads((out / "all-results.json").read_text())
assert len(rows) == 12
assert len({r["request_sha256"] for r in rows}) == 1
assert all(r["finish_reason"] == "stop" and r["output_tokens"] <= 512 for r in rows)
assert all(r["metric_delta"].get("vllm:num_preemptions_total", 0) == 0 for r in rows)
summary = {}
for name in ("direct-existing", "direct-clean", "harness-clean"):
    selected = [r for r in rows if r["condition"] == name and not r["warmup"]]
    assert len(selected) == 3
    stats = {}
    for field in ("input_tokens", "output_tokens", "ttft_server_seconds", "decode_seconds",
                  "decode_tokens_per_second", "http_e2e_seconds", "condition_e2e_seconds", "server_e2e_seconds"):
        values = [r[field] for r in selected]
        stats[field] = {"median": statistics.median(values), "mean": statistics.mean(values),
                        "min": min(values), "max": max(values)}
    overhead = [r["condition_e2e_seconds"] - r["http_e2e_seconds"] for r in selected]
    stats["client_non_http_overhead_seconds"] = {"median": statistics.median(overhead),
        "mean": statistics.mean(overhead), "min": min(overhead), "max": max(overhead)}
    stats["pooled_decode_tokens_per_second"] = sum(r["output_tokens"] - 1 for r in selected) / sum(r["decode_seconds"] for r in selected)
    stats["prefix_cached_tokens"] = [r["metric_delta"].get("vllm:prompt_tokens_cached_total", 0) for r in selected]
    stats["prefix_cache_hits"] = [r["metric_delta"].get("vllm:prefix_cache_hits_total", 0) for r in selected]
    summary[name] = stats
summary["comparisons"] = {
    "harness_vs_direct_clean_decode_percent": 100 * (summary["harness-clean"]["decode_tokens_per_second"]["median"] /
        summary["direct-clean"]["decode_tokens_per_second"]["median"] - 1),
    "clean_vs_existing_decode_percent": 100 * (summary["direct-clean"]["decode_tokens_per_second"]["median"] /
        summary["direct-existing"]["decode_tokens_per_second"]["median"] - 1),
    "harness_vs_direct_clean_e2e_seconds": summary["harness-clean"]["condition_e2e_seconds"]["median"] -
        summary["direct-clean"]["condition_e2e_seconds"]["median"],
    "all_response_messages_equal": len({r["response_text_sha256"] for r in rows}) == 1,
    "measured_output_tokens": sum(r["output_tokens"] for r in rows if not r["warmup"]),
    "warmup_output_tokens": sum(r["output_tokens"] for r in rows if r["warmup"]),
}
if (out / 'summary.json').exists():
    assert summary == json.loads((out / 'summary.json').read_text()), 'Saved summary differs from recomputed statistics'
if args.output is not None:
    args.output.mkdir(parents=True, exist_ok=False)
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    fields = [k for k in rows[0] if not k.startswith("metric_")]
    with (args.output / "measurements.csv").open("x", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore", lineterminator='\n')
        writer.writeheader()
        writer.writerows(rows)
print(json.dumps(summary, indent=2))

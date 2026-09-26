# M3 Catalog chunk measurement on the Spark (2026-09-26)

This is DBOS plan M3 Task 14. It checks the spec's last M3 test bullet: a 200-entry Catalog should finish in about a
quarter of the time with parallel chunks, and a small extraction beside it should still finish promptly.

## Setup

- **Host:** baratheon, against the live production vLLM servers `nuextract_model` (`numind/NuExtract3-FP8`) and
  `extraction_model` (`Qwen/Qwen3.8-27B-FP8`). NuExtract runs with `--max-num-seqs 4`. The servers were reached
  the rev-8 way, over the Compose network `free_app` (`run_chunks.sh`).
- **Code:** kei at **e5003f9** (M3). No new image was built. Each run used a throwaway container
  (`free-m3-spark-<label>`) of the production image `free-parsing_worker`. The container mounted `src/` from
  `git archive e5003f9 prototypes/parsing_service` read-only over the image's editable install at `/app/src`,
  and it mounted the model cache read-only with `HF_HUB_OFFLINE=1`.
  - The extraction path imports no `dbos`, and the image has none.
  - A probe container confirmed the setup before the runs: `kei_exp` loaded from `/app/src`, and
    `extract()`'s signature included `chunks`.
- **Impact on production:** no production container was touched.
- **Documents:** the rev-8 synthetic catalogues, which were no longer on the Spark. `rev8-tests/make_catalogues.py`
  regenerated them inside the same kind of container, using the M3 `tests/helpers/catalogue.py` and
  `PYTHONPATH=/work/parsing_service`. The script's `catalogue-big` and `catalogue-small` were renamed to
  `runs/big` (25 spreads, 200 entries) and `runs/small` (`continuations`, 4 entries). As a check that nothing
  changed, the M3 unsplit records are **identical** to rev-8's `ex-big-alone` (200 of 200 entries).
- **Server load:** the servers were idle before the runs. A probe and every run's `busy_before` show
  `num_requests_running` = 0 and `num_requests_waiting` = 0 on both servers.
- **Timing:** the runs went one after another, 07:32–07:49 CEST.

## Files

- `extract_chunks.py` is a copy of `rev8-tests/extract_contention.py` with these changes:
  - `--chunks K` (default 1) is the big Catalog's chunk count in every mode.
  - `run_extraction` calls `extract(..., chunks=K)` and records `result["chunks"]`.
  - The `split` mode is gone.
  - A new mode, `pair BIG BIG2 SMALL --delay S`, starts two big Catalogs together and the small extraction S
    seconds later in a third thread.
  - The small extraction uses `--small-chunks`, which defaults to 1 as in its alone runs.
- `run_chunks.sh` is a copy of `rev8-tests/run_extract.sh`. It mounts `~/m3-spark`, adds the M3 `src/` mount and
  names the container `free-m3-spark-*`.
- `results/` holds the reports. The `*.samples.json` files hold the 0.5 s `/metrics` samples.

## Commands (from `~/m3-spark` on the Spark)

```bash
./run_chunks.sh m3-big-unsplit alone runs/big --chunks 1
./run_chunks.sh m3-big-chunks4 alone runs/big --chunks 4
./run_chunks.sh m3-small-cat alone runs/small --strategy catalog
./run_chunks.sh m3-small-art alone runs/small --strategy article
./run_chunks.sh m3-inject-cat inject runs/big runs/small --chunks 4 --small-strategy catalog --delay 30
./run_chunks.sh m3-inject-art inject runs/big runs/small --chunks 4 --small-strategy article --delay 30
./run_chunks.sh m3-pair pair runs/big runs/big runs/small --chunks 4 --delay 30
# locally, after copying results/ back (the Spark has no ../rev8-tests):
python3 ../rev8-tests/compare_records.py results/m3-big-unsplit.json results/m3-big-chunks4.json
```

## Results

Every extraction completed with no issues. Each big Catalog produced 200 of 200 records in 200 calls, and each
small extraction produced 4 records. No run had preemptions.

| Run | Small | Big Catalog(s) | NuExtract running mean / max, waiting max |
|---|---|---|---|
| `m3-big-unsplit` (chunks 1) | – | 434.7 s | 0.97 / 1, 0 |
| `m3-big-chunks4` (chunks 4) | – | **105.7 s** (4.1×) | **3.82** / 4, 0 |
| `m3-small-cat` alone | 8.44 s | – | 0.94 / 1, 0 |
| `m3-small-art` alone | 13.21 s | – | 0.35 / 1 (Qwen 0.58 / 1), 0 |
| `m3-inject-cat` (small Catalog at +30 s) | **10.11 s** | 109.6 s | 3.75 / 4, 1 |
| `m3-inject-art` (small Article at +30 s) | **24.04 s** | 117.5 s | 3.82 / 4, 1 |
| `m3-pair` (2 big × 4 chunks, small Catalog at +30 s) | **18.66 s** | 211.1 s / 209.2 s | 3.86 / 4, **5** |

For comparison, rev-8 measured 434 s for the unsplit big Catalog, 106 s for the harness's parallel split
(NuExtract mean 3.82), 8.5 s for the small Catalog alone and 13.8 s for the small Article alone.

## Against the brief's thresholds

- **The 200-entry Catalog with 4 chunks takes at most 130 s: PASS.** It took 105.7 s, 4.1 times faster than this
  session's unsplit 434.7 s, which equals rev-8's 434 s. NuExtract's running mean was 3.82, near 4. M3's
  chunking matches the rev-8 harness split (106 s) and drops its shortcuts: the document call runs once and entry
  numbers run across the whole document.
- **Injected small Catalog finishes within its alone time + 15 s: PASS.** It took 10.11 s against 8.44 s alone
  (+1.7 s).
- **Injected small Article finishes within its alone time + 15 s: PASS.** It took 24.04 s against 13.21 s alone
  (+10.8 s). This matches rev-8's 22.2 s beside an unsplit big Catalog. Most of the Article's time is on Qwen,
  which the chunks leave idle. Its NuExtract calls wait for a slot behind the 4 chunks.
- **`pair`:**
  - The small Catalog took 18.66 s against 8.44 s alone, a **+10.2 s** wait.
  - The two big Catalogs kept 8 requests in flight on 4 slots. NuExtract's `waiting_max` was 5: the bigs' 4
    queued requests plus the small one's.
  - The small extraction's 4 sequential requests each waited about 2.5 s, roughly one round of the others'
    requests. A round is about 2.1 s per request with 4 in flight: 105.7 s over 50 entries per chunk.
  - This is about one round per small request, as the spec's *kei worker* section says.
  - Each big Catalog took about 210 s beside the other, twice its alone time with chunks, because the server's 4
    slots were shared.

## Record differences (`compare_records.py`, five fields keyed by `entry_no`)

| Pair | Entries differing | Fields |
|---|---|---|
| unsplit vs chunks4 | **22** | `fundart` only |
| unsplit vs inject-cat big / inject-art big | 20 / 23 | `fundart` only |
| unsplit vs pair big / pair big2 | 24 / 21 | `fundart` only |
| chunks4 vs inject-cat big / inject-art big | 16 / 25 | `fundart` only |
| pair big vs pair big2 (same document, same time) | 23 | `fundart` only |
| rev-8 unsplit (`ex-big-alone`) vs M3 unsplit | **0** | – |

- Every difference is a borderline `fundart` value: a trailing dot (`G` vs `G.`, `Siedl.` vs `Siedl..`) or null
  against a value, in both directions.
- `entry_no`, `site_name`, `bezirk` and `kreis` match in every pair, so chunking loses no headings or entries.
- Unsplit vs chunks4 is 22 entries, one more than rev-8's range of 19–21. It has the same cause: vLLM batching
  concurrent requests. Two runs of the same document at the same time also differ by 23. The rev-8 README records
  that `VLLM_BATCH_INVARIANT` cannot remove this variation on these models (GDN attention), and the user has
  accepted it.

## Cleanup

- Results were copied back first.
- Then every `free-m3-spark-*` container was removed. `docker ps -a --filter name=free-m3-spark-` lists 0.
- `~/m3-spark` was deleted: `ls` reports that it no longer exists.
- The production containers kept their earlier uptimes: 12 h and 39 h.

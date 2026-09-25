Keep the separate queues; they remove the book’s queue monopoly.  
Reject “one book page later”: four client threads give no waiting-time guarantee.  
Count pages before choosing a queue, including for reprocessing.  
Fix shared settings, long rendering locks, and cleanup before enabling overlap.  
Try this before page jobs; decide from end-to-end Spark measurements.

1. **Claim 2 is plausible in good conditions, but false as a guarantee.**

   vLLM defaults to [first-come-first-served scheduling](https://docs.vllm.ai/en/stable/api/vllm/config/scheduler/). Once the small request reaches the server, later book requests normally queue behind it. That is the proposal’s strongest argument.

   But `SURYA_INFERENCE_PARALLEL=4` means four client workers **per conversion**, potentially eight together. It does not mean four requests are always running. Neither the 4G KV cache—the model’s working memory—nor the 24,576-token limit guarantees four long requests fit. Memory pressure can cause [preemption and repeated computation](https://docs.vllm.ai/en/stable/configuration/optimization/#preemption).

   A request is a crop or recognition attempt, not necessarily a page. Retries and layout/block fallback add requests; those rejoin scheduling rather than reserving the server until the page finishes. Streaming keeps the request active.

   Small-document completion could take minutes or, with failures, tens of minutes: the default request timeout is 600 seconds, with three Surya retries. That is no overall deadline. Rendering, cutting, layout, export, and existing small-job backlog add more delay. There is no defensible numeric bound without measurement.

2. **Classification must move earlier.**

   Today’s API already counts pages before admission: [api.py:203](/home/gennaro/projects/FREE/prototypes/parsing_service/src/kei_exp/api.py:203). The proposed DBOS path counts inside `prepare`, after queue selection.

   Count the validated, staged PDF before `submitToKei`; persist the count and chosen queue so retries keep their assignment. Apply the same helper to reprocessing. Reuse a count only when tied to identical source bytes. Do not run classification behind the busy conversion queue.

3. **Page count is a reasonable first approximation.**

   It is cheap and objective. “Interactive” alone is weak: someone actively uploading a book still wants it immediately. Start with a size-limited fast queue; choose N from measurements. Scanned spreads, dense pages and native PDFs cost differently. Keep the current whole-document native-text decision.

   The extraction queue helps during OCR, but a long extraction can still block a short extraction. Studio chat also bypasses kei. Separate servers still share Spark hardware.

   Allow another upload while processing continues. Another tab is acceptable for the experiment, not the finished experience.

4. **Concurrent conversions need more than queue changes.**

   `configure()` overwrites process-global Surya settings: [surya.py:215](/home/gennaro/projects/FREE/prototypes/parsing_service/src/kei_exp/transcription/surya.py:215). Identical settings avoid differing-value races; different recipes do not.

   Worse, whole-page rendering holds the PDFium lock across the entire document: [surya.py:236](/home/gennaro/projects/FREE/prototypes/parsing_service/src/kei_exp/transcription/surya.py:236). A small job can wait for the book’s rendering. Cached layout converters also need concurrency verification. Both conversions retain images, increasing shared-memory pressure.

   Separate run directories are fine. Overlapping writers to one result directory are not. The flock excludes another worker process; it does not protect threads inside this one.

5. **Boot-only cleanup is a temporary compromise.**

   On a rarely restarted machine, abandoned files and history accumulate indefinitely. Keep routine cleanup for proven-finished, unreferenced runs. Cancelled or uncertain executions require proof that their actual execution ended; database cancellation and file age are insufficient. Boot cleanup must also protect work being recovered.

6. **Page jobs offer stronger scheduling boundaries and cheaper recovery.**

   They let documents alternate and avoid repeating an entire book after failure. But children need private outputs, one final publisher, and a parent outside their constrained queue. That cost is not justified yet. Bounded image batches inside one document job may solve memory pressure first.

7. **I would keep the three queues, fix shared state and lock scope, and run four deciding tests:**

   - Inject small scanned/native documents during book rendering, OCR and export. Measure upload-to-extracted-values latency.
   - Compare client limits 1, 2 and 4; record book throughput, model waiting, memory and preemptions.
   - Overlap different recipes, reprocessing, extraction and chat; verify settings, generations and evidence.
   - Exercise failures, deadlines and deletion in a disposable deployment; prove cleanup waits for execution and eventually reclaims disk.

These are proposed tests; no Spark measurements were run.


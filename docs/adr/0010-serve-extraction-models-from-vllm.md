# 0010: Serve extraction models from vLLM, one server per model

Date: 2026-09-23. Status: accepted; amends the model-server part of
[0009](0009-own-parsing-and-extraction-service-in-free.md).

## Context

Extraction called an Ollama container (`qwen3:8b`) through its
OpenAI-compatible route, while scanned OCR already ran on a vLLM server. The
extraction work needs larger models and higher throughput than the Ollama
setup gave. It also needs a count of every request's tokens before sending,
which Ollama provides only through a reconstructed tokenizer. The target
machine is an NVIDIA DGX Spark (GB10, ARM64, 128 GB of memory shared by CPU
and GPU).

## Decision

Extraction models run in vLLM, one Compose service per model, on the GPU
overlay beside the OCR server and from the same `VLLM_IMAGE`. They are not
embedded in the Python service: vLLM pins its own torch version (the service
runs torch, Docling and Surya on Python 3.13), the API and worker are separate
processes, the development watch restarts them on every edit, and the Python
side stays on the CPU so that the model servers own the GPU. Each server loads
one model, so the engines start one after another (each profiles free GPU
memory as it starts) and are sized by fixed KV-cache budgets rather than
fractions of the GPU.

Two models serve extraction by default, in FP8:
`numind/NuExtract3-FP8`, a template extractor, fills fields (document, record
and grounded entry calls), and `Qwen/Qwen3.8-27B-FP8`, an instruction model,
does the reasoning calls (record discovery, grounding and arbitration), whose
replies are label enums a NuExtract template cannot express. A run may route
the fields role to the instruction model too; Studio offers the choice
(per run here; deployment-wide in [0011](0011-one-model-configuration-page.md);
per Researcher Account since [0013](0013-per-researcher-model-configuration.md),
sent with each start and pinned at admission since
[0015](0015-extraction-method-pinned-at-admission.md)). Thinking is switched
off per request through the chat template, and NuExtract's template and
instructions travel only in the chat template's arguments. Token budgets are
counted on vLLM's `/tokenize` with the same rendered request.

## Consequences

`FREE_GPU=off` no longer extracts: without the GPU overlay only native PDF
parsing is available, unless an operator points extraction at another
OpenAI-compatible vLLM endpoint. The Ollama service, its pull job and its
volume are removed; Studio's own Ollama Model Connections are unaffected
(raw NuExtract on Ollama is retired in [0011](0011-one-model-configuration-page.md)).
First GPU startup downloads about 38 GB of extraction weights, and the image
must support the `qwen3_5` architecture and FP8 on the target GPU. The
NuExtract server runs its repository's processor code (`--trust-remote-code`).
Extraction results record the model per role, so results from different
routings stay distinguishable.

# Local serving observation

2026-09-30. Read-only diagnosis of the existing Spark `baratheon` deployment;
no server restart, model change, decoding change, or extra benchmark requests.

The pinned Qwen FP8 server's own ten-second vLLM log intervals reported
7.8–7.9 generated tokens/second, one running request and zero waiting requests.
Two completed harness requests returned 1,561 tokens in 200.265 seconds and
1,987 tokens in 254.725 seconds. Their end-to-end rates agree with the server
decode rate; SSH/network delay and a request queue do not explain these timings.
The study deliberately uses one worker, so calls run sequentially.

One sample during generation showed NVIDIA GB10 at 96% GPU utilization,
47°C, 2,398 MHz, and 25.54 W reported GPU power. This is not a sustained thermal
or power profile; do not infer whole-machine power from that number. The earlier
idle sample (0% utilization, 40°C) was between requests.

The deployed model config identifies dense `qwen3_5_text`, 64 layers, hidden
size 5,120, FP8 E4M3 block weights, and no expert count. Its safetensors files
total 30,866,866,928 bytes (28.75 GiB), including components not exercised by
text-only generation. The served name is `Qwen/Qwen3.8-27B-FP8`; the internal
architecture name is recorded separately rather than used to relabel the server.

Spark's published memory bandwidth is 273 GB/s. As an order-of-magnitude
inference, streaming about 27 GB of active dense FP8 weights per sequential
decode step permits roughly ten tokens/second before other traffic and kernel
overhead. The observed rate is consistent with that memory-bandwidth constraint;
this arithmetic is not a hardware-counter profile or proof of optimal serving.
The advertised one-PFLOP figure is FP4 tensor throughput and does not predict
single-sequence FP8 decoding speed. [NVIDIA DGX Spark specifications](https://www.nvidia.com/en-us/products/workstations/dgx-spark/).

At the measured rate, 2,000 generated tokens take about 255 seconds and a full
4,096-token response about 523 seconds. The output cap is a bound, not the number
every request generates. Quotes, arrays and schema-required fields increase the
actual response length. Serving optimizations would need their own controlled
measurement; this screening retains the frozen deployment and settings.

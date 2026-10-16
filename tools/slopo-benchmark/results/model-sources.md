# Embedding model sources and GGUF provenance

Checked 2026-08-21. Model behavior below is sourced from the original model
publisher. GGUF-specific statements are kept separate because three of the four
quantized artifacts used by this benchmark were published outside the original
model vendor.

## Verified model behavior

| Model | Dimensions and MRL | Pooling | Instruction or prompt behavior |
| --- | --- | --- | --- |
| `jina-embeddings-v2-base-code` | Native/fixed 768 dimensions. Jina's model page and Hugging Face config both report 768; neither claims Matryoshka Representation Learning for this v2 model. The benchmark therefore tests only 768d. | Mean pooling. | The official usage examples encode question and code strings directly and document no task prefix or instruction requirement. |
| `Qwen3-Embedding-0.6B` | Native maximum 1024 dimensions, with MRL/custom outputs from 32 through 1024. The benchmark tests the 512d prefix and full 1024d vector. | Last-token (the final EOS hidden state). | Instruction-aware. Qwen recommends an English task instruction on the query side and leaves documents unprefixed; instructions are optional, but its card reports a typical 1-5% retrieval improvement from using them. |
| `pplx-embed-v1-0.6b` | Native 1024 dimensions with MRL. The model card marks MRL support, and the technical report's family training dimensions include 128, 256, 512, and 1024 within the 0.6B model's width. The benchmark tests 512d and 1024d. | Mean pooling followed by the model's tanh/INT8 quantization. | Explicitly not instruction-tuned: Perplexity says inputs can be embedded directly without maintaining a prefix. |
| `voyage-4-nano` | The local Hugging Face checkpoint defaults to 2048 dimensions and supports MRL outputs at 2048, 1024, 512, and 256. The benchmark tests 256d and 512d. | Mean pooling after its learned projection. | The official SentenceTransformers integration uses distinct query and document prompts through `encode_query` and `encode_document`. Plain `encode()` is unprompted, so these role prompts are recommended for retrieval rather than required to produce compatible embeddings. |

Primary sources:

- Jina: [official model page](https://jina.ai/models/jina-embeddings-v2-base-code/), [official Hugging Face model card](https://huggingface.co/jinaai/jina-embeddings-v2-base-code), and [official config (`hidden_size: 768`, `emb_pooler: mean`)](https://huggingface.co/jinaai/jina-embeddings-v2-base-code/blob/488f18c42c12e3f6a9e547ce4e96e1ab0249ce0a/config.json).
- Qwen: [official model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) and [technical report](https://arxiv.org/html/2506.05176). The report describes the EOS/last-token representation and query-only instruction format; the card documents MRL and the 32-1024 output range.
- Perplexity: [official model card](https://huggingface.co/perplexity-ai/pplx-embed-v1-0.6b), [technical report](https://arxiv.org/html/2602.11151), and [official quantizer implementation](https://huggingface.co/perplexity-ai/pplx-embed-v1-0.6b/commit/6d6efd1fe5497d4b14e92f8ff71bdf671f9fa430). The report defines the INT8 vector as rounded `127 * tanh(mean-pooled vector)` and compares it with cosine similarity.
- Voyage AI: [official model card](https://huggingface.co/voyageai/voyage-4-nano), [prompt configuration](https://huggingface.co/voyageai/voyage-4-nano/blob/main/config_sentence_transformers.json), and [embedding API documentation](https://docs.voyageai.com/docs/embeddings), covering local MRL dimensions, mean pooling, role prompts, and hosted output defaults.

## Exact artifacts benchmarked

The revisions and filenames below come from the benchmark's saved native-run
metadata. All four files are Q8_0 GGUF and were served with llama.cpp.

| Family | Exact artifact | Provenance and fidelity caveat |
| --- | --- | --- |
| Jina | [`jina-embeddings-v2-base-code-q8_0.gguf` at `05e79e9`](https://huggingface.co/ggml-org/jina-embeddings-v2-base-code-Q8_0-GGUF/blob/05e79e9a6c8b99491e92ebb28d753268f8601e3c/jina-embeddings-v2-base-code-q8_0.gguf) | `ggml-org` hosts a llama.cpp conversion derived from Jina's model; it is not a Jina AI release. Its card identifies the conversion path but provides no numerical Q8_0-vs-reference fidelity result. |
| Qwen | [`Qwen3-Embedding-0.6B-Q8_0.gguf` at `370f27d`](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/blob/370f27d7550e0def9b39c1f16d3fbaa13aa67728/Qwen3-Embedding-0.6B-Q8_0.gguf) | First-party Qwen GGUF repository. The official card lists Q8_0/F16 and instructs llama.cpp to use last pooling. |
| pplx | [`pplx-embed-v1-0.6B-Q8_0.gguf` at `2cadede`](https://huggingface.co/mykor/pplx-embed-v1-0.6b-GGUF/blob/2cadede717541842c84c7c2693811ae7970e2dde/pplx-embed-v1-0.6B-Q8_0.gguf) | Third-party `mykor` conversion, not a Perplexity release. The converter card's shown similarity check uses its F32 GGUF, not the Q8_0 file benchmarked here, so it does not establish Q8_0 fidelity. |
| Voyage | [`voyage-4-nano-q8_0.gguf` plus projection at `75e62c7`](https://huggingface.co/jsonMartin/voyage-4-nano-gguf/tree/75e62c7dba5ee8156717a56920976ab128b8c693) | Third-party `jsonMartin` conversion, not a Voyage AI release. llama.cpp emits the 1024-wide hidden representation; the converter supplies the required 1024-to-2048 linear projection. Its card reports mean cosine 0.999903 for Q8_0 versus the Hugging Face reference, but this is converter-reported rather than vendor-validated. |

Conversion cards: [Jina GGUF](https://huggingface.co/ggml-org/jina-embeddings-v2-base-code-Q8_0-GGUF), [Qwen official GGUF](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF), [pplx GGUF](https://huggingface.co/mykor/pplx-embed-v1-0.6b-GGUF), and [Voyage GGUF](https://huggingface.co/jsonMartin/voyage-4-nano-gguf).

Local SHA-256 verification of the files actually consumed by the saved run:

```text
jina-embeddings-v2-base-code-q8_0.gguf  3bd1722f09350209aa3ada93df55882666c58194bfbbbe81c30545d731cb4e7a
Qwen3-Embedding-0.6B-Q8_0.gguf            06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439
pplx-embed-v1-0.6B-Q8_0.gguf             08994a440609bdf1cf78c3fe2959fc8330e8da42c3b758110c293c2c4d94cee7
voyage-4-nano-q8_0.gguf                   d0e430fe24faba10f5bc6dd4f896e1efd0e6d65d7f0cf686a500d48cac274a4a
voyage-4-nano-linear.pt                   976dc77818028f5ca424787c015efb519eab600043a546bc23341ef00205d06e
```

## Benchmark-specific interpretation

The benchmark embeds every source-code unit symmetrically and supplies no
query/document instruction to any model. This matches pplx's documented input
contract and Jina's direct-encoding examples. It deliberately does not use
Qwen's recommended query instruction or Voyage's distinct query/document
prompts, because duplicate detection has no stable query side. Consequently,
these results characterize prompt-free code-to-code similarity, not each
model's best asymmetric retrieval setup.

The Perplexity card marks MRL support but does not expose a reduced-dimension
argument in its local usage example. Treating 512d as a valid prefix is supported
by the technical report's training anchors; mapping those family-wide anchors to
the 0.6B model's 1024-wide output is an explicit inference. Voyage's hosted API
documentation may default to 1024d, whereas the local Hugging Face checkpoint
and its expected shapes default to 2048d; this benchmark follows the local
checkpoint and conversion artifact.

For lower-dimensional configurations, the runner takes the leading dimensions
and L2-normalizes them. Before that truncation it applies Perplexity's documented
INT8 transform and the Voyage converter's separate projection. See
[`benchmark.py`](../benchmark.py) for the executable definitions.

The benchmark conclusions therefore apply to these exact revisions,
quantizations, pooling settings, transforms, and prompt-free inputs. They should
not be presented as direct measurements of the vendors' canonical float-weight
checkpoints or hosted APIs.

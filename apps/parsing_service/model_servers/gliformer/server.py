"""Private, stateless GLiFormer model server. The Parsing Service owns durable execution; results are retained
snapshots."""
import json
import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path

import torch
from fastapi import FastAPI, HTTPException
from gliformer import GLiFormer
from gliformer.processing.schema import normalize_structuring_schemas
from huggingface_hub import snapshot_download
from pydantic import BaseModel, ConfigDict, Field

MODEL = "knowledgator/gliformer-large-v1"
REVISION = "d0a4e53d09cebe6bc963dd9be319d4279084bb2d"
FRAMEWORK = "19db82a339e5b5ce35e4ea3dc7db4e3912422d76"
# An operational ceiling below the checkpoint's 16384-token limit for the shared Spark GPU.
MAX_INPUT = 2048
THRESHOLD = float(os.environ.get("GLIFORMER_THRESHOLD", "0.5"))
if not 0 < THRESHOLD < 1:
    raise ValueError("GLIFORMER_THRESHOLD must be between zero and one")
IDENTITY = {"model": MODEL, "revision": REVISION, "framework": FRAMEWORK,
            "protocol": "1", "prompt_version": "1", "threshold": str(THRESHOLD),
            "dtype": "bfloat16", "attention": "eager"}
gate = threading.Lock()


def load_model():
    snapshot = Path(snapshot_download(MODEL, revision=REVISION, allow_patterns=[
        "gliner_config.json", "pytorch_model.bin", "tokenizer*.json",
    ]))
    runtime = Path("/tmp/gliformer-model")
    runtime.mkdir(exist_ok=True)
    for source in snapshot.iterdir():
        target = runtime / source.name
        if source.name != "gliner_config.json" and not target.exists():
            target.symlink_to(source)
    config = json.loads((snapshot / "gliner_config.json").read_text())
    config["encoder_config"]["attn_kernel"] = "eager"
    (runtime / "gliner_config.json").write_text(json.dumps(config))
    return GLiFormer.from_pretrained(
        MODEL, model_dir=str(runtime), load_tokenizer=True, strict=True,
        dtype=torch.bfloat16, _attn_implementation="eager",
    ).to("cuda").eval()


@asynccontextmanager
async def lifespan(app):
    app.state.model = load_model()
    app.state.collator = app.state.model.create_inference_collator(return_tokens=True)
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


class Request(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    text: str = Field(min_length=1, max_length=200_000)
    schema_: dict = Field(alias="schema")
    identity: dict


def check_identity(body):
    if body.identity != IDENTITY:
        raise HTTPException(409, "GLiFormer model or decoding settings changed; submit a new extraction")


def described(batch, schema):
    """The pinned processor reads group instructions from `item.prompt`, not descriptor.description.

    Supply them to both counting and the actual inference collator; never prefix source text.
    """
    prompts = {name: spec["description"] for name, spec in schema.items()
               if isinstance(spec, dict) and isinstance(spec.get("description"), str)}
    for item in batch:
        item["prompt"] = prompts
    return batch


def token_count(model, text, schema):
    """The exact schema+source encoder input, without the native processor's silent truncation.

    Use the pinned framework's own schema normalization, task mappings and prompt construction.
    Supply the original words to prepare_inputs, before collate_raw_batch caps the word list.
    """
    tokens, _, _ = model.prepare_inputs([text])
    normalized = normalize_structuring_schemas(schema)
    batch = described(model._build_inference_input(tokens, structures=normalized), schema)
    mapping = model.data_processor.batch_generate_class_mappings(batch)
    words, _ = model.data_processor.prepare_inputs(tokens, mapping)
    encoded = model.data_processor.transformer_tokenizer(
        words, is_split_into_words=True, truncation=False, padding=False)
    return len(encoded["input_ids"][0]), len(tokens[0])


@app.get("/info")
def info():
    return {"protocol": 1, "model": MODEL, "identity": IDENTITY,
            "max_input_tokens": min(MAX_INPUT, int(app.state.model.config.max_len))}


@app.post("/tokenize")
def tokenize(body: Request):
    check_identity(body)
    with gate:
        count, _ = token_count(app.state.model, body.text, body.schema_)
    return {"count": count, "identity": IDENTITY}


@app.post("/structure")
def structure(body: Request):
    check_identity(body)
    with gate, torch.inference_mode():
        model = app.state.model
        count, words = token_count(model, body.text, body.schema_)
        if count > min(MAX_INPUT, int(model.config.max_len)) or words > int(model.config.max_len):
            raise HTTPException(413, "GLiFormer schema and source exceed the input budget; nothing was extracted")
        # Check counting against the actual native collator before running the GPU.
        tokens, _, _ = model.prepare_inputs([body.text])
        def collate(batch):
            return app.state.collator(described(batch, body.schema_))

        batch = collate(model._build_inference_input(tokens, structures=normalize_structuring_schemas(body.schema_)))
        if int(batch["attention_mask"].sum()) != count or int(batch["text_lengths"].max()) != words:
            raise HTTPException(500, "GLiFormer collator truncated or changed the counted input")
        output, diagnostics = model.structure(
            body.text, body.schema_, threshold=THRESHOLD, validate_output=False,
            return_anchor_diagnostics=True, inference_collator=collate)
    return {"output": output, "diagnostics": diagnostics, "input_tokens": count, "identity": IDENTITY}

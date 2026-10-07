"""Native GLiFormer fields over discovered entries. No chat emulation or value repair.

The service returns its untyped structuring decoder output and diagnostics. FREE preserves
both; source ranges identify the input, not proof that a predicted relationship is correct.
"""
from __future__ import annotations

from dataclasses import dataclass

import requests

from kei_exp.kie.extract.calls import structure
from kei_exp.kie.extract.discovery import plan, ranges_json
from kei_exp.kie.extract.schema import Schema, notes
from kei_exp.kie.extract.windows import Unit

MODEL = "knowledgator/gliformer-large-v1"
PROTOCOL = 1


def native_schema(schema: Schema) -> dict:
    """Only shapes the untyped decoder can express without formatting or filling values."""
    if schema.document_nodes or schema.filename_nodes:
        raise ValueError("GLiFormer supports record fields only, not document or filename fields")

    def group(nodes, description):
        fields, children = [], {}
        for node in nodes:
            if node.allowed_values or node.evidence_policy == "derived":
                raise ValueError(f"GLiFormer cannot derive or map allowed values for {node.name!r}")
            if node.type in ("string", "verbatim-string"):
                fields.append(node.name)
            elif node.type == "array" and node.item_type is None:
                children[node.name] = group(node.children or [], node.description or node.name)
            else:
                raise ValueError(f"GLiFormer requires strings or arrays of objects; {node.name!r} is {node.type}")
        if not fields and not children:
            raise ValueError("GLiFormer requires at least one field per record group")
        return {"fields": fields, "children": children,
                "description": "\n".join([description, *notes(nodes)])}

    return {"record": group(schema.record_nodes, schema.record_description)}


@dataclass
class GLiFormerFields:
    url: str
    model: str = MODEL
    timeout: float = 1800
    runtime: object | None = None
    pinned_info: dict | None = None

    def info(self) -> dict:
        if self.pinned_info is not None:
            return self.pinned_info
        response = requests.get(f"{self.url.rstrip('/')}/info", timeout=10)
        response.raise_for_status()
        body = response.json()
        if body.get("protocol") != PROTOCOL or body.get("model") != self.model:
            raise ValueError("GLiFormer service protocol or model does not match the configured backend")
        return body

    def counter(self):
        return NativeCounter(self, self.info())

    def structure(self, text: str, schema: dict, identity: dict) -> dict:
        response = requests.post(f"{self.url.rstrip('/')}/structure", timeout=self.timeout,
                                 json={"text": text, "schema": schema, "identity": identity})
        response.raise_for_status()
        body = response.json()
        if body.get("identity") != identity:
            raise ValueError("GLiFormer identity changed during extraction")
        raw = body.get("output")
        if not isinstance(raw, dict) or not isinstance(raw.get("record"), list) or \
                any(not isinstance(row, dict) for row in raw["record"]) or not isinstance(body.get("diagnostics"), dict):
            raise ValueError("GLiFormer returned an invalid native record envelope")
        return body


class NativeCounter:
    def __init__(self, backend: GLiFormerFields, info: dict):
        self.backend, self.info = backend, info
        self.context_tokens = info["max_input_tokens"]
        if type(self.context_tokens) is not int or self.context_tokens <= 0:
            raise ValueError("GLiFormer service reports no input token capacity")

    def identity(self) -> dict:
        return {"source": "gliformer:/tokenize", **self.info["identity"]}

    def request_tokens(self, system: str, user: str, schema: dict | None = None) -> int:
        if system or schema is None:
            raise ValueError("GLiFormer counts native text and schema, not chat prompts")
        response = requests.post(f"{self.backend.url.rstrip('/')}/tokenize", timeout=60,
                                 json={"text": user, "schema": schema, "identity": self.info["identity"]})
        response.raise_for_status()
        body = response.json()
        if body.get("identity") != self.info["identity"] or type(body.get("count")) is not int or body["count"] < 0:
            raise ValueError("GLiFormer returned a foreign or invalid token count")
        return body["count"]


def read_entry(backend: GLiFormerFields, counter: NativeCounter, schema: Schema, entry: dict,
               texts: dict[str, str], *, ceiling: int, overlap: int, check, number: int) -> tuple[list, list]:
    """Window only inside a settled entry; never inject its discovered label or neighboring text."""
    shape = native_schema(schema)
    units = [Unit(row["segment"], row["start"], row["end"]) for row in entry["ranges"]]

    def source(window):
        shown = [*window.before, *window.primary, *window.after]
        return "\n".join(texts[u.segment][u.start:u.end] for u in shown), ranges_json(shown)

    def fits(window):
        check()
        return counter.request_tokens("", source(window)[0], shape) <= ceiling

    windows = plan(units, texts, fits, overlap=overlap)
    if windows is None:
        raise ValueError("GLiFormer schema and one source character exceed the input budget")
    outputs, calls = [], []
    for window in windows:
        check()
        text, ranges = source(window)
        count = counter.request_tokens("", text, shape)
        if count > ceiling:
            raise ValueError("GLiFormer request exceeds its pinned input budget")
        reply, call = structure(backend, record=number, text=text, schema=shape, identity=counter.info["identity"],
                                counted=count, context=counter.context_tokens)
        outputs.append({**reply, "ranges": ranges, "input_text": text})
        calls.append(call)
    return outputs, calls


def leaves(value, path=()):
    """Paths of populated predictions, for explicit ungrounded accounting; never alters values."""
    if isinstance(value, dict):
        for key, child in value.items():
            yield from leaves(child, (*path, key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from leaves(child, (*path, index))
    elif value is not None and value != "":
        yield list(path)

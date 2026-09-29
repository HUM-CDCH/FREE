"""One discovery request over the first LINES source lines of `big`, rendered and sent as `discovery.discover` sends
it, with its raw reply and that reply's tokens written to /out/raw-reply-LINES.json: where the output tokens go.

  run.sh raw /repo/docs/plans/2026-09-29-unified-discovery-loop/raw_reply.py [LINES]
"""
import collections
import json
import runpy
import sys
import tempfile
from pathlib import Path

import requests

from kei_exp.kie.extract import discovery
from kei_exp.kie.extract.llm import THINKING_OFF, OpenAIChat
from kei_exp.kie.passages import load
from tests.helpers import catalogue

lines = int(sys.argv[1]) if len(sys.argv) > 1 else 40
spec = runpy.run_path(str(Path(__file__).with_name("measure.py")))["generated"]("big")
evidence = load(catalogue.write(spec["case"], Path(tempfile.mkdtemp())))
texts = {passage.id: passage.text for passage in evidence.passages}
units = discovery.units_of(evidence.passages)
window = discovery.Window(tuple(units[:lines]), after=tuple(units[lines:lines + 1]))
system = discovery.DISCOVERY.format(description=spec["schema"]["recordDescription"])
user, labels = discovery._render(window, texts)
chat = OpenAIChat()
reply = chat.complete(system=system, user=user, schema=discovery._reply(labels), max_tokens=4096)
base = chat.url.removesuffix("/v1/chat/completions")
tokens = requests.post(f"{base}/tokenize", json={"model": chat.model, "prompt": reply.text,
                                                 "return_token_strs": True}, timeout=60).json()
pieces = tokens.get("token_strs") or []
out = {"lines": lines, "user": user, "reply": reply.text, "input_tokens": reply.input_tokens,
       "output_tokens": reply.output_tokens, "finish": reply.finish, "seconds": round(reply.seconds, 1),
       "chat_template_kwargs": THINKING_OFF, "token_strs": pieces,
       "blank_tokens": sum(not piece.strip(" \n\tĠĊ") for piece in pieces),
       "places": len((json.loads(reply.text) if reply.finish == "stop" else {}).get("places", []))}
Path(f"/out/raw-reply-{lines}.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
print(json.dumps({key: out[key] for key in ("lines", "input_tokens", "output_tokens", "finish", "seconds",
                                            "blank_tokens", "places")}))
print(reply.text[:3000])
print(collections.Counter(pieces).most_common(30))

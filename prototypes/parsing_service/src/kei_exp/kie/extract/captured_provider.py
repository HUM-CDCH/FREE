"""Version 1 transport: send the saved HTTP body without recomposition; a streamed call adds only the provider's
stream and usage options."""
from collections.abc import Callable
from dataclasses import dataclass
import json
import time

import requests

from kei_exp.kie.extract.llm import UNSUPPORTED, Reply, _reply


class FormatRefused(Exception):
    """A saved refusal allows a separate, captured format fallback."""


@dataclass
class CapturedChat:
    provider: dict
    payload: dict
    # Given, the reply is streamed and each piece of its text handed here as it is generated: a view while the call
    # runs. Only the transport changes; the reply is read and saved as the unstreamed request's.
    on_text: Callable[[str], None] | None = None

    @property
    def model(self):
        return self.provider["model"]

    def complete(self, **_logical_request):
        started=time.monotonic()
        if self.on_text is not None:
            return self._streamed(started)
        response=requests.post(self.provider["url"],json=self.payload,timeout=self.provider["timeout"])
        if "response_format" in self.payload and response.status_code==400 and UNSUPPORTED.search(response.text):
            raise FormatRefused()
        return _reply(response,started,())

    def _streamed(self, started):
        body={**self.payload,"stream":True,"stream_options":{"include_usage":True}}
        with requests.post(self.provider["url"],json=body,timeout=self.provider["timeout"],stream=True) as response:
            if "response_format" in self.payload and response.status_code==400 and UNSUPPORTED.search(response.text):
                raise FormatRefused()
            if not response.headers.get("content-type","").startswith("text/event-stream"):
                return _reply(response,started,())  # a server that ignores the stream answers once, as unstreamed
            response.raise_for_status()
            text,finish,usage=[],None,{}
            for line in response.iter_lines():
                # Server-sent events; a line never splits a UTF-8 character.
                data=line.decode("utf-8").removeprefix("data:").strip() if line.startswith(b"data:") else ""
                if not data or data=="[DONE]":
                    continue
                chunk=json.loads(data)
                usage=chunk.get("usage") or usage
                for choice in chunk.get("choices") or ():
                    piece=(choice.get("delta") or {}).get("content") or ""
                    if piece:
                        text.append(piece)
                        self.on_text(piece)
                    finish=choice.get("finish_reason") or finish
        return Reply(text="".join(text),input_tokens=usage.get("prompt_tokens"),output_tokens=usage.get("completion_tokens"),
                     finish=finish,seconds=time.monotonic()-started)

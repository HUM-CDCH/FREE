"""Version 1 transport: send the saved HTTP body without recomposition."""
from dataclasses import dataclass
import time

import requests

from kei_exp.kie.extract.llm import UNSUPPORTED, _reply


class FormatRefused(Exception):
    """A saved refusal allows a separate, captured format fallback."""


@dataclass
class CapturedChat:
    provider: dict
    payload: dict

    @property
    def model(self):
        return self.provider["model"]

    def complete(self, **_logical_request):
        started=time.monotonic()
        response=requests.post(self.provider["url"],json=self.payload,timeout=self.provider["timeout"])
        if "response_format" in self.payload and response.status_code==400 and UNSUPPORTED.search(response.text):
            raise FormatRefused()
        return _reply(response,started,())

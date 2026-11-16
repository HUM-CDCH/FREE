"""Each Extraction Strategy's implementation is called with evidence already loaded and returns the finished artifact.

`run.extract` loads the evidence, checks its generation and hands it, with the request, the router and the caller's
`counter` and `chunks`, to the implementation the options choose. The implementations are called
here directly, with no `run.load` to replace.
"""
from dataclasses import replace

import pytest

from kei_exp.kie.extract import article, assembly, unified, run
from kei_exp.kie.extract.models import Router, as_router
from kei_exp.kie.passages import load
from tests.helpers import catalogue
from tests.helpers.chat import FakeChat
from tests.test_extract_stages import SCHEMA, FixedCounter, evidence




def test_article_reads_the_evidence_it_is_given():
    def script(system, user, schema):
        if "title" in schema["properties"]:
            return {"title": None}
        if "entry_no" in schema["properties"]:
            return {"entry_no": "31", "site": "Hjortlund", "year": None, "finds": None}
        return {claim: "NONE" for claim in schema["properties"]}  # grounding: no passage supports a claim
    request = run.ExtractRequest(schema=SCHEMA, options={"strategy": "article"})
    counter = {role: FixedCounter() for role in ("fields", "reasoning")}
    result = article.extract(None, evidence(), request, as_router(FakeChat(script)), counter=counter)
    assert result["strategy"] == "article" and result["extraction_version"] == assembly.EXTRACTION_VERSION
    assert "inventory" not in result
    assert [call["stage"] for call in result["calls"]] == ["document", "record", "grounding"]
    assert result["ungrounded"] == [["records", 0, "entry_no"], ["records", 0, "site"]]
    assert "method_version" in result and result["complete"] is False
    assert result["fingerprint"] == assembly.fingerprint(result, request, result["models"])




@pytest.mark.parametrize("options, chosen", [
    ({"strategy": "catalog"}, unified),
    ({"strategy": "article"}, article)])
def test_extract_hands_the_loaded_evidence_to_the_implementation_the_options_choose(monkeypatch, tmp_path, options,
                                                                                    chosen):
    run_dir = catalogue.write("two-in-one-segment", tmp_path / "run")
    received = []
    for module in (article, unified):
        monkeypatch.setattr(module, "extract", lambda *args, _module=module, **kwargs: received.append(
            (_module, args, kwargs)) or {"artifact": _module.__name__, "records": [{}]})
    request = run.ExtractRequest(schema=SCHEMA, options=options)
    chat, counter = FakeChat(lambda *_: None), object()
    result = run.extract(run_dir, request, chat, counter=counter, chunks=3)
    assert result == {"artifact": chosen.__name__, "records": [{}]}
    assert received == [(chosen, (run_dir, load(run_dir), request, Router(chat, chat)),
                         {"counter": counter, "chunks": 3})]

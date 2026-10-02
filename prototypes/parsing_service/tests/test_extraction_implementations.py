"""Each Extraction Strategy's implementation is called with evidence already loaded and returns the finished artifact.

`run.extract` loads the evidence, checks its generation and hands it, with the request, the router and the caller's
`counter`, `chunks` and `before_entry`, to the implementation the options choose. The implementations are called
here directly, with no `run.load` to replace.
"""
from dataclasses import replace

import pytest

from kei_exp.kie.extract import article, assembly, catalog, grounded, run
from kei_exp.kie.extract.models import Router, as_router
from kei_exp.kie.passages import load
from tests.helpers import catalogue
from tests.helpers.chat import FakeChat
from tests.test_extract_grounded import CountingChat, WordCounter, honest
from tests.test_extract_grounded import request as recipe_request
from tests.test_extract_stages import SCHEMA, FixedCounter, evidence


def test_the_version_1_catalog_reads_the_evidence_it_is_given():
    def script(system, user, schema):
        if "starts" in schema["properties"]:
            return {"starts": ["B2", "B4"], "end": "B5"}
        if "title" in schema["properties"]:
            return {"title": "Fund fra Hjortlund"}
        if "C1" in schema["properties"]:
            return {"C1": "E1"}  # grounding: each record's number is in its first passage
        return {"entry_no": "31" if "31." in user else "32", "site": None, "year": None, "finds": None}
    request = run.ExtractRequest(schema=SCHEMA)
    checks = []
    result = catalog.extract(None, evidence(), request, as_router(FakeChat(script)),
                             before_entry=lambda: checks.append("check"))
    assert result["strategy"] == "catalog" and result["extraction_version"] == assembly.EXTRACTION_VERSION == 1
    assert [(record["entry_no"], record["title"], record["filename"]) for record in result["records"]] == [
        ("31", "Fund fra Hjortlund", "beier.pdf"), ("32", "Fund fra Hjortlund", "beier.pdf")]
    assert [call["stage"] for call in result["calls"]] == [
        "document", "discovery", "record", "record", "grounding", "grounding"]
    assert [(link["path"], link["linked_by"]) for link in result["evidence"]] == [
        (["records", 0, "entry_no"], "model"), (["records", 1, "entry_no"], "model")]
    assert result["complete"] is True and result["unverified"] == ["title"]
    # the document call, the discovery call, then each record's extraction, verification and grounding batch
    assert len(checks) == 8
    assert result["fingerprint"] == assembly.fingerprint(result, request, result["models"])


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
    assert result["inventory"] == [{"identity": {}, "label": article.DOCUMENT_LABEL,
                                    "passages": [p.id for p in evidence().passages]}]  # the document, no inventory
    assert [call["stage"] for call in result["calls"]] == ["document", "record", "grounding"]
    assert result["ungrounded"] == [["records", 0, "entry_no"], ["records", 0, "site"]]
    assert "method_version" not in result and result["complete"] is False
    assert result["fingerprint"] == assembly.fingerprint(result, request, result["models"])


def test_the_recipe_catalog_reads_the_evidence_it_is_given(tmp_path):
    run_dir = catalogue.write("two-in-one-segment", tmp_path / "run")
    given = replace(load(run_dir), run_id="given")  # the artifact names the evidence it was handed, not the directory
    request = recipe_request()
    result = grounded.extract(run_dir, given, request, as_router(CountingChat(honest)), counter=WordCounter())
    assert result["run_id"] == "given" and result["extraction_version"] == grounded.EXTRACTION_VERSION == 2
    assert len(result["records"]) == 2 and [call["stage"] for call in result["calls"]] == ["entry", "entry"]
    assert len(list(run_dir.glob("segmentations/*/segmentation.json"))) == 1  # computed and published there
    assert result["fingerprint"] == grounded.fingerprint(result, result["generation"], result["digest"],
                                                         request.schema_, request.options.dumped(), result["models"])


@pytest.mark.parametrize("options, chosen", [
    ({"strategy": "catalog"}, catalog),
    ({"strategy": "article"}, article),
    ({"strategy": "catalog", "catalog": {"recipe": "numbered-catalogue-de@1"}}, grounded)])
def test_extract_hands_the_loaded_evidence_to_the_implementation_the_options_choose(monkeypatch, tmp_path, options,
                                                                                    chosen):
    run_dir = catalogue.write("two-in-one-segment", tmp_path / "run")
    received = []
    for module in (article, catalog, grounded):
        monkeypatch.setattr(module, "extract", lambda *args, _module=module, **kwargs: received.append(
            (_module, args, kwargs)) or {"artifact": _module.__name__, "records": [{}]})
    request = run.ExtractRequest(schema=SCHEMA, options=options)
    chat, counter, hook = FakeChat(lambda *_: None), object(), lambda: None
    result = run.extract(run_dir, request, chat, generation=catalogue.GENERATION, counter=counter, chunks=3,
                         before_entry=hook)
    assert result == {"artifact": chosen.__name__, "records": [{}]}
    assert received == [(chosen, (run_dir, load(run_dir), request, Router(chat, chat)),
                         {"counter": counter, "chunks": 3, "before_entry": hook})]

"""The unified Catalog against the deployed extraction models, routed as the worker routes them: boundaries across a
column, a spread and a PDF page, every nonblank character accounted for, every call within its stage's pinned
ceiling, and a re-execution that reuses its published discovery. Smoke evidence, not the evaluation of tasks 1.4 and
6.2: an accepted value that is wrong fails; a proposal or a missing value is printed.
Live: needs `KEI_EXTRACT_URL` and `KEI_EXTRACT_MODEL`; the default routing also `KEI_NUEXTRACT_URL`."""
import os

import pytest

from kei_exp.kie.extract import run
from kei_exp.kie.extract.models import chats_for
from kei_exp.kie.passages import load
from tests.helpers import catalogue
from tests.test_unified_catalog import assert_accounted, assert_links_resolve

pytestmark = [pytest.mark.live_model,
              pytest.mark.skipif(not os.environ.get("KEI_EXTRACT_URL"), reason="set KEI_EXTRACT_URL")]

SCHEMA = {"recordDescription": "One numbered entry of an archaeological catalogue.", "schemaNodes": [
    {"id": "n", "name": "entry_no", "type": "integer"},
    {"id": "s", "name": "site_name", "type": "string", "description": "the find place right after the number"},
    {"id": "b", "name": "bezirk", "type": "string"},
    {"id": "k", "name": "kreis", "type": "string"},
    {"id": "f", "name": "fundart", "type": "string", "description": "the find category after FA:"},
]}
EXPECTED = [{"entry_no": 40, "site_name": "Aue", "bezirk": "Süd", "kreis": "Moor", "fundart": "G"},
            {"entry_no": 41, "site_name": "Bach", "bezirk": "Süd", "kreis": "Moor", "fundart": "EF"},
            {"entry_no": 42, "site_name": "Dorf", "bezirk": "Süd", "kreis": "Moor", "fundart": "G"},
            {"entry_no": 43, "site_name": "Eck", "bezirk": "Süd", "kreis": "Ried", "fundart": "EF"}]


@pytest.mark.parametrize("models", [None, {"fields": "instruct"}], ids=["deployment-routing", "instruct-only"])
def test_a_real_model_finds_the_entries_and_accounts_for_every_character(tmp_path, models):
    if models is None and not os.environ.get("KEI_NUEXTRACT_URL"):
        pytest.skip("the deployment routing needs KEI_NUEXTRACT_URL")
    run_dir = catalogue.write("continuations", tmp_path)
    request = run.ExtractRequest.model_validate({"schema": SCHEMA, "options": {
        "strategy": "catalog", "unified": {"defaults": 1}, **({"models": models} if models else {})}})
    result = run.extract(run_dir, request, chats_for(request.options), extraction_id="live")
    assert result["extraction_version"] == 3
    assert_links_resolve(result)
    assert_accounted(load(run_dir), result)
    codes = {issue["code"] for issue in result["issues"]}
    assert not codes & {"budget_refused", "budget_count_mismatch"}, result["issues"]
    stages = result["execution"]["effective"]["stages"]
    assert all(call["input_tokens"] <= stages[call["stage"]]["input_tokens"] for call in result["calls"]
               if call["input_tokens"] is not None)
    assert all(pinned["model"] and pinned["context_tokens"] for pinned in result["execution"]["tokenizers"].values())
    print({"models": result["models"], "calls": len(result["calls"]), "tokens": result["tokens"],
           "seconds": result["seconds"], "completeness": result["completeness"], "codes": sorted(codes),
           "labels": [entry["label"] for entry in result["discovery"]["entries"]],
           "records": result["records"], "proposed": [(item["path"], item.get("value")) for item in result["proposed"]],
           "rejected": [(item["path"], item.get("reason")) for item in result["rejected"]]})
    assert len(result["records"]) == 4, result["discovery"]["entries"]
    for got, expected in zip(result["records"], EXPECTED, strict=True):
        for name, value in expected.items():  # a trailing period is normalisation, not a wrong value
            assert got.get(name) is None or str(got[name]).rstrip(".") == str(value), (name, got)
    assert result["completeness"]["processing"] is True, result["processing"]

    again = run.extract(run_dir, request, chats_for(request.options), extraction_id="live")
    assert again["discovery_sha256"] == result["discovery_sha256"]
    assert again["execution_sha256"] == result["execution_sha256"]
    assert len(again["records"]) == 4

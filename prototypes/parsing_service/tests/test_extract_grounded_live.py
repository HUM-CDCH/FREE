"""The grounded Catalog path against the deployed extraction model (plan M4 exit): continuation across a column, a
spread and a PDF page, inheritance under changing headings, key-verified fields, and every request within budget.
Live: needs `FREE_REAL_EXTRACT_URL` and `FREE_REAL_EXTRACT_MODEL`."""
import os

import pytest

from kei_exp.kie.extract.llm import OpenAIChat
from kei_exp.kie.extract.run import ExtractRequest, extract
from tests.helpers import catalogue

URL, MODEL = os.environ.get("FREE_REAL_EXTRACT_URL"), os.environ.get("FREE_REAL_EXTRACT_MODEL")
pytestmark = [pytest.mark.live_model,
              pytest.mark.skipif(not (URL and MODEL), reason="set FREE_REAL_EXTRACT_URL and FREE_REAL_EXTRACT_MODEL")]

SCHEMA = {"recordDescription": "One numbered entry of an archaeological catalogue.", "schemaNodes": [
    {"id": "n", "name": "entry_no", "type": "integer"},
    {"id": "s", "name": "site_name", "type": "string", "description": "the find place right after the number"},
    {"id": "b", "name": "bezirk", "type": "string"},
    {"id": "k", "name": "kreis", "type": "string"},
    {"id": "f", "name": "fundart", "type": "string", "description": "the find category after FA:"},
]}


def test_a_real_model_extracts_grounded_records_across_columns_spreads_and_pages(tmp_path):
    run_dir = catalogue.write("continuations", tmp_path)
    request = ExtractRequest.model_validate({"schema": SCHEMA, "options": {
        "strategy": "catalog", "catalog": {"recipe": "numbered-catalogue-de@1"}}})
    result = extract(run_dir, request, OpenAIChat(url=URL, model=MODEL))
    records = result["records"]
    assert [record["entry_no"] for record in records] == [40, 41, 42, 43]
    assert [(record["bezirk"], record["kreis"]) for record in records] == [
        ("Süd", "Moor"), ("Süd", "Moor"), ("Süd", "Moor"), ("Süd", "Ried")]
    # The raw value is what follows the key; whether a trailing period is punctuation or part of an abbreviation
    # ("Siedl.") is normalisation (plan M7), so the comparison ignores it.
    assert [(record["fundart"] or "").rstrip(".") for record in records] == ["G", "EF", "G", "EF"]
    codes = {issue["code"] for issue in result["issues"]}
    assert "budget_count_mismatch" not in codes and "budget_refused" not in codes, result["issues"]
    assert result["completeness"]["processing"] is True, result["calls"]
    assert all(call["input_tokens"] <= 4096 for call in result["calls"])
    assert result["budget"]["tokenizer"]["model_digest"]
    print({"calls": len(result["calls"]), "tokens": result["tokens"], "proposed": len(result["proposed"]),
           "rejected": [(item["path"], item["reason"]) for item in result["rejected"]]})

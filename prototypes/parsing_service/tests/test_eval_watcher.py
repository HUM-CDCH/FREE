"""The developer evaluation watcher's pure decisions: gold columns -> schema, workbook, config."""
from __future__ import annotations

from pathlib import Path

import pytest

from experiments.extraction import eval_watcher, iterative_eval
from kei_exp.kie.extract.schema import Schema

COLUMNS = [
    {"columnName": "filename"},
    {"columnName": "sample_name"},
    {"columnName": "amino_acid_hydroxyproline_value"},
]


def test_field_names_drop_the_file_name_column() -> None:
    assert eval_watcher.field_names(COLUMNS) == ["sample_name", "amino_acid_hydroxyproline_value"]
    assert eval_watcher.field_names([{"columnName": "FILENAME"}, {"columnName": "a"}]) == ["a"]


def test_schema_from_gold_is_the_article_document_scope_by_default() -> None:
    schema = eval_watcher.schema_from_gold(COLUMNS)
    assert schema["recordScope"] == "document"
    assert [node["name"] for node in schema["schemaNodes"]] == [
        "sample_name",
        "amino_acid_hydroxyproline_value",
    ]
    assert [node["type"] for node in schema["schemaNodes"]] == ["string", "string"]
    Schema.model_validate(schema)  # the service's own schema validator accepts it


def test_schema_from_gold_catalog_scope_and_unique_ids() -> None:
    schema = eval_watcher.schema_from_gold(
        [{"columnName": "Nr."}, {"columnName": "Nr"}, {"columnName": "title"}], strategy="catalog"
    )
    assert schema["recordScope"] == "records"
    ids = [node["id"] for node in schema["schemaNodes"]]
    assert len(set(ids)) == len(ids)
    with pytest.raises(ValueError):
        eval_watcher.schema_from_gold([{"columnName": "filename"}])
    with pytest.raises(ValueError):
        eval_watcher.schema_from_gold(COLUMNS, strategy="unknown")


def test_write_gold_workbook_round_trips_through_load_gold(tmp_path: Path) -> None:
    path = tmp_path / "gold.xlsx"
    eval_watcher.write_gold_workbook(
        path,
        COLUMNS,
        [
            {"filename": "a.pdf", "sample_name": "Alpha",
             "amino_acid_hydroxyproline_value": "12"},
            {"filename": "a.pdf", "sample_name": "Beta",
             "amino_acid_hydroxyproline_value": "7"},
        ],
    )
    gold = iterative_eval.load_gold(path)
    assert gold["fields"] == ["sample_name", "amino_acid_hydroxyproline_value"]
    assert gold["documents"]["a"] == [
        {"sample_name": ["Alpha"], "amino_acid_hydroxyproline_value": ["12"]},
        {"sample_name": ["Beta"], "amino_acid_hydroxyproline_value": ["7"]},
    ]


def test_write_gold_workbook_strips_xml_illegal_characters(tmp_path: Path) -> None:
    path = tmp_path / "gold.xlsx"
    eval_watcher.write_gold_workbook(
        path,
        COLUMNS,
        [{"filename": "a.pdf", "sample_name": "collagen\x0bdissolved", "amino_acid_hydroxyproline_value": "5"}],
    )
    gold = iterative_eval.load_gold(path)
    assert gold["documents"]["a"][0]["sample_name"] == ["collagen dissolved"]


def test_pipeline_config_carries_runs_identity_and_exhaustiveness(tmp_path: Path) -> None:
    config = eval_watcher.pipeline_config(
        eval_id="demo",
        schema_path=tmp_path / "schema.json",
        golden_path=tmp_path / "gold.xlsx",
        documents=["a.pdf", "b.pdf"],
        runs={"a": "runs/a", "b": "runs/b"},
        providers={"fields": {"base_url": "http://x", "model": "f"}},
        output=tmp_path / "out",
        strategy="article",
        exhaustive=True,
        identity=["amino_acid_hydroxyproline_value"],
    )
    assert config["options"] == {"strategy": "article"}
    assert config["documents"] == ["a.pdf", "b.pdf"]
    assert config["runs"] == {"a": "runs/a", "b": "runs/b"}
    assert config["identity"] == ["amino_acid_hydroxyproline_value"]
    assert config["exhaustive"] is True
    assert "identity" not in eval_watcher.pipeline_config(
        eval_id="demo", schema_path="s", golden_path="g", documents=[], providers={}, output="o"
    )


def test_run_id_from_preprocess_reads_only_the_kei_run() -> None:
    assert eval_watcher.run_id_from_preprocess("kei-exp:run-1:g1") == "run-1"
    assert eval_watcher.run_id_from_preprocess("kei-exp:a.b_c-d:20260926") == "a.b_c-d"
    for malformed in ["other:run:g", "kei-exp::g", "kei-exp:run", "kei-exp:run:", "kei-exp:run/g:g"]:
        assert eval_watcher.run_id_from_preprocess(malformed) is None


def test_base_url_of_strips_the_chat_completions_path() -> None:
    assert eval_watcher.base_url_of("http://extraction_model:8000/v1/chat/completions") == (
        "http://extraction_model:8000"
    )
    assert eval_watcher.base_url_of("http://extraction_model:8000") == "http://extraction_model:8000"


def test_providers_from_env_defaults_to_the_deployment_extraction_server() -> None:
    assert eval_watcher.providers_from_env({
        "KEI_EXTRACT_URL": "http://extraction_model:8000/v1/chat/completions",
        "KEI_EXTRACT_MODEL": "Qwen/Qwen3.8-27B-FP8",
    }) == {
        "fields": {"base_url": "http://extraction_model:8000", "model": "Qwen/Qwen3.8-27B-FP8"},
        "reasoning": {"base_url": "http://extraction_model:8000", "model": "Qwen/Qwen3.8-27B-FP8"},
    }
    split = eval_watcher.providers_from_env({
        "KEI_EXTRACT_URL": "http://a:8000/v1/chat/completions",
        "KEI_EXTRACT_MODEL": "m",
        "FREE_EVAL_FIELDS_URL": "http://b:8000",
        "FREE_EVAL_FIELDS_MODEL": "f",
    })
    assert split["fields"] == {"base_url": "http://b:8000", "model": "f"}
    assert split["reasoning"] == {"base_url": "http://a:8000", "model": "m"}

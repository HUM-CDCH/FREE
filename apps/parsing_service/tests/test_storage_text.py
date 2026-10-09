"""JSONB storage must not change the request sent to the provider."""
from copy import deepcopy
import json
from pathlib import Path

from kei_exp.workflows.storage_text import encode_storage, decode_storage


def test_request_and_output_keep_nul_distinct_from_literal_escapes():
    text = 'cm\x00 1; literal \\u0000; λ⁻¹; ~free-jsonb-string-v1~"literal"'
    request = {"provider": {"model": "stub"}, "composer": 1, "tokenizer": {"model": "stub"},
               "budget": {}, "examples": [], "omissions": [],
               "body": {"record": 0, "stage": "record", "user": text, "system": "instructions",
                        "httpRequest": {"model": "stub", "messages": [{"role": "user", "content": text}]}}}
    before = deepcopy(request)
    stored = encode_storage(request)
    assert "\\u0000" not in json.dumps(stored).replace("\\\\u0000", "")
    assert set(stored) == set(request)
    assert set(stored["body"]) == set(request["body"])
    assert stored["body"]["record"] == 0
    assert decode_storage({"input": {"request": stored}})["input"]["request"] == request
    assert request == before
    output = {"parsed": {"content": text}, "calls": [{"raw": text}]}
    assert decode_storage(encode_storage(output)) == output


def test_snapshot_values_and_correction_candidates_round_trip():
    value = {"id": "v1", "modelValue": "\x00", "evidence": [{"producer": {"quote": "a\x00b"}}]}
    snapshot = {"values": encode_storage([value]), "coverage": {"complete": True}}
    assert decode_storage(snapshot)["values"] == [value]
    candidate = {"id": "c1", "value": "\x00"}
    request = {"provider": {}, "composer": 1, "tokenizer": {}, "budget": {}, "omissions": [],
               "examples": [candidate], "body": {"user": "\x00"}}
    assert encode_storage(request)["examples"] == [encode_storage(candidate)]
    assert decode_storage(encode_storage(request)) == request


def test_legacy_plain_documents_and_prefix_text_are_not_decoded():
    plain = {"body": {"user": '~free-jsonb-string-v1~"literal"'}, "other": "\\u0000"}
    assert decode_storage(plain) == plain
    assert encode_storage({"ordinary": "cm⁻¹"}) == {"ordinary": "cm⁻¹"}
    assert decode_storage(encode_storage(plain)) == plain
    literal_object = {"parsed": {"_freeJsonbStrings": 1, "value": "literal"}}
    assert decode_storage(literal_object) == literal_object


def test_shared_storage_fixtures_keep_unicode_and_all_original_keys():
    path = Path(__file__).resolve().parents[3] / "packages/extraction/src/testing/storage-text.json"
    for fixture in json.loads(path.read_text()):
        assert encode_storage(fixture["original"]) == fixture["stored"]
        assert decode_storage(fixture["stored"]) == fixture["original"]

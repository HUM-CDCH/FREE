"""The portable contract of kei's workflows, as the fixtures Studio's node:test also reads (M4)."""

import pytest
import requests
from dbos import error as dbos_error
from pydantic import ValidationError

from kei_exp import runs
from kei_exp.failures import CODES, REASON_CHARS, KeiFailure
from kei_exp.kie.extract.run import ExtractRequest
from kei_exp.workflows import config, contracts
from tests.helpers.contracts import convert_timeout_ms, fixture
from tests.test_extract_grounded import SCHEMA

INPUTS = {"convert": contracts.ConvertInput, "extract": contracts.ExtractInput,
          "deleteRuns": contracts.DeleteRunsInput}
OUTPUTS = {"convert.output.ok": contracts.ConvertOk, "convert.output.failed": contracts.Failure,
           "extract.output.ok": contracts.ExtractOk, "extract.output.failed": contracts.Failure,
           "deleteRuns.output": contracts.DeleteRunsOk}


@pytest.mark.parametrize("workflow", INPUTS)
def test_each_input_fixture_is_a_valid_request_for_a_known_queue(workflow):
    data = fixture(f"{workflow}.input")
    queues = fixture("queues")
    # A round trip: every field is spelled out in the fixture, none is left to a default Studio might not send.
    assert INPUTS[workflow].model_validate(data["request"]).model_dump(mode="json") == data["request"]
    assert data["enqueue"]["workflow_name"] == workflow
    assert data["enqueue"]["queue_name"] in queues["queues"]
    assert data["enqueue"]["application_name"] == config.APP_NAME
    assert data["enqueue"]["workflow_id"].startswith(queues["workflow_id_prefixes"][workflow])


def test_the_extract_fixture_carries_a_request_kei_accepts():
    body = fixture("extract.input")["request"]["request"]
    request = ExtractRequest.model_validate(body)
    assert body["schema"] == SCHEMA
    assert [node.name for node in request.schema_.nodes] == [node["name"] for node in SCHEMA["schemaNodes"]]
    assert request.options.strategy == "catalog"
    assert request.options.catalog is not None and request.options.catalog.recipe == "numbered-catalogue-de@1"


@pytest.mark.parametrize("name", OUTPUTS)
def test_each_output_fixture_validates(name):
    data = fixture(name)
    assert OUTPUTS[name].model_validate(data).model_dump(mode="json") == data


@pytest.mark.parametrize(("name", "change"), [
    ("convert.output.ok", {"page_count": 0}),
    ("convert.output.ok", {"generation": ""}),
    ("extract.output.ok", {"generation": ""}),
])
def test_an_output_without_pages_or_a_generation_is_refused(name, change):
    """As strict as ExtractInput and Studio's zod mirror (M4): a published parse has a page and names its generation."""
    with pytest.raises(ValidationError):
        OUTPUTS[name].model_validate({**fixture(name), **change})


def test_the_failure_codes_are_the_contracts():
    assert contracts.Failure.model_fields["code"].annotation.__args__ == CODES


def test_the_queue_fixture_is_the_worker_configuration():
    queues = fixture("queues")
    assert (queues["application_name"], queues["schema"], queues["application_version"]) == \
        (config.APP_NAME, config.SCHEMA, config.APP_VERSION)
    assert {name: (q["global_concurrency"], q["worker_concurrency"]) for name, q in queues["queues"].items()} == \
        {name: (limit, limit) for name, limit in config.QUEUES.items()}
    assert queues["priorities"] == {"interactive": config.PRIORITY_INTERACTIVE, "batch": config.PRIORITY_BATCH}
    assert queues["workflow_id_prefixes"] == {"convert": contracts.CONVERT_PREFIX, "extract": contracts.EXTRACT_PREFIX,
                                              "deleteRuns": contracts.GC_PREFIX}


def test_the_deadline_fixture_is_m0r4s_formula():
    deadlines = fixture("deadlines")
    assert [[pages, convert_timeout_ms(pages)] for pages, _ in deadlines["convert"]["cases"]] == \
        deadlines["convert"]["cases"]
    assert deadlines["extract"] == {"article": 10 * 60_000, "catalog": 3 * 3_600_000}


@pytest.mark.parametrize("request_", [
    {"source": "a.pdf", "source_sha256": "0" * 64, "source_name": "a.pdf", "pages": [1, 2]},
    {"source": "a.pdf", "source_sha256": "XYZ", "source_name": "a.pdf"},
    {"source": "a.pdf", "source_sha256": "0" * 64, "source_name": "a.pdf", "page_source": "spread"},
])
def test_a_malformed_convert_request_is_refused(request_):
    with pytest.raises(ValidationError):
        contracts.ConvertInput.model_validate(request_)


def test_run_and_extraction_ids_are_single_path_components():
    assert contracts.extraction_id_of("kei-extract:x-1") == "x-1"
    for bad in ("kei-extract:../x", "kei-extract:", "kei-convert:x", "kei-extract:a/b"):
        with pytest.raises(contracts.KeiFailure):
            contracts.extraction_id_of(bad)


def test_the_delete_runs_fixture_names_a_conversion_and_the_run_kei_derives_from_it():
    request = fixture("deleteRuns.input")["request"]
    contracts.DeleteRunsInput.model_validate(request)
    output = contracts.DeleteRunsOk.model_validate(fixture("deleteRuns.output"))
    assert output.deleted_runs == [runs.run_id_for(request["conversions"][0])]
    assert output.deleted_history == [*request["history"], *request["conversions"]]


@pytest.mark.parametrize("request_", [
    {"conversions": ["../etc"], "history": []},                  # not a conversion: no run is derived from it
    {"conversions": ["kei-convert:"], "history": []},
    {"conversions": [], "history": ["kei-convert:ingest:p:a"]},  # a conversion's history goes with its run
    {"runs": ["run-0123456789abcdef01234567"], "history": []},   # Studio never names a run
])
def test_delete_runs_takes_conversions_and_other_history(request_):
    with pytest.raises(ValidationError):
        contracts.DeleteRunsInput.model_validate(request_)


def test_config_is_kei_with_patching_and_a_slot_executor():
    assert config.dbos_config("postgresql://kei:x@db:5432/free", "slot-1") == {
        "name": "kei", "system_database_url": "postgresql://kei:x@db:5432/free", "dbos_system_schema": "kei_dbos",
        "application_version": "kei@1", "executor_id": "kei-slot-1", "enable_patching": True, "log_level": "INFO"}


def raising(error: BaseException):
    def steps() -> dict:
        raise error
    return steps


def test_a_settled_workflow_returns_what_its_steps_returned():
    ok = {"ok": True, "deleted_runs": [], "kept_runs": [], "deleted_history": [], "kept_history": []}
    assert contracts.settled(lambda: ok, default="conversion_failed") is ok


def test_exhausted_transient_retries_settle_as_a_retryable_backend_failure():
    # After its last attempt DBOS raises DBOSMaxStepRetriesExceeded, not the step's own error (dbos/_outcome.py):
    # the code comes from the error that attempt met.
    exhausted = dbos_error.DBOSMaxStepRetriesExceeded("convert_run", 3, [requests.ConnectionError("refused")] * 3)
    assert contracts.settled(raising(exhausted), default="conversion_failed") == {
        "ok": False, "code": "model_unavailable", "reason": "ConnectionError: refused", "retryable": True}


def test_exhaustion_without_recorded_errors_settles_as_the_steps_own_failure():
    exhausted = dbos_error.DBOSMaxStepRetriesExceeded("extract_run", 3, [])
    settled = contracts.settled(raising(exhausted), default="extraction_failed")
    assert (settled["code"], settled["retryable"]) == ("extraction_failed", True)
    assert "extract_run" in settled["reason"]


@pytest.mark.parametrize(("error", "code", "reason"), [
    (KeiFailure("source_mismatch", "hashes differ"), "source_mismatch", "hashes differ"),
    (ValueError("no pages"), "conversion_failed", "no pages"),
    (KeyError("x"), "conversion_failed", "KeyError: 'x'"),
])
def test_a_refusal_or_a_failure_of_the_work_settles_as_not_retryable(error, code, reason):
    assert contracts.settled(raising(error), default="conversion_failed") == {
        "ok": False, "code": code, "reason": reason, "retryable": False}


def test_a_settled_reason_is_bounded():
    settled = contracts.settled(raising(KeiFailure("invalid_request", "x" * (REASON_CHARS + 50))), default="no_result")
    assert len(settled["reason"]) == REASON_CHARS
    assert len(contracts.failure("no_result", "y" * (REASON_CHARS + 1), retryable=False)["reason"]) == REASON_CHARS


@pytest.mark.parametrize("error", [
    dbos_error.DBOSException("a conflicting workflow ID"),
    dbos_error.DBOSWorkflowCancelledError("cancelled"),
])
def test_dboss_own_errors_and_cancellation_propagate(error):
    with pytest.raises(type(error)):
        contracts.settled(raising(error), default="conversion_failed")

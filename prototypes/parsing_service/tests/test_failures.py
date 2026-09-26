"""Which step failures DBOS retries, and what a workflow reports for the rest (spec, *kei worker*)."""
import json
import pickle

import pytest
import requests
from pydantic import BaseModel

from kei_exp.failures import CODES, STEP_RETRY, KeiFailure, TransientBackendError, classify, failure_of, should_retry
from kei_exp.kie.extract.run import StaleGeneration
from kei_exp.pagefile import ResultError
from kei_exp.transcription.types import ConversionError, IncompleteConversionError


def http_error(status: int) -> requests.HTTPError:
    response = requests.Response()
    response.status_code = status
    return requests.HTTPError(f"{status} from the server", response=response)


@pytest.mark.parametrize("error", [
    requests.ConnectionError("refused"), requests.Timeout("slow"), ConnectionError("reset"), TimeoutError("t"),
    ConversionError("the OCR server is unreachable"), ConversionError("503 Service Unavailable"),
    ConversionError("Surya failed; output not written: incomplete response, connection timed out"),
    http_error(429), http_error(502), http_error(503), http_error(504),
])
def test_a_backend_that_is_not_ready_is_retried(error):
    assert isinstance(classify(error), TransientBackendError)
    assert should_retry(error) is True


@pytest.mark.parametrize("error", [
    http_error(400), http_error(404), http_error(500), ValueError("bad page range"), KeyError("x"),
    IncompleteConversionError("Conversion incomplete; output not written: connection timed out on page 3"),
    ConversionError("layout cut failed"), KeiFailure("source_mismatch", "hashes differ"),
    requests.HTTPError("no response was attached"), AttributeError("'NoneType' object has no attribute 'page'"),
])
def test_a_failure_about_this_document_or_request_is_not_retried(error):
    assert classify(error) is error
    assert should_retry(error) is False  # a bool: DBOS reads a returned exception as True


def test_should_retry_is_a_bool_not_the_classified_exception():
    assert type(should_retry(ValueError("x"))) is bool and type(should_retry(TimeoutError("x"))) is bool


def test_the_step_retry_policy_is_three_attempts_waiting_five_then_ten_seconds():
    waits = [STEP_RETRY["interval_seconds"] * STEP_RETRY["backoff_rate"] ** attempt
             for attempt in range(STEP_RETRY["max_attempts"] - 1)]
    assert STEP_RETRY["retries_allowed"] is True and waits == [5.0, 10.0]
    assert STEP_RETRY["should_retry"] is should_retry


@pytest.mark.parametrize("error, default, code", [
    (KeiFailure("too_many_pages", "2001 pages"), "conversion_failed", "too_many_pages"),
    (IncompleteConversionError("page 2 was cut off"), "conversion_failed", "conversion_incomplete"),
    (http_error(503), "extraction_failed", "model_unavailable"),
    (ConversionError("the model server has 'x' loaded"), "conversion_failed", "conversion_failed"),
    (http_error(400), "extraction_failed", "extraction_failed"),
])
def test_a_final_step_error_maps_to_one_portable_code(error, default, code):
    found, reason = failure_of(error, default)
    assert found == code and found in CODES and reason


def test_a_validation_error_is_an_invalid_request():
    class Body(BaseModel):
        pages: int
    with pytest.raises(Exception) as caught:
        Body.model_validate({"pages": "many"})
    assert failure_of(caught.value, "extraction_failed")[0] == "invalid_request"


def test_every_failure_a_step_raises_survives_dbos_pickling():
    try:
        json.loads("{bad")
    except json.JSONDecodeError as error:
        decode = error
    for error in (KeiFailure("no_result", "none"), TransientBackendError("down"), http_error(503), decode,
                  ConversionError("x"), IncompleteConversionError("y"), StaleGeneration("z"), ResultError("r")):
        back = pickle.loads(pickle.dumps(error))
        assert type(back) is type(error) and str(back) == str(error)
    assert pickle.loads(pickle.dumps(KeiFailure("no_result", "none"))).code == "no_result"

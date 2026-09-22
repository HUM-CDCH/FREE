"""The replay helper rebuilds a recorded run's inputs so the writer can be driven without a model server."""
import pytest

from kei_exp.result import write_result
from tests.helpers.replay import replay


@pytest.mark.parametrize("name", ["surya-ingest-catalogue7", "surya-pdf-catalogue7"])
def test_recorded_surya_runs_replay(name, recorded, scan_pdf, tmp_path):
    played = replay(recorded(name), scan_pdf, tmp_path)
    assert [item.ordinal for item in played.inventory.inputs] == [1, 2, 3, 4]
    assert [record.page for record in played.outcome.pages] == [1, 2, 3, 4]
    manifest = write_result(played.outcome, played.execution, played.inventory, played.source,
                            ingest_digest=played.ingest_digest, directory=tmp_path / "result")
    assert manifest.status == "success" and manifest.incomplete is None


def test_recorded_native_run_replays(recorded, recorded_digital_pdf, tmp_path):
    played = replay(recorded("native-main"), recorded_digital_pdf, tmp_path)
    assert played.inventory.pages == [5, 6] and played.book is None
    assert [record.source_page for record in played.outcome.pages] == [5, 6]

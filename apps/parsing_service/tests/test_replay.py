"""The replay helper rebuilds a recorded run's inputs so the writer can be driven without a model server."""
from tests.helpers.replay import replay


def test_recorded_native_run_replays(recorded, recorded_digital_pdf, tmp_path):
    played = replay(recorded("native-main"), recorded_digital_pdf, tmp_path)
    assert played.inventory.pages == [5, 6] and played.book is None
    assert [record.source_page for record in played.outcome.pages] == [5, 6]

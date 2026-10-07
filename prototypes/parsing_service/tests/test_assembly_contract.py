"""Baseline characterization: do not reconcile the two accepted record orders."""
from unittest.mock import patch

import pytest

from kei_exp.kie.stages import ocr
from kei_exp.pagefile import load_result
from kei_exp.transcription.types import ConversionError
from tests.helpers.fake import FakeTranscriber
from tests.helpers.synthetic import execution, record, three_crops


@pytest.mark.parametrize('order', [(1, 2, 3), (3, 2, 1), (2, 3, 1)])
@pytest.mark.parametrize('persist', [False, True])
@pytest.mark.parametrize('incomplete', [False, True])
def test_orders_empty_page_and_incomplete(digital_pdf, tmp_path, order, persist, incomplete):
    crops, _ = three_crops()
    texts = {1: 'Grüße', 2: '| a | b |', 3: 'page two'}
    backend = FakeTranscriber()
    backend.records = [record(n, markdown=texts[n], text=texts[n],
                              incomplete='capped' if incomplete and n == 2 else None) for n in order]
    made = execution(digital_pdf, tmp_path, pages=(1, 3),
                     result_dir=tmp_path / 'result' if persist else None)
    with patch.dict(ocr.TRANSCRIBERS, surya=backend), patch.object(ocr, 'cut_pages', return_value=crops):
        if incomplete:
            with pytest.raises(ConversionError, match='capped'):
                ocr.run(made, lambda event: None)
        else:
            returned = ocr.run(made, lambda event: None)
            assert returned == '\n\n'.join([*(texts[n] for n in order if n != 3), texts[3]])
    if persist:
        loaded = load_result(made.result_dir)
        assert loaded.pages[1].markdown == 'Grüße\n\n| a | b |'
        assert loaded.pages[2].markdown == 'page two'
        assert loaded.pages[3].markdown == ''
        assert loaded.pages[3].segments == []
        assert loaded.pages[3].warnings == ['no content found by the layout cut']
        assert loaded.pages[1].complete is not incomplete
        assert [segment.text for segment in loaded.pages[1].segments] == [texts[1], texts[2]]
    else:
        assert not (tmp_path / 'result').exists()


def test_all_selected_pages_empty(digital_pdf, tmp_path):
    made = execution(digital_pdf, tmp_path, pages=(1, 2))
    with patch.object(ocr, 'cut_pages', return_value=[]), pytest.raises(ConversionError, match='found no content'):
        ocr.run(made, lambda event: None)
    loaded = load_result(made.result_dir)
    assert list(loaded.pages) == [1, 2]
    assert all(page.complete and not page.segments for page in loaded.pages.values())
    assert loaded.manifest.status == 'incomplete'


def test_missing_record_remains_an_adapter_bug(digital_pdf, tmp_path):
    crops, _ = three_crops()
    backend = FakeTranscriber()
    backend.records = [record(1)]
    made = execution(digital_pdf, tmp_path, pages=(1, 3))
    with (patch.dict(ocr.TRANSCRIBERS, surya=backend), patch.object(ocr, 'cut_pages', return_value=crops),
          pytest.raises(AssertionError, match='records are not the inputs')):
        ocr.run(made, lambda event: None)
    assert not made.result_dir.exists()

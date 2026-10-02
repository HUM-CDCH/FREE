"""The extract request takes no page scope: a sample was a workbench feature, removed on 2026-10-02."""
import pytest
from pydantic import ValidationError

from kei_exp.kie.extract.run import Options


def test_a_page_scope_is_refused_as_an_unknown_option():
    with pytest.raises(ValidationError):
        Options(strategy="article", pages=[1])


def test_dumped_options_carry_no_pages_key():
    assert "pages" not in Options(strategy="article").dumped()
    assert "pages" not in Options(strategy="catalog").dumped()

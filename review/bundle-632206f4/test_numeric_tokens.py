"""Desired regressions: these five cases FAIL at reviewed head 632206f4.
Uses the hash-verified resolver with the isolated fixtures in probes.py.
"""
import pytest
from probes import r, context

@pytest.mark.parametrize('token', ['-10', '\u221210', '1e-10', '.10'])
def test_positive_ten_is_not_another_numeric_tokens_suffix(token):
    shown = r['_shown'](10, context(f'A cited value was {token}.'))
    assert 'not printed verbatim' in shown, shown


def test_false_signed_hits_do_not_displace_the_real_positive_occurrence():
    text = ' '.join(
        f'Reference study {i} had -10 degrees. ' + 'Background. ' * 20
        for i in range(3)
    ) + 'Our study had 10 degrees.'
    shown = r['_shown'](10, context(text))
    assert 'Our study had 10 degrees' in shown, shown
    assert 'printed 4 times' not in shown

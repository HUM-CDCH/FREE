"""The portable contract fixtures (`tests/fixtures/contracts/`) and the conversion deadline Studio computes (M4)."""
import json
from pathlib import Path

FIXTURES = Path(__file__).parent.parent / "fixtures" / "contracts"


def fixture(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def convert_timeout_ms(pages: int) -> int:
    """M0R 4's per-page conversion budget; Studio's submitToKei computes the same (M4)."""
    return max(600_000, 3 * (20_000 + 6_300 * pages))

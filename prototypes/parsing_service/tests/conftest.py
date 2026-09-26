"""Self-contained test inputs and explicit PostgreSQL/model tiers for the imported backend."""
import json
import os
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _fixture_pdf(name: str) -> Path:
    path = Path(os.environ.get("PARSING_FIXTURE_DIR", ROOT / "tests" / "fixtures")) / name
    if not path.is_file():
        pytest.skip(f"optional upstream fixture {name} is absent; set PARSING_FIXTURE_DIR to supply the originals")
    return path


@pytest.fixture(scope="session")
def root() -> Path:
    return ROOT


@pytest.fixture(scope="session")
def scan_pdf() -> Path:
    """One spread of the Beier catalogue: a 1-bit 600 dpi scan, placed with a -0.11 degree rotation."""
    return _fixture_pdf("Beier1988_GAC_02_Catalogue7.pdf")


@pytest.fixture(scope="session")
def digital_pdf(tmp_path_factory) -> Path:
    """Eight native-text pages, generated locally so admission/geometry tests need no private PDF."""
    from tests.helpers.pdfs import text_pdf

    path = tmp_path_factory.mktemp("native-pdf") / "main.pdf"
    text_pdf(path, [[f"Catalogue page number {number} contains the following archaeological records", "",
                     "17. Hill", "Finds: pottery. Date: Bronze Age.",
                     "", "18. Valley", "Finds: flint. Date: Neolithic."] for number in range(1, 9)])
    return path


@pytest.fixture(scope="session")
def recorded_digital_pdf() -> Path:
    """The exact original source required by recorded hashes and table geometry assertions."""
    return _fixture_pdf("main.pdf")


@pytest.fixture
def recorded() -> Callable[[str], dict]:
    """A recorded API run by name: its parameters, debug report, recipe and region events (tests/recorded)."""
    def load(name: str) -> dict:
        return json.loads((ROOT / "tests" / "recorded" / f"{name}.json").read_text(encoding="utf-8"))
    return load


from tests.helpers import postgres as postgres_helper


@pytest.fixture(scope="session")
def _postgres_server() -> Iterator[postgres_helper.Server]:
    """The explicitly supplied disposable PostgreSQL target; never starts a server."""
    gen = postgres_helper.server()
    server = next(gen)
    try:
        yield server
    finally:
        try:
            next(gen)
        except StopIteration:
            pass


@pytest.fixture(scope="session")
def postgres(_postgres_server: postgres_helper.Server) -> str:
    """The session's throwaway PostgreSQL, as a conninfo string."""
    return _postgres_server.conninfo


@pytest.fixture(scope="session")
def postgres_container(_postgres_server: postgres_helper.Server) -> str:
    """The id of the container serving the session's throwaway PostgreSQL, for a test that pauses/unpauses the
    real server rather than just connecting to it."""
    if not _postgres_server.container_id:
        pytest.skip("PARSING_TEST_POSTGRES_CONTAINER is required for the opt-in database outage test")
    return _postgres_server.container_id


@pytest.fixture
def database(postgres: str) -> Iterator[str]:
    """A fresh empty database for one test, as a conninfo string."""
    gen = postgres_helper.fresh(postgres)
    db_conninfo = next(gen)
    try:
        yield db_conninfo
    finally:
        try:
            next(gen)
        except StopIteration:
            pass


@pytest.fixture
def kei(database: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """kei's DBOS worker in this process on a fresh database (tests/helpers/kei.py). Release every blocked step
    before the test ends: DBOS.destroy() does not wait for step threads."""
    from tests.helpers import kei as kei_helper
    with kei_helper.launched(database, tmp_path, monkeypatch) as launched:
        yield launched


@pytest.hookimpl(tryfirst=True)
def pytest_collection_modifyitems(items):
    """Fixture closure makes every database dependency visible before marker selection."""
    for item in items:
        if "_postgres_server" in item.fixturenames:
            item.add_marker(pytest.mark.postgres)
        if "spread_cut" in item.fixturenames:
            item.add_marker(pytest.mark.live_model)

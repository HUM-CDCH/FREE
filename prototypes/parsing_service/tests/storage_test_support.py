from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from app.storage import paths
from app.workers import parse_worker


@contextmanager
def isolated_storage() -> Iterator[Path]:
    with TemporaryDirectory(dir=paths.SERVICE_ROOT) as tmp_dir:
        root = Path(tmp_dir)
        tasks_dir = root / "tasks"
        with (
            patch.object(paths, "DEFAULT_DATA_DIR", tasks_dir),
            patch.object(paths, "DEFAULT_SOURCE_STORE_DIR", root / "sources"),
            patch.object(paths, "DEFAULT_DOCUMENT_STORE_DIR", root / "documents"),
            patch.object(parse_worker, "DEFAULT_DATA_DIR", tasks_dir),
        ):
            yield root

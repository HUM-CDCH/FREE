"""Files written while readers may be looking: published by rename, so no reader ever sees a partial one."""
import logging
import os
import secrets
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from pathlib import Path

logger = logging.getLogger(__name__)


@contextmanager
def publish(target: Path) -> Iterator[Path]:
    """A sibling path to write in place of `target`, renamed onto it once the block ends.

    The API's endpoints read a run's JSON files and previews while the worker writes them; a rename within one
    directory is atomic, so a reader finds either no file (or the previous one) or the complete new one. The
    sibling is a plain file, not a tempfile, so it gets the same permissions as everything else written beside
    it; it is removed again if the block raises.
    """
    part = target.with_name(f"{target.name}.{secrets.token_hex(4)}.part")
    try:
        yield part
        os.replace(part, target)
    except BaseException:
        # Cleanup must not replace the original write/rename diagnostic.
        with suppress(OSError):
            part.unlink(missing_ok=True)
        raise


def load_dotenv(path: Path | None = None) -> None:
    """Load key-value pairs from a .env file into os.environ if not already set."""
    if path is None:
        cur = Path.cwd()
        for candidate_dir in (cur, Path(__file__).resolve().parent.parent.parent):
            candidate = candidate_dir / ".env"
            if candidate.is_file():
                path = candidate
                break
    if path is None or not path.is_file():
        return
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, val = line.split("=", 1)
                key = key.strip()
                val = val.strip().strip("'\"")
                if key and key not in os.environ:
                    os.environ[key] = val
    except (OSError, UnicodeError):
        logger.warning("Could not read environment file %s", path, exc_info=True)

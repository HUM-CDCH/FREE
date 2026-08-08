"""Cache reuse must rebind the task to a live immutable generation.

Regression cover: a canonical document that was already in the store made
`_build_or_load_canonical` return early, so task metadata never received
`canonical_generation_ref` and completion failed with
"Canonical parser output has no immutable generation binding."
"""

from __future__ import annotations

import unittest
from pathlib import Path
from unittest.mock import patch

from app.storage.blobs import prune_orphan_document_generations
from app.storage.manifests import (
    read_canonical_generation_ref,
    write_canonical_generation_pointer,
)
from app.storage.paths import (
    document_generation_dir,
    document_store_dir,
    service_relative_ref,
)
from app.workers import parse_worker
from tests.storage_test_support import isolated_storage


CONTENT_SHA256 = "b" * 64
CONFIG_HASH = "c" * 64
GENERATION_ID = "0123456789abcdef-" + "0" * 32
ORPHAN_GENERATION_ID = "fedcba9876543210-" + "1" * 32


def _publish_generation(
    content_sha256: str = CONTENT_SHA256,
    generation_id: str = GENERATION_ID,
    *,
    with_markdown: bool = True,
) -> Path:
    generation = document_generation_dir(content_sha256, generation_id)
    artifacts = generation / "artifacts"
    artifacts.mkdir(parents=True, exist_ok=True)
    if with_markdown:
        (artifacts / "document.llm.md").write_text("# canonical\n", encoding="utf-8")
    return generation


class TestCanonicalGenerationPointer(unittest.TestCase):
    def setUp(self):
        self._storage = isolated_storage()
        self._storage.__enter__()
        self.addCleanup(self._storage.__exit__, None, None, None)

    def test_published_generation_round_trips(self):
        generation = _publish_generation()
        write_canonical_generation_pointer(
            CONTENT_SHA256,
            generation_ref=service_relative_ref(generation),
            config_hash=CONFIG_HASH,
        )

        self.assertEqual(
            read_canonical_generation_ref(
                CONTENT_SHA256, expected_config_hash=CONFIG_HASH
            ),
            service_relative_ref(generation),
        )

    def test_unbound_document_reports_no_generation(self):
        _publish_generation()

        self.assertIsNone(
            read_canonical_generation_ref(
                CONTENT_SHA256, expected_config_hash=CONFIG_HASH
            )
        )

    def test_policy_change_invalidates_the_binding(self):
        generation = _publish_generation()
        write_canonical_generation_pointer(
            CONTENT_SHA256,
            generation_ref=service_relative_ref(generation),
            config_hash=CONFIG_HASH,
        )

        self.assertIsNone(
            read_canonical_generation_ref(
                CONTENT_SHA256, expected_config_hash="d" * 64
            )
        )

    def test_pruned_generation_reports_no_generation(self):
        generation = _publish_generation(with_markdown=False)
        write_canonical_generation_pointer(
            CONTENT_SHA256,
            generation_ref=service_relative_ref(generation),
            config_hash=CONFIG_HASH,
        )

        self.assertIsNone(
            read_canonical_generation_ref(
                CONTENT_SHA256, expected_config_hash=CONFIG_HASH
            )
        )


class TestReusableCanonical(unittest.TestCase):
    def setUp(self):
        self._storage = isolated_storage()
        self._storage.__enter__()
        self.addCleanup(self._storage.__exit__, None, None, None)
        self.metadata: dict[str, object] = {"params": {}}

    def _bind_published_generation(self) -> str:
        generation = _publish_generation()
        generation_ref = service_relative_ref(generation)
        write_canonical_generation_pointer(
            CONTENT_SHA256,
            generation_ref=generation_ref,
            config_hash=parse_worker.preprocessing_config_hash(self.metadata),
        )
        return generation_ref

    def test_cache_hit_binds_the_task_to_its_generation(self):
        generation_ref = self._bind_published_generation()
        cached = object()

        with patch.object(
            parse_worker, "_load_valid_canonical", return_value=cached
        ):
            reused = parse_worker._reusable_canonical(CONTENT_SHA256, self.metadata)

        self.assertIs(reused, cached)
        self.assertEqual(
            self.metadata["canonical_generation_ref"],
            generation_ref,
        )

    def test_cache_hit_without_a_generation_is_rebuilt(self):
        # Completion requires a generation binding, so an unbound cache entry
        # must be a miss rather than a task failure.
        _publish_generation()

        with patch.object(
            parse_worker, "_load_valid_canonical", return_value=object()
        ):
            reused = parse_worker._reusable_canonical(CONTENT_SHA256, self.metadata)

        self.assertIsNone(reused)
        self.assertNotIn("canonical_generation_ref", self.metadata)

    def test_cache_miss_stays_a_miss(self):
        self._bind_published_generation()

        with patch.object(parse_worker, "_load_valid_canonical", return_value=None):
            reused = parse_worker._reusable_canonical(CONTENT_SHA256, self.metadata)

        self.assertIsNone(reused)
        self.assertNotIn("canonical_generation_ref", self.metadata)


class TestGenerationPruning(unittest.TestCase):
    def setUp(self):
        self._storage = isolated_storage()
        self._storage.__enter__()
        self.addCleanup(self._storage.__exit__, None, None, None)

    def test_pointer_keeps_the_live_generation(self):
        live = _publish_generation()
        orphan = _publish_generation(generation_id=ORPHAN_GENERATION_ID)
        write_canonical_generation_pointer(
            CONTENT_SHA256,
            generation_ref=service_relative_ref(live),
            config_hash=CONFIG_HASH,
        )

        prune_orphan_document_generations(
            document_store_dir=document_store_dir(CONTENT_SHA256).parent
        )

        self.assertTrue(live.is_dir())
        self.assertFalse(orphan.exists())


if __name__ == "__main__":
    unittest.main()

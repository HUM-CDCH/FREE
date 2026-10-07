"""Record-specific selection of whole bounded contexts, without manufacturing adjacency.

Keep units owning inventory support and adjacent canonical passages, then at most one
additional unit with positive schema-term relevance. This transparent lexical hypothesis
is not a learned retriever or a reproduction of a hybrid embedding/BM25 system.
"""
from __future__ import annotations

import math
import re
import unicodedata
from collections import Counter
from collections.abc import Sequence

from kei_exp.kie.extract.contexts import Context
from kei_exp.kie.extract.schema import Schema, notes
from kei_exp.kie.passages import Passage

VERSION = 1
STOP = frozenset("the and for from with that this those these only into over under are was were has have not "
                 "source record records field fields value values schema string integer number boolean array "
                 "object null return unknown reported".split())


def words(text: str) -> list[str]:
    return [word for word in re.findall(r"[^\W\d_]+", unicodedata.normalize("NFKC", text).casefold())
            if len(word) >= 3 and word not in STOP]


def select_contexts(contexts: Sequence[Context], passages: Sequence[Passage], support: Sequence[str],
                    schema: Schema) -> tuple[list[Context], dict]:
    """Selection uses source/schema/inventory only; callers never supply gold or expected counts."""
    order = [passage.id for passage in passages]
    support = set(support)
    if not support or not support <= set(order):
        raise ValueError("context selection requires nonempty canonical inventory support")
    neighbors = {order[j] for index, name in enumerate(order) if name in support
                 for j in (index - 1, index + 1) if 0 <= j < len(order)} - support
    reasons = {}
    counts = []
    for index, context in enumerate(contexts):
        owned = {passage.id for passage in context.primary}
        reasons[index] = (["identity_support"] if owned & support else []) + (
            ["neighboring_passage"] if owned & neighbors else [])
        counts.append(Counter(words("\n".join(p.text for p in context.primary))))
    if not any("identity_support" in reason for reason in reasons.values()):
        raise ValueError("no context owns the supplied identity support")
    query = set(words(schema.record_description + "\n" + "\n".join(notes(schema.record_nodes))))
    frequency = Counter(term for count in counts for term in count)
    scores = [sum((1 + math.log(count[term])) * math.log((len(counts) + 1) / (frequency[term] + 1))
                  for term in sorted(query & count.keys())) / math.sqrt(max(1, sum(count.values())))
              for count in counts]
    candidates = [index for index in reasons if not reasons[index] and scores[index] > 0]
    if candidates:
        best = min(candidates, key=lambda index: (-scores[index], index))
        reasons[best].append("schema_context")
    selected = [index for index in reasons if reasons[index]]
    shown = {p.id for index in selected for p in contexts[index].passages}
    return [contexts[index] for index in selected], {
        "version": VERSION, "unit_count": len(contexts),
        "selected_units": [{"index": index, "reasons": reasons[index]} for index in selected],
        "omitted_units": [index for index in reasons if not reasons[index]],
        "selected_passages": [name for name in order if name in shown],
        "omitted_passages": [name for name in order if name not in shown],
        "schema_scores": [round(score, 8) for score in scores],
        "relevance_recall": "unmeasured"}

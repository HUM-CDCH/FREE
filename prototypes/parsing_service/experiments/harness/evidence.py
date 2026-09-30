"""Evidence: resolving what the model cited to canonical spans, checking it, and optionally judging it.

Three separate questions, three separate records: does the cited passage exist (alignment, deterministic); does it
state the value literally (deterministic, for fields whose evidence policy is `quoted`); does it support assigning the
value to this field and this record (a model verdict, which is another fallible prediction and never overwrites the
extraction). An approximate match is never called exact, repeated text keeps every location, and coordinates are copied
from the case's canonical geometry or absent, never made up.
"""
from __future__ import annotations

import difflib
import math
from collections import Counter
from typing import Any

from experiments.harness.config import Alignment, Config
from experiments.harness.data import Case
from experiments.harness.model import BudgetExceeded, Metered, ask
from kei_exp.kie.blocks import Span
from kei_exp.kie.extract.catalog_result import spans_json
from kei_exp.kie.extract.locate import BlockText, _spans, forms, locate, normalise
from kei_exp.kie.extract.schema import Node, evidence_policy
from kei_exp.kie.extract.stages import contains
from kei_exp.kie.passages import Passage

VERDICT_KEYS = ("supports_value", "supports_field", "supports_record")


def block_of(passages) -> BlockText:
    return BlockText.of([(p.id, p.text, Span(segment_id=p.id, start=0, end=len(p.text))) for p in passages if p.text])


def exact_spans(block: BlockText, quote: str) -> list[list[Span]]:
    """Every raw occurrence of `quote`, without normalisation or word boundaries."""
    found, at = [], block.text.find(quote) if quote else -1
    while at != -1:
        found.append(_spans(block, at, at + len(quote)))
        at = block.text.find(quote, at + 1)
    return found


def fuzzy_spans(block: BlockText, quote: str, threshold: float, growth: float) -> list[tuple[list[Span], float]]:
    """Bounded approximate matches: around each of the quote's longest common runs with the text, a window at most
    `growth` times the quote long, scored by difflib's similarity ratio between the quote and the text it matched. This is a
    difflib adaptation, not Smith-Waterman alignment; every result is approximate by construction."""
    view, needle = normalise(block.text), normalise(quote).text
    n = len(needle)
    if n < 4 or not view.text:
        return []
    slack = math.ceil(n * (growth - 1))
    anchors = sorted((m for m in difflib.SequenceMatcher(None, view.text, needle, autojunk=False).get_matching_blocks()
                      if m.size >= max(3, n // 4)), key=lambda m: (-m.size, m.a))
    found: list[tuple[int, int, float]] = []
    for anchor in anchors[:8]:
        lo = max(0, anchor.a - anchor.b - slack)
        window = view.text[lo:min(len(view.text), anchor.a - anchor.b + n + slack)]
        blocks = [b for b in difflib.SequenceMatcher(None, window, needle, autojunk=False).get_matching_blocks() if b.size]
        if not blocks:
            continue
        start, end = lo + blocks[0].a, lo + blocks[-1].a + blocks[-1].size
        score = 2 * sum(b.size for b in blocks) / (n + end - start)   # difflib's ratio between the quote and what it matched
        if score >= threshold and end - start <= n * growth and not any(start < e and s < end for s, e, _ in found):
            found.append((start, end, score))
    return [(_spans(block, view.ranges[s][0], view.ranges[e - 1][1]), score) for s, e, score in sorted(found)]


def align(quote: str, block: BlockText, rules: Alignment) -> tuple[str | None, list[list[Span]], float | None]:
    """The first enabled method that finds the quote, in order exact, normalised, fuzzy, with every occurrence."""
    if rules.exact and (found := exact_spans(block, quote)):
        return "exact", found, 1.0
    if rules.normalized and (found := locate(block, quote)):
        return "normalized", found, 1.0
    if rules.fuzzy and (approx := fuzzy_spans(block, quote, rules.fuzzy_threshold, rules.fuzzy_growth)):
        return "fuzzy", [spans for spans, _ in approx], max(score for _, score in approx)
    return None, [], None


def _where(case: Case, spans: list[dict]) -> dict:
    """The pages and canonical boxes of a span list: copied from the case's geometry, absent where it has none."""
    segments = list(dict.fromkeys(span["segment"] for span in spans))
    pages = {p.id: p.page for p in case.evidence.passages}
    return {"pages": sorted({pages[s] for s in segments if s in pages}),
            "bbox_pt": [list(case.geometry[s]) for s in segments if s in case.geometry] or None}


def _entry(case: Case, *, quote: str | None, ids: list[str], method: str | None, found: list[list[Span]], score: float | None,
           exists: bool | None = None) -> dict:
    spans = [spans_json(each) for each in found]
    primary = spans[0] if spans else []
    return {"quote": quote, "ids": ids, "method": method, "approximate": method == "fuzzy", "score": score,
            "spans": primary, "alternatives": spans[1:], "ambiguous": len(spans) > 1, "exists": bool(primary) if exists is None else exists,
            **_where(case, primary)}


def entries_for(candidate: dict, value: Any, case: Case, shown: tuple[Passage, ...], cfg: Config) -> list[dict]:
    """The evidence entries of one field: one per cited quote, or one per cited id. A citation that cannot be located
    keeps an entry with no spans, so 'cited but not found' stays visible."""
    mode = cfg.evidence.mode
    if mode == "none" or candidate["value"] is None and not candidate["raw"]:
        return []
    block = block_of(shown)
    out = []
    if mode == "quote":
        for quote in candidate["quotes"]:
            method, found, score = align(quote, block, cfg.evidence.alignment)
            out.append(_entry(case, quote=quote, ids=[], method=method, found=found, score=score))
    else:
        ids = [i for i in candidate["ids"] if isinstance(i, str)]
        by_id = {p.id: p for p in shown}
        spans = [Span(segment_id=i, start=0, end=len(by_id[i].text)) for i in ids if i in by_id and by_id[i].text]
        out.append(_entry(case, quote=None, ids=ids, method="passage", exists=bool(ids) and all(i in by_id for i in ids),
                          found=[spans] if spans else [], score=None))
        if any(i not in by_id for i in ids):
            out[-1]["missing_ids"] = [i for i in ids if i not in by_id]
    return refine_entries(out, value, case, cfg.evidence.alignment)


def refine_entries(entries: list[dict], value: Any, case: Case, alignment: Alignment) -> list[dict]:
    """The same value localization for quotes and IDs, restricted to their selected text; never reads gold.

    Keep the model's selection and its ambiguity before refinement. A literal location is not a semantic verdict.
    """
    texts = {p.id: p.text for p in case.evidence.passages}
    literal = [text for item in (value if isinstance(value, list) else [value]) for text in forms(item)] if value is not None else []
    result = []
    for original in entries:
        raw = [original["spans"], *original.get("alternatives", [])]
        refined = []
        for text in literal:
            found = []
            for choice in raw:
                inside = BlockText.of([(s["segment"], texts[s["segment"]],
                                       Span(segment_id=s["segment"], start=s["start"], end=s["end"])) for s in choice])
                _, located, _ = align(text, inside, alignment)
                found += [spans_json(spans) for spans in located]
            if found:
                unique = list({str(spans): spans for spans in found}.values())
                refined.append({**original, "spans": unique[0], "alternatives": unique[1:], "ambiguous": len(unique) > 1,
                                "method": "passage+value" if original["method"] == "passage" else original["method"],
                                **_where(case, unique[0])})
        for entry in refined or [dict(original)]:
            result.append({**entry, "evidence_protocol": 2, "raw_spans": raw[0], "raw_alternatives": raw[1:],
                           "raw_method": original["method"], "refined": bool(refined),
                           "localization": "predicted_value_in_selected_text" if refined else "not_localized",
                           "semantic_support": None})
    return result


def disambiguate(entries: dict[str, list[dict]], case: Case) -> None:
    """Repeated text: prefer the occurrence in the passage that most of the record's own citations can be found in (a
    record's fields sit in its own passage). Every location stays listed; only which one is primary changes, and the entry
    says so. When no passage is the clear favourite, or the text is not there, nothing changes."""
    options = {id(e): [e["spans"], *e["alternatives"]] for group in entries.values() for e in group if e["spans"]}
    votes: Counter = Counter()
    for group in entries.values():
        for e in group:
            votes.update({s["segment"] for spans in options.get(id(e), []) for s in spans})
    if not votes:
        return
    top = {seg for seg, n in votes.items() if n == max(votes.values())}
    for group in entries.values():
        for e in group:
            if not e["ambiguous"] or e["method"] not in ("exact", "normalized", "fuzzy", "passage+value"):
                continue
            choices = options[id(e)]
            pick = next((i for i, spans in enumerate(choices) if {s["segment"] for s in spans} <= top), None)
            if pick:
                e["spans"], e["alternatives"] = choices[pick], [o for i, o in enumerate(choices) if i != pick]
                e.update(_where(case, e["spans"]), disambiguated=True)


def _text(case: Case, entries: list[dict]) -> str:
    texts = {p.id: p.text for p in case.evidence.passages}
    return " ".join(texts[s["segment"]][s["start"]:s["end"]] for e in entries for s in e["spans"])


def checks(candidate: dict, node: Node, entries: list[dict], case: Case, cfg: Config) -> dict:
    """Deterministic checks: type/allowed values, that every citation resolved, and that the printed value lies in the
    cited text. `literal` is None for fields whose value is not printed (labels, yes/no, derived) and for those whose
    evidence policy does not ask for source support."""
    policy = evidence_policy(case.schema.record_nodes, [node.name])
    if cfg.evidence.mode == "none" or candidate["value"] is None:
        return {"type_ok": candidate["typed"], "cited_exists": None, "literal": None, "expects_evidence": policy == "quoted"}
    literal = None
    if policy == "quoted" and node.type != "boolean" and node.allowed_values is None and entries:
        text = _text(case, entries)
        items = candidate["value"] if isinstance(candidate["value"], list) else [candidate["value"]]
        literal = bool(text) and all(any(contains(text, form) for form in forms(item) or [str(item)]) for item in items)
    return {"type_ok": candidate["typed"], "cited_exists": bool(entries) and all(e["exists"] for e in entries),
            "literal": literal, "expects_evidence": policy == "quoted"}


VERIFY = ("You check values extracted from one record of a source document. A record is: {description}\n"
          "For each candidate answer from the CITED TEXT alone, without assuming anything outside it: "
          "\"supports_value\": does the cited text state this value; \"supports_field\": does it state it as the value of "
          "the named field, not another field; \"supports_record\": does it belong to the record described by the other "
          "extracted fields, not to another record. Use null when the cited text does not allow a judgement. "
          "Return only the JSON object.")


def _cited(case: Case, entries: list[dict], width: int = 1000) -> str:
    """The cited passages, cut to a window of `width` characters either side of the citation (a citation is never cut), each
    cited span wrapped in [[ ]] so what was cited is told apart from the passage around it. The verifier sees these and
    nothing else of the source."""
    texts = {p.id: p.text for p in case.evidence.passages}
    out = []
    for segment in dict.fromkeys(s["segment"] for e in entries for s in e["spans"]):
        marks = sorted({(s["start"], s["end"]) for e in entries for s in e["spans"] if s["segment"] == segment})
        text = texts[segment]
        lo, hi = max(0, marks[0][0] - width), min(len(text), max(b for _, b in marks) + width)
        shown, cursor = [], lo
        for a, b in marks:
            if a >= cursor:
                shown += [text[cursor:a], "[[", text[a:b], "]]"]
                cursor = b
        shown.append(text[cursor:hi])
        out.append(f"[{segment}] " + ("…" if lo else "") + "".join(shown) + ("…" if hi < len(text) else ""))
    return "\n".join(out)


def verify_record(fields: dict[str, dict], case: Case, cfg: Config, meter: Metered) -> tuple[dict[str, dict], list]:
    """One counted call for a record's cited fields. The verifier sees the field definitions, the record's other
    extracted values, each candidate and the text it cited: nothing else, so it cannot search elsewhere. Returns the
    verdict per field (None values where it could not judge) and the calls."""
    nodes = {node.name: node for node in case.schema.record_nodes}
    candidates = [(name, f) for name, f in fields.items() if f["status"] == "value" and f["entries"]
                  and any(e["spans"] for e in f["entries"])]
    if not candidates:
        return {}, []
    context = "; ".join(f"{name}={f['value']!r}" for name, f in fields.items() if f["status"] == "value")
    labels = [f"C{n}" for n in range(1, len(candidates) + 1)]
    lines = [f"### Extracted record\n{context}"]
    for label, (name, f) in zip(labels, candidates, strict=True):
        node = nodes[name]
        lines.append(f"### {label}: field {name}" + (f" ({node.description})" if node.description else "") +
                     f"\nvalue: {f['value']!r}\ncited text:\n{_cited(case, f['entries'])}")
    schema = {"type": "object", "properties": {label: {"type": "object", "properties": {
        key: {"type": ["boolean", "null"]} for key in VERDICT_KEYS}, "required": list(VERDICT_KEYS),
        "additionalProperties": False} for label in labels}, "required": labels, "additionalProperties": False}
    try:
        parsed, calls, _ = ask(meter, stage="verification", system=VERIFY.format(description=case.schema.record_description),
                               user="\n\n".join(lines) + "\n\nReturn the JSON object now.",
                               schema=schema if cfg.output.constraint == "schema" else None, max_tokens=cfg.output.max_tokens,
                               temperature=0.0)
    except BudgetExceeded as error:     # no verdict is not a failed one: the fields stay as extracted, marked unverified
        return {name: {**dict.fromkeys(VERDICT_KEYS), "error": f"budget exhausted: {error}"} for name, _ in candidates}, []
    last = calls[-1] if calls else None
    if parsed is None or last is None or not last.ok or not isinstance(parsed, dict):
        return {name: {**dict.fromkeys(VERDICT_KEYS), "error": (last.error if last else "no call") or "verification failed"}
                for name, _ in candidates}, calls
    verdicts = {}
    for label, (name, _) in zip(labels, candidates, strict=True):
        each = parsed.get(label)
        verdicts[name] = {key: (each or {}).get(key) if isinstance((each or {}).get(key), bool) else None for key in VERDICT_KEYS}
    return verdicts, calls


def unsupported(row: dict) -> bool:
    """A field is unsupported when its evidence was expected and is missing, unresolved or not literally the value, or a
    verdict says the cited text does not support it. Unknown is not unsupported: a verdict that could not be reached
    never withholds a value."""
    check, verdict = row["checks"], row.get("verdict") or {}
    if (check["cited_exists"] is False or check["literal"] is False) and check["expects_evidence"]:
        return True
    return any(verdict.get(key) is False for key in VERDICT_KEYS)

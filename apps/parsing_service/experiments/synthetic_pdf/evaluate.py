"""Identity-aligned exact scoring and independently located, field-specific evidence gold."""
from __future__ import annotations

import copy
import json
import unicodedata
from collections import Counter, defaultdict

from jsonschema import ValidationError, validate

from kei_exp.kie.extract.schema import Schema, json_schema
from kei_exp.kie.extract.stages import contains
from kei_exp.kie.passages import Evidence

from .generate import expected, normalized

METADATA = frozenset({"document_id", "collection_title", "edition"})


def canonical(value) -> str:
    """Exact types; strings ignore Unicode composition and whitespace only."""
    if isinstance(value, str):
        value = normalized(unicodedata.normalize("NFC", value))
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


def rates(matched: int, predicted: int, wanted: int) -> dict:
    precision = matched / predicted if predicted else None
    recall = matched / wanted if wanted else None
    return {"matched": matched, "predicted": predicted, "expected": wanted,
            "precision": precision, "recall": recall,
            "f1": 2 * matched / (predicted + wanted) if predicted + wanted else None}


def evidence_rates(correct: int, predicted: int, supported: int, wanted: int) -> dict:
    """Precision counts links; recall counts distinct gold claims, even with several correct citations."""
    result = rates(correct, predicted, wanted)
    precision, recall = result["precision"], supported / wanted if wanted else None
    f1 = (2 * precision * recall / (precision + recall)
          if precision is not None and recall is not None and precision + recall else 0)
    return {**result, "recall": recall, "f1": f1, "supported_claims": supported}


def unordered(value):
    """A typed, normalized comparison value; arrays preserve multiplicity but ignore order."""
    if isinstance(value, dict):
        return {name: unordered(child) for name, child in value.items()}
    if isinstance(value, list):
        return sorted((unordered(child) for child in value), key=canonical)
    return json.loads(canonical(value))


def member_token(value, identity):
    return (canonical(value[identity]) if isinstance(value, dict) and identity and identity in value
            else canonical(value))


def similarity(value, wanted, identities, name=None):
    """Rank whole same-ID copies by gold matches; never collect fields across copies."""
    if isinstance(wanted, dict):
        return (sum(similarity(value.get(k), v, identities, k) for k, v in wanted.items())
                if isinstance(value, dict) else 0)
    if isinstance(wanted, list):
        if not isinstance(value, list):
            return 0
        identity = identities.get(name)
        candidates = defaultdict(list)
        for child in value:
            candidates[member_token(child, identity)].append(child)
        members = sum((Counter(member_token(c, identity) for c in value)
                       & Counter(member_token(c, identity) for c in wanted)).values())
        return members + sum(max((similarity(c, child, identities) for c in
                                  candidates[member_token(child, identity)]), default=0) for child in wanted)
    return int(wanted is not None and canonical(value) == canonical(wanted))


def occurrences(values, tokens, wanted, identities, paths, links):
    """Assign the best whole copy occurrence 0. Source paths retain their original indices."""
    groups = defaultdict(list)
    for n, token in enumerate(tokens):
        groups[token].append(n)
    result = {}
    for token, indices in groups.items():
        def rank(n, token=token):
            value = values[n]
            # Object value matching excludes document metadata in either schema shape.
            if isinstance(value, dict) and "record_id" in value:
                value = {k: v for k, v in value.items() if k not in METADATA}
            target = wanted.get(token)
            signature = []
            for link in links:
                if not isinstance(link, dict) or not isinstance(link.get("path"), (list, tuple)):
                    continue
                path = tuple(link["path"])
                if path[:len(paths[n])] == paths[n]:
                    # Relative field names and citation content provide a stable, truth-independent tie break.
                    signature.append({**link, "path": [p for p in path[len(paths[n]):] if isinstance(p, str)]})
            return (-similarity(value, target, identities), -int(unordered(value) == unordered(target)),
                    canonical(unordered(value)), -len(signature), canonical(sorted(signature, key=canonical)))
        ordered = sorted(indices, key=rank) if len(indices) > 1 else indices
        result.update({n: occurrence for occurrence, n in enumerate(ordered)})
    return result


def project(records: list, strategy: str, identities: dict, reference=None, links=()) -> dict:
    """Array order has no effect; missing IDs and every extra occurrence remain errors."""
    fields, metadata, paths, arrays, items_by_key = {}, {}, {}, {}, {}
    record_ids = Counter()

    def walk(value, key, path, target, wanted=None):
        if isinstance(value, dict):
            for name, child in value.items():
                walk(child, (*key, name), (*path, name), target,
                     wanted.get(name) if isinstance(wanted, dict) else None)
        elif isinstance(value, list):
            members = Counter()
            identity = identities.get(str(path[-1]))
            tokens = [member_token(child, identity) for child in value]
            wanted_children = {member_token(child, identity): child for child in wanted} if isinstance(wanted, list) else {}
            indices = occurrences(value, tokens, wanted_children, identities,
                                  [(*path, n) for n in range(len(value))], links)
            for n, child in enumerate(value):
                token, occurrence = tokens[n], indices[n]
                members[token] += 1
                walk(child, (*key, token, occurrence), (*path, n), target, wanted_children.get(token))
            arrays[key] = members
        else:
            paths[path] = key
            if value is not None:
                target[key] = canonical(value)

    located = []
    for root, record in enumerate(records):
        if not isinstance(record, dict):
            fields[("invalid_root", root)] = canonical(record)
            continue
        if strategy == "article":
            items = record.get("items", [])
            for name, value in record.items():
                if name != "items":
                    walk(value, ("metadata", "document", root, name), ("records", root, name), metadata)
            if not isinstance(items, list):
                fields[("invalid_items", root)] = canonical(items)
                continue
            located.extend((item, ("records", root, "items", n)) for n, item in enumerate(items))
        else:
            located.append((record, ("records", root)))
    tokens = [canonical(item.get("record_id")) if isinstance(item, dict) and item.get("record_id") is not None
              else f"missing-{path}" for item, path in located]
    wanted = {k[1]: {name: value for name, value in item.items() if name not in METADATA}
              for k, item in reference["items"].items()} if reference else {}
    indices = occurrences([item for item, _ in located], tokens, wanted, identities,
                          [path for _, path in located], links)
    for n, (item, path) in enumerate(located):
        rid, occurrence = tokens[n], indices[n]
        record_ids[rid] += 1
        items_by_key[("item", rid, occurrence)] = item
        if isinstance(item, dict):
            walk({k: v for k, v in item.items() if k not in METADATA}, ("item", rid, occurrence), path, fields, wanted.get(rid))
            if strategy == "catalog":
                walk({k: v for k, v in item.items() if k in METADATA}, ("metadata", rid, occurrence), path, metadata)
        else:
            walk(item, ("item", rid, occurrence), path, fields)
    return {"fields": fields, "metadata": metadata, "paths": paths, "arrays": arrays, "ids": record_ids,
            "items": items_by_key}


def overlap(left, right) -> float:
    area = max(0, left[2] - left[0]) * max(0, left[3] - left[1])
    intersection = max(0, min(left[2], right[2]) - max(left[0], right[0])) * max(0, min(left[3], right[3]) - max(left[1], right[1]))
    return intersection / area if area else 0


def annotation_locations(annotation: dict, evidence: Evidence) -> set:
    found = set()
    for passage in evidence.passages:
        if passage.page != annotation["page"] or overlap(annotation["bbox_pt"], passage.bbox_pt) < .5:
            continue
        if passage.table is not None and annotation["kind"] == "table":
            candidates = [(cell.cell_id, cell.text, cell.bbox_pt) for cell in passage.table.cells if cell.bbox_pt]
        else:
            candidates = [(None, passage.text, passage.bbox_pt)]
        for cell, text, box in candidates:
            if overlap(annotation["bbox_pt"], box) >= .5 and contains(text, annotation["value"]):
                found.add((passage.id, cell))
    return found


def bind_gold(truth: dict, evidence: Evidence, strategy: str, gold: dict) -> dict:
    """Map *rendered* locations to canonical segments/cells, never model links or global value search."""
    found = defaultdict(set)
    populated = set(gold["fields"]) | set(gold["metadata"])
    indices = {item["record_id"]: n for n, item in enumerate(truth["items"])}
    for annotation in truth["annotations"]:
        rid, path = annotation["record_id"], annotation["path"]
        if rid is None:
            source_paths = ([("records", 0, *path)] if strategy == "article" else
                            [("records", n, *path) for n in range(len(indices))])
        else:
            n = indices[rid]
            source_paths = [("records", 0, "items", n, *path) if strategy == "article" else ("records", n, *path)]
        keys = [gold["paths"][path] for path in source_paths if path in gold["paths"] and gold["paths"][path] in populated]
        locations = annotation_locations(annotation, evidence)
        for key in keys:
            found[key].update(locations)
    return found


def evaluate(truth: dict, artifact: dict, evidence: Evidence) -> dict:
    strategy = artifact["strategy"]
    wanted = expected(truth, strategy)
    gold = project(wanted, strategy, truth["array_identities"])
    actual = project(artifact.get("records", []), strategy, truth["array_identities"], gold,
                     [*artifact.get("evidence", []), *artifact.get("quoted_support", [])])
    matched = {k for k, value in actual["fields"].items() if gold["fields"].get(k) == value}
    metadata_matched = {k for k, value in actual["metadata"].items() if gold["metadata"].get(k) == value}
    bindings = bind_gold(truth, evidence, strategy, gold)
    gold_claims = gold["fields"] | gold["metadata"]
    actual_claims = actual["fields"] | actual["metadata"]
    matching_claims = matched | metadata_matched
    inverse = defaultdict(set)
    for key, places in bindings.items():
        for place in places:
            inverse[(place, gold_claims.get(key))].add(key)
    source_valid, attributed, supported, ambiguous, coarse = 0, 0, set(), 0, 0
    malformed, eligible_links, object_links, metadata_links = 0, 0, 0, 0
    object_correct, metadata_correct = 0, 0
    proofs = {tuple(proof["path"]): proof for proof in artifact.get("quoted_support", [])}
    for link in artifact.get("evidence", []):
        try:
            path = tuple(link["path"])
            key = actual["paths"].get(path)
            eligible_links += int(key in matching_claims)
            object_links += int(key is not None and key[0] == "item")
            metadata_links += int(key is not None and key[0] == "metadata")
            place = (link["segment"], link.get("cell"))
            passage = evidence.by_id(link["segment"])
            cell = next((cell for cell in passage.table.cells if cell.cell_id == link.get("cell")), None) if passage.table else None
            box = cell.bbox_pt if cell else passage.bbox_pt
            valid = (link["page"] == passage.page and (not link.get("cell") or cell is not None)
                     and box is not None and len(link["bbox_pt"]) == 4
                     and all(abs(a - b) < .02 for a, b in zip(box, link["bbox_pt"], strict=True)))
            proof = proofs.get(path)
            proof_supports_value = True
            if proof:
                text = cell.text if cell else passage.text
                valid = valid and proof["segment"] == passage.id and proof.get("cell") == link.get("cell") and proof["quote"] in text
                proof_supports_value = key in actual_claims and contains(proof["quote"], json.loads(actual_claims[key]))
                if "start" in proof:
                    valid = valid and 0 <= proof["start"] < proof["end"] <= len(passage.text) and passage.text[proof["start"]:proof["end"]] == proof["quote"]
            source_valid += int(valid)
            possible = inverse.get((place, actual_claims.get(key)), set())
            # Document-scoped values are repeated in Catalog output; those copies share legitimate support.
            same_claim = {k[3:] if k[0] == "metadata" else k for k in possible}
            unambiguous = len(same_claim) == 1
            ambiguous += int(valid and key in possible and not unambiguous)
            coarse += int(valid and passage.table is not None and cell is None)
            correct = valid and proof_supports_value and key in matching_claims and key in possible and unambiguous
            attributed += int(correct)
            if correct:
                supported.add(key)
                object_correct += int(key[0] == "item")
                metadata_correct += int(key[0] == "metadata")
        except (KeyError, TypeError, ValueError):
            malformed += 1
            continue
    members_wanted = sum(sum(counts.values()) for counts in gold["arrays"].values())
    members_actual = sum(sum(counts.values()) for counts in actual["arrays"].values())
    members_matched = sum(sum((counts & actual["arrays"].get(key, Counter())).values()) for key, counts in gold["arrays"].items())
    exact_arrays = sum(actual["arrays"].get(key) == counts for key, counts in gold["arrays"].items())
    exact_records = []
    record_schema = json_schema(Schema.model_validate(truth["schemas"]["catalog"]).record_nodes)
    for rid in gold["ids"]:
        prefix = ("item", rid, 0)
        gold_fields = {k: v for k, v in gold["fields"].items() if k[:3] == prefix}
        actual_fields = {k: v for k, v in actual["fields"].items() if k[:3] == prefix}
        gold_arrays = {k: v for k, v in gold["arrays"].items() if k[:3] == prefix}
        actual_arrays = {k: v for k, v in actual["arrays"].items() if k[:3] == prefix}
        if rid in actual["ids"] and gold_fields == actual_fields and gold_arrays == actual_arrays:
            try:
                validate({k: v for k, v in actual["items"][prefix].items() if k not in METADATA}, record_schema)
                exact_records.append(rid)
            except ValidationError:
                pass
    cross_page = {canonical(item["record_id"]) for item in truth["items"]
                  if len({a["page"] for a in truth["annotations"] if a["record_id"] == item["record_id"]
                          and a.get("placement", "primary") == "primary"}) > 1}
    reprinted = {canonical(a["record_id"]) for a in truth["annotations"] if a.get("placement") == "reprint"}
    value_contexts = [context for group in artifact.get("value_contexts", []) for context in group]
    context_sources = [set(context["primary"]) for context in value_contexts]
    reprint_contexts = defaultdict(set)
    conflict_contexts = defaultdict(lambda: defaultdict(set))
    for annotation in truth["annotations"]:
        field = annotation["path"][0]
        if annotation.get("placement") != "reprint" and not (annotation["record_id"] is None and field in truth["contradictions"]):
            continue
        segments = {segment for segment, _ in annotation_locations(annotation, evidence)}
        indices = {n for n, primary in enumerate(context_sources) if segments & primary}
        if annotation.get("placement") == "reprint":
            reprint_contexts[annotation["record_id"]].update(indices)
        elif field in truth["contradictions"]:
            conflict_contexts[field][canonical(annotation["value"])].update(indices)
    eligibility = {}
    for field, values in truth["contradictions"].items():
        indices = [conflict_contexts[field][canonical(value)] for value in values]
        split = all(indices) and any(a != b for first in indices for second in indices for a in first for b in second)
        eligibility[field] = ("no_representation" if strategy != "article" else
                              "single_value_context" if len(value_contexts) < 2 else
                              "split_primary_contexts" if split else "unverified_or_unsplit")
    schema = json_schema(Schema.model_validate(truth["schemas"][strategy]).nodes)
    invalid_roots = 0
    for record in artifact.get("records", []):
        try:
            validate(record, schema)
        except ValidationError:
            invalid_roots += 1
    disagreements = {tuple(item.get("names", [])): {canonical(a["value"]) for a in item["alternatives"]}
                     for item in artifact.get("disagreements", [])}
    conflict_wanted = sum(len(values) for values in truth["contradictions"].values())
    conflict_matched = sum(len({canonical(v) for v in values} & disagreements.get((field,), set()))
                          for field, values in truth["contradictions"].items())
    conflict_actual = sum(len(values) for values in disagreements.values())
    def unique_claim(key):
        return ("metadata", *key[3:]) if key[0] == "metadata" else key
    unique_gold = {unique_claim(k) for k in gold_claims}
    unique_supported = {unique_claim(k) for k in supported}
    metadata_gold = {unique_claim(k) for k in gold["metadata"]}
    metadata_supported = unique_supported & metadata_gold
    objects_supported = supported & gold["fields"].keys()
    return {
        "version": 2,
        "fields": rates(len(matched), len(actual["fields"]), len(gold["fields"])),
        "metadata": rates(len(metadata_matched), len(actual["metadata"]), len(gold["metadata"])),
        "records": {**rates(sum((actual["ids"] & gold["ids"]).values()), sum(actual["ids"].values()), len(gold["ids"])),
                    "exact": len(exact_records), "exact_recall": len(exact_records) / len(gold["ids"]),
                    "exact_unique_recall": sum(actual["ids"][rid] == 1 for rid in exact_records) / len(gold["ids"])},
        "arrays": {**rates(members_matched, members_actual, members_wanted), "exact": exact_arrays,
                   "expected_arrays": len(gold["arrays"]), "exact_fraction": exact_arrays / len(gold["arrays"])},
        "evidence": {**evidence_rates(attributed, len(artifact.get("evidence", [])), len(supported), len(gold_claims)),
                     "malformed_links": malformed,
                     "objects": evidence_rates(object_correct, object_links, len(objects_supported), len(gold["fields"])),
                     "document_metadata": {"supported": len(metadata_supported), "expected": len(metadata_gold),
                                           "recall": len(metadata_supported) / len(metadata_gold) if metadata_gold else None,
                                           "correct_links": metadata_correct, "predicted_links": metadata_links},
                     "unique_claims": {"supported": len(unique_supported), "expected": len(unique_gold),
                                       "recall": len(unique_supported) / len(unique_gold)},
                     "conditional_grounding": {"correct_links": attributed, "eligible_links": eligible_links,
                                               "precision": attributed / eligible_links if eligible_links else None},
                     "source_valid": source_valid, "ambiguous_links": ambiguous, "coarse_table_links": coarse,
                     "gold_claims_located_in_parse": len(set(bindings) & set(gold_claims)),
                     "parse_gold_coverage": len(set(bindings) & set(gold_claims)) / len(gold_claims)},
        "merge": {"duplicate_records": sum(max(0, n - 1) for n in actual["ids"].values()),
                  "duplicate_array_items": sum(max(0, n - 1) for c in actual["arrays"].values() for n in c.values()),
                  "cross_page_records": len(cross_page), "cross_page_exact": len(cross_page & set(exact_records)),
                  "reprinted_records": len(reprinted),
                  "reprint_value_contexts": {rid: sorted(indices) for rid, indices in sorted(reprint_contexts.items())},
                  "contradiction_alternatives": {**rates(conflict_matched, conflict_actual, conflict_wanted),
                      "representation": "article_disagreements" if strategy == "article" else "unavailable",
                      "value_only": True, "eligibility": eligibility,
                      "eligible_recall": (conflict_matched / conflict_wanted if conflict_wanted and
                                          all(reason == "split_primary_contexts" for reason in eligibility.values()) else None)},
                  "spurious_disagreement_fields": sum(path not in {(f,) for f in truth["contradictions"]}
                                                      for path in disagreements)},
        "structure": {"invalid_roots": invalid_roots,
                      "scope_cardinality_valid": strategy != "article" or len(artifact.get("records", [])) == 1},
        "cost": inference_cost(artifact),
    }


def inference_cost(artifact):
    calls = artifact.get("calls", [])
    return {"calls": len(calls), "failed_calls": sum(not c["ok"] for c in calls),
            "input_tokens": artifact.get("tokens", {}).get("input"),
            "output_tokens": artifact.get("tokens", {}).get("output"),
            "reported_model_seconds": sum(c["seconds"] for c in calls), "wall_seconds": artifact.get("seconds"),
            "stages": dict(Counter(c["stage"] for c in calls)), "source_contexts": len(artifact.get("contexts", [])),
            "value_contexts": sum(len(group) for group in artifact.get("value_contexts", []))}


def controls(truth: dict, artifact: dict, evidence: Evidence) -> dict:
    """Known answers and corruption probes. These scores are diagnostics, never model accuracy."""
    strategy = artifact["strategy"]
    perfect = {"strategy": strategy, "records": expected(truth, strategy), "evidence": []}
    gold = project(perfect["records"], strategy, truth["array_identities"])
    bindings = bind_gold(truth, evidence, strategy, gold)
    for path, key in gold["paths"].items():
        if key not in bindings:
            continue
        segment, cell_id = min(bindings[key], key=lambda p: (p[0], p[1] or ""))
        passage = evidence.by_id(segment)
        cell = next((c for c in passage.table.cells if c.cell_id == cell_id), None) if passage.table else None
        perfect["evidence"].append({"path": list(path), "segment": segment, "cell": cell_id, "page": passage.page,
                                    "bbox_pt": list(cell.bbox_pt if cell else passage.bbox_pt)})
    base = evaluate(truth, perfect, evidence)
    def rows(a):
        return a["records"][0]["items"] if strategy == "article" else a["records"]
    changes = {}
    skipped = []
    for name in ("wrong_value", "missing_record", "duplicate_record", "missing_array_item", "wrong_record_evidence"):
        changed = copy.deepcopy(perfect)
        items = rows(changed)
        if name == "wrong_value":
            items[0]["holding"]["box"] = "WRONG-BOX"
        elif name == "missing_record":
            items.pop()
        elif name == "duplicate_record":
            items.append(copy.deepcopy(items[0]))
        elif name == "missing_array_item":
            items[0]["observations"].pop()
        else:
            # On the repeated-value fixture, the same institution appears for both objects.
            target_path = (("records", 0, "items", 1, "holding", "institution") if strategy == "article" else
                           ("records", 1, "holding", "institution"))
            first_path = (("records", 0, "items", 0, "holding", "institution") if strategy == "article" else
                          ("records", 0, "holding", "institution"))
            targets = bindings.get(gold["paths"].get(target_path), set()) - bindings.get(gold["paths"].get(first_path), set())
            if not targets or gold["paths"].get(first_path) not in bindings:
                skipped.append(name)
                continue
            segment, cell_id = min(targets, key=lambda p: (p[0], p[1] or ""))
            other = evidence.by_id(segment)
            cell = next((c for c in other.table.cells if c.cell_id == cell_id), None) if other.table else None
            link = next(link for link in changed["evidence"] if tuple(link["path"]) == first_path)
            link.update(segment=other.id, page=other.page, bbox_pt=list(cell.bbox_pt if cell else other.bbox_pt), cell=cell_id)
        changes[name] = evaluate(truth, changed, evidence)
    assert base["fields"]["f1"] == 1 and base["records"]["recall"] == 1 and base["arrays"]["recall"] == 1
    assert changes["wrong_value"]["fields"]["f1"] < 1
    assert changes["missing_record"]["records"]["recall"] < 1
    assert changes["duplicate_record"]["records"]["precision"] < 1
    assert changes["missing_array_item"]["arrays"]["recall"] < 1
    if "wrong_record_evidence" in changes:
        assert changes["wrong_record_evidence"]["evidence"]["precision"] < base["evidence"]["precision"]
    return {"kind": "scripted evaluator controls, not model accuracy", "oracle": base, "corruptions": changes,
            "skipped": skipped}

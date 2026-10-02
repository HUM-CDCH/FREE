"""Article grounding scales with its claims, not with the size of the document root.

A bounded Article root may hold hundreds of list items. Every grounding request shows a claim with the scalar fields of
the objects that enclose it (the root's, then each enclosing item's) instead of the whole root, is routed to the source
context its value was read from first, and fits the served context with its reply. Every eligible claim ends supported,
unsupported (checked, no support) or not completed (with its reasons); excluded fields are counted apart.
"""
import json
import re

from kei_exp.kie.extract import article, grounding, run
from kei_exp.kie.extract.assembly import grounding_accounting
from kei_exp.kie.extract.llm import Reply
from kei_exp.kie.extract.method import LimitedCounter
from kei_exp.kie.extract.schema import Schema
from kei_exp.kie.extract.stages import Issue, leaves
from tests.test_extract_grounded import CountingChat, WordCounter
from tests.test_extract_stages import evidence, passages

SCHEMA = Schema.model_validate({"recordDescription": "One price list.", "schemaNodes": [
    {"id": "p", "name": "publisher", "type": "string"},
    {"id": "c", "name": "currency", "type": "string"},
    {"id": "i", "name": "items", "type": "array", "children": [
        {"id": "s", "name": "sku", "type": "string", "description": "the article number"},
        {"id": "d", "name": "description", "type": "string"},
        {"id": "u", "name": "unit", "type": "string", "description": "the unit the price is per"},
        {"id": "a", "name": "amount", "type": "number"},
        {"id": "r", "name": "parts", "type": "array", "children": [
            {"id": "n", "name": "name", "type": "string"},
            {"id": "q", "name": "qty", "type": "integer"}]}]},
]})


def item(n: int, amount: float = 7.5, parts=None) -> dict:
    return {"sku": f"77{n:03d}", "description": f"elbow {n}", "unit": "per 100", "amount": amount, "parts": parts}


def root(count: int) -> dict:
    return {"publisher": "Viega", "currency": "USD", "items": [item(n) for n in range(count)]}


def labelling(users: list[str], schemas: list[dict] | None = None):
    """A careful grounder: each claim gets the first offered evidence that prints its value, or NONE."""
    def script(system, user, schema):
        users.append(user)
        if schemas is not None:
            schemas.append(schema)
        claims = re.findall(r"^(C\d+) \([^\n]*\): ([^\n]+)$", user, re.MULTILINE)
        shown = re.findall(r"^(E\d+): ([^\n]+)$", user, re.MULTILINE)
        return {claim: next((label for label, text in shown if value in text and label in schema["properties"][claim]
                             ["enum"]), "NONE") for claim, value in claims}
    return script


def ground(fields: dict, source, *, counter=None, users=None, skip=frozenset(), script=None, schemas=None):
    users = [] if users is None else users
    counter = counter or LimitedCounter(WordCounter(), 8192)
    links, calls, issues = grounding.semantic(source, fields, SCHEMA, CountingChat(script or labelling(users, schemas)),
        record=0, counter=counter, record_context="the whole document\n{}", projected=True, skip_paths=skip)
    return links, calls, issues, users


def claim_request(fields: dict, source, path: tuple) -> str:
    every = {("records", 0, *other) for other, _ in leaves(fields)}
    *_, users = ground(fields, source, skip=frozenset(every - {("records", 0, *path)}))
    (user,) = users
    return user


def test_a_claims_request_does_not_grow_when_unrelated_items_are_added_to_the_root():
    source = passages(["Viega price list, USD.", "77000 elbow 0 per 100 7.5"])
    small = claim_request(root(2), source, ("items", 0, "description"))
    large = claim_request(root(200), source, ("items", 0, "description"))
    assert small == large and "elbow 199" not in large
    whole = json.dumps(root(200), ensure_ascii=False)
    assert whole not in large


def test_every_request_and_its_reply_fit_the_served_context():
    counter = LimitedCounter(WordCounter(), 8192)
    source = passages(["Viega price list, USD."] + [f"77{n:03d} elbow {n} per 100 7.5" for n in range(240)])
    schemas = []
    links, calls, issues, users = ground(root(240), source, counter=counter, schemas=schemas)
    assert len(calls) > 1 and not [issue for issue in issues if issue.code == "grounding_exceeds_budget"]
    for user, schema in zip(users, schemas, strict=True):
        assert counter.request_tokens(grounding.GROUNDING, user, schema) + 2048 <= counter.context_tokens
        longest = {claim: max(spec["enum"], key=len) for claim, spec in schema["properties"].items()}
        assert len(json.dumps(longest)) <= 2048  # the reply, every label at its longest, within the reserve
    assert len({link.path for link in links}) == sum(1 for _ in leaves(root(240)))


def test_a_single_claim_that_cannot_fit_fails_explicitly_once():
    fields = {"publisher": "Viega", "currency": "USD", "items": [item(0) | {"description": "x " * 9000}]}
    _, _, issues, _ = ground(fields, passages(["Viega price list, USD.", "77000 elbow per 100 7.5"]))
    refused = [issue for issue in issues if issue.code == "grounding_exceeds_budget"]
    assert {issue.path for issue in refused} == {("records", 0, "items", 0, path) for path in
                                               ("sku", "description", "unit", "amount")}
    assert len(refused) == 4 and all("exceed" in issue.detail for issue in refused)


def test_arrays_within_array_items_keep_independent_leaf_paths_and_their_enclosing_items():
    fields = {"publisher": "Viega", "currency": "USD", "items": [
        item(0, parts=[{"name": "ring", "qty": 2}, {"name": "seal", "qty": 2}]),
        item(1, parts=[{"name": "ring", "qty": 4}])]}
    source = passages(["Viega price list, USD.", "77000 elbow 0: ring x2, seal x2", "77001 elbow 1: ring x4"])
    request = claim_request(fields, source, ("items", 1, "parts", 0, "name"))
    assert '"sku": "77001"' in request and '"qty": 4' in request and '"77000"' not in request
    links, *_ = ground(fields, source)
    paths = {link.path for link in links}
    assert ("records", 0, "items", 0, "parts", 1, "name") in paths and ("records", 0, "items", 1, "parts", 0, "qty") in paths


def test_equal_values_in_different_items_carry_their_own_item_and_units():
    fields = {"publisher": "Viega", "currency": "USD", "items": [item(0, 7.5), item(1, 7.5) | {"unit": "each"}]}
    source = passages(["Viega price list, USD.", "77000 elbow 0 per 100 7.5", "77001 elbow 1 each 7.5"])
    first = claim_request(fields, source, ("items", 0, "amount"))
    second = claim_request(fields, source, ("items", 1, "amount"))
    assert '"sku": "77000"' in first and '"per 100"' in first and '"77001"' not in first
    assert '"sku": "77001"' in second and '"each"' in second and '"77000"' not in second
    assert "the unit the price is per" in claim_request(fields, source, ("items", 1, "unit"))  # the field's definition
    assert '"publisher": "Viega"' in first and '"currency": "USD"' in first  # the root's identity


def test_a_failed_batch_keeps_the_others_links_and_a_resume_grounds_only_the_unfinished_claims():
    fields = root(3)
    source = passages(["Viega price list, USD."] + [f"77{n:03d} elbow {n} per 100 7.5" for n in range(3)])
    every = {("records", 0, *path) for path, _ in leaves(fields)}
    calls_seen = []

    def failing(system, user, schema):
        calls_seen.append(user)
        if "elbow 2" in user.split("### Claims", 1)[1].split("### Evidence", 1)[0]:
            return Reply("{", 10, 2048, "length", 0.0)  # the batch holding item 2's claims is cut off
        return labelling([])(system, user, schema)
    small = LimitedCounter(WordCounter(), 2048 + 200)  # a few claims per request
    links, _, issues, _ = ground(fields, source, counter=small, script=failing)
    supported = {link.path for link in links}
    failed = {issue.path for issue in issues if issue.code == "call_failed"}
    assert failed and supported and not (failed & supported) and supported | failed <= every
    resumed_users = []
    again, *_ = ground(fields, source, counter=small, skip=frozenset(supported), users=resumed_users)
    assert {link.path for link in again} == every - supported
    assert all("elbow 0" not in user.split("### Evidence")[0] or "elbow 2" in user for user in resumed_users)


def test_the_accounting_counts_each_claim_once_with_disjoint_dispositions():
    claims = {("records", 0, "a"), ("records", 0, "b"), ("records", 0, "c"), ("records", 0, "d"), ("records", 0, "e")}
    linked = {("records", 0, "a")}
    issues = [Issue("grounding_exceeds_budget", "x", 0, ("records", 0, "c")),
              Issue("grounding_exceeds_budget", "x", 0, ("records", 0, "c")),
              Issue("call_failed", "x", 0, ("records", 0, "d")),
              Issue("evidence_policy_skipped", "unverified", 0, ("records", 0, "e"))]
    accounting = grounding_accounting(claims, linked, issues, excluded={("records", 0, "e"): "unverified"})
    assert accounting == {"claims": 5, "excluded": 1, "eligible": 4, "supported": 1, "unsupported": 1,
                          "not_completed": 2, "reasons": {"call_failed": 1, "grounding_exceeds_budget": 1},
                          "excluded_policies": {"unverified": 1}}
    assert grounding_accounting(claims, set(), [], disabled=True)["reasons"] == {"grounding_disabled": 5}


def test_a_bounded_article_root_with_many_items_is_grounded_where_each_value_was_read():
    """The measured failure: a bounded Article root with hundreds of items had no evidence at all."""
    texts = [f"Viega price list, USD. Page {page}. " + " ".join(f"77{n:03d} elbow {n} per 100 7.5"
             for n in range(page * 60, page * 60 + 60)) + " filler" * 2500 for page in range(4)]
    users = []

    def script(system, user, schema):
        if "items" in schema["properties"]:  # the document root, read in each value context
            numbers = sorted({int(n) for n in re.findall(r"77(\d{3}) elbow", user)})
            return {"publisher": "Viega", "currency": "USD", "items": [item(n) for n in numbers]}
        return labelling(users)(system, user, schema)
    request = run.ExtractRequest.model_validate({"schema": {**SCHEMA.model_dump(by_alias=True, exclude_none=True),
        "recordScope": "document"}, "options": {"strategy": "article", "article": {"context": "bounded",
        "context_tokens": 8192}}})
    result = run.dispatch(None, evidence(passages(texts)), request, CountingChat(script),
                          counter={role: WordCounter() for role in ("fields", "reasoning")})
    assert len(result["records"]) == 1 and len(result["records"][0]["items"]) == 240
    assert len(result["value_contexts"][0]) == 4
    assert result["grounding"]["eligible"] == 2 + 240 * 4 and result["grounding"]["supported"] == 2 + 240 * 4
    assert not any(issue["code"] == "grounding_exceeds_budget" for issue in result["issues"])
    item_users = [user for user in users if "77" in user]
    assert item_users and all(len(set(re.findall(r"Page (\d)", user.split("### Evidence")[1]))) == 1
                              for user in item_users)  # each item claim is checked in the context it was read from
    assert result["article_version"] == article.ARTICLE_VERSION == 6


def test_contested_unsupported_and_uncompleted_claims_stay_distinct_through_the_article_path():
    """Scripted outcomes: two contexts disagree on the currency (contested: null, no claim is made of it); item 1's
    description is printed nowhere (checked everywhere: unsupported); item 2's own fields cannot fit any request (not
    completed, refused by the budget in every context it is routed to)."""
    texts = ["Viega price list. Currency USD. 77000 elbow 0 per 100 7.5" + " filler" * 2600,
             "Viega price list. Currency EUR. 77001 per 100 7.5. 77002 elbow 2 per 100 7.5" + " filler" * 2600]

    def script(system, user, schema):
        if "items" in schema["properties"]:
            first = "USD" in user
            return {"publisher": "Viega", "currency": "USD" if first else "EUR",
                    "items": [item(0)] if first else [item(1) | {"description": "not printed"},
                                                       item(2) | {"description": "elbow 2 " + "x " * 9000}]}
        return labelling([])(system, user, schema)
    request = run.ExtractRequest.model_validate({"schema": {**SCHEMA.model_dump(by_alias=True, exclude_none=True),
        "recordScope": "document"}, "options": {"strategy": "article", "article": {"context": "bounded",
        "context_tokens": 8192}}})
    result = run.dispatch(None, evidence(passages(texts)), request, CountingChat(script),
                          counter={role: WordCounter() for role in ("fields", "reasoning")})
    record = result["records"][0]
    assert record["currency"] is None and result["conflicts"]["records"] == [
        {"record": 0, "path": ["currency"], "candidates": ["USD", "EUR"]}]
    accounting = result["grounding"]
    assert accounting["claims"] == accounting["eligible"] == 1 + 3 * 4  # no claim of the contested currency
    assert accounting["unsupported"] == 1 and accounting["not_completed"] == 4
    assert accounting["reasons"] == {"grounding_exceeds_budget": 4}
    refusals = [issue for issue in result["issues"] if issue["code"] == "grounding_exceeds_budget"]
    assert len({tuple(issue["path"]) for issue in refusals}) == 4 <= len(refusals)  # four claims, refused per context
    linked = {tuple(link["path"]) for link in result["evidence"]}
    assert ("records", 0, "items", 1, "description") not in linked and ("records", 0, "items", 1, "sku") in linked
    assert not any(path[3] == 2 for path in linked if len(path) > 3)


def test_a_claim_inside_a_nested_object_keeps_that_objects_fields():
    nested = Schema.model_validate({"recordDescription": "One order.", "schemaNodes": [
        {"id": "b", "name": "buyer", "type": "object", "children": [
            {"id": "n", "name": "name", "type": "string"}, {"id": "c", "name": "city", "type": "string"}]}]})
    users = []
    grounding.semantic(passages(["Buyer: Berg, Ribe."]), {"buyer": {"name": "Berg", "city": "Ribe"}}, nested,
        CountingChat(labelling(users)), record=0, counter=LimitedCounter(WordCounter(), 8192),
        record_context="the whole document\n{}", projected=True)
    assert 'Within buyer: {"name": "Berg", "city": "Ribe"}' in users[0]


def price_table(count: int):
    """One table passage: a row per item, every row printing the same amount 7.5."""
    from dataclasses import replace

    from kei_exp.pagefile import PageTable, TableCell
    rows = [(f"77{n:03d}", f"elbow {n}", "per 100", "7.5") for n in range(count)]
    text = "".join("\t".join(row) + "\n" for row in rows)
    cells, at = [], 0
    for r, row in enumerate(rows):
        for c, value in enumerate(row):
            start = text.index(value, at)
            cells.append(TableCell(cell_id=f"r{r}_c{c}", row=r, column=c, rowspan=1, colspan=1, role="data",
                                   text=value, start=start, end=start + len(value), bbox_pt=None))
            at = start + len(value)
    return replace(passages([text])[0], label="Table", table=PageTable(rows=count, columns=4, cells=cells,
                                                                      producer="docling"))


def test_a_value_printed_in_many_rows_is_offered_in_its_own_items_row():
    """`7.5` is printed in all 120 rows; item 7's claim is offered the cell in the row that also prints its sku."""
    fields = root(120)
    table = price_table(120)
    request = claim_request(fields, [table], ("items", 7, "amount"))
    offered = re.findall(r"^(E\d+): Cell p1_s0/(r\d+_c\d+)", request, re.MULTILINE)
    assert [cell for _, cell in offered] == ["r7_c3"]
    links, _, issues, _ = ground(fields, [table], skip=frozenset(
        ("records", 0, *path) for path, _ in leaves(fields) if path != ("items", 7, "amount")))
    assert [link.path for link in links] == [("records", 0, "items", 7, "amount")] and not issues


def test_without_its_items_row_a_value_keeps_every_cell_that_prints_it():
    fields = {"publisher": "Viega", "currency": "USD", "items": [item(999)]}  # its sku is printed nowhere
    request = claim_request(fields, [price_table(5)], ("items", 0, "amount"))
    assert len(re.findall(r"^E\d+: Cell p1_s0/r\d+_c3", request, re.MULTILINE)) == 5


def test_a_claim_without_an_origin_is_checked_first_where_its_items_values_are_printed():
    """No origin is known (a replay of a saved artifact); `5` is printed in both contexts, the item's article number only
    in the second: that context is tried first."""
    from kei_exp.kie.extract.contexts import Context
    from kei_exp.kie.extract.routing import verify_routed
    p = passages(["70001 tee 5 9.9 70002 cap 5 1.1 " * 20, "77027 elbow 5 23.47 77032 elbow 5 46.0"])
    fields = {"publisher": "Viega", "currency": "USD", "items": [
        {"sku": "77027", "description": "elbow", "unit": None, "amount": 5, "parts": None}]}
    origins = [{"path": list(path), "kind": "value", "sources": []} for path, _ in leaves(fields)]
    tried = []

    def verifier(passages, fields, schema, chat, *, skip_paths, **_):
        claims = {("records", 0, *path) for path, _ in leaves(fields)} - skip_paths
        tried.extend((passages[0].id, path[-1]) for path in claims if path[-1] == "amount")
        return [], [], []
    contexts = [Context((p[0],)), Context((p[1],))]
    verify_routed(contexts, fields, SCHEMA, None, origins=origins, value_contexts=contexts, record=0,
                  verifier=verifier)
    assert tried[0] == ("p1_s1", "amount")

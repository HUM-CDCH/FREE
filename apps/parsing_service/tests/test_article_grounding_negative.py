"""Negative cases around the projected Article grounder: what its requests let a careful model judge, and what they cannot.

Every grounder here is a scripted closure over the request text. It tests control flow, never semantic judgement: what
each request offers (the selectable `### Evidence` labels) and shows (the claim, its enclosing item's fields and the
table's row/header context), and what `verify` records for each reply (a link with its `verbatim`, `hits` and
precision, or an issue, or nothing). A "careful" grounder answers NONE when the request shows the trap; the careless
`labelling` takes the first offered evidence line that prints the value. Whether a served model is careful is measured
elsewhere; where no request can expose the error (a printed qualifier) only human semantic validation catches it.
A routed case pins that first-support stopping leaves a later context unchecked, and that the route records it.
"""
import re
from dataclasses import replace

import pytest

from kei_exp.kie.extract import grounding
from kei_exp.kie.extract.contexts import Context
from kei_exp.kie.extract.method import LimitedCounter
from kei_exp.kie.extract.routing import verify_routed
from kei_exp.kie.extract.schema import Schema
from kei_exp.kie.extract.stages import leaves
from kei_exp.pagefile import PageTable, TableCell
from tests.test_article_grounding_scale import SCHEMA, labelling
from tests.test_extract_grounded import CountingChat, WordCounter
from tests.test_extract_stages import passages

GROUPED = Schema.model_validate({"recordDescription": "One price list.", "schemaNodes": [
    {"id": "p", "name": "publisher", "type": "string"},
    {"id": "i", "name": "items", "type": "array", "children": [
        {"id": "s", "name": "sku", "type": "string", "description": "the article number"},
        {"id": "d", "name": "description", "type": "string"},
        {"id": "k", "name": "pack_qty", "type": "number", "description": "the quantity per pack"},
        {"id": "a", "name": "price", "type": "number"},
        {"id": "g", "name": "product_group", "type": "string", "description": "the section the item is listed under"}]}]})
ROLES = {"header": "column_header", "section": "row_section", "data": "data"}
CONTEXT_LINE = re.compile(r"^(r\d+_c\d+) row=(\d+) column=(\d+) rowspan=\d+ colspan=\d+ (\w+): '(.*)'$", re.MULTILINE)


def grid(lines: list[tuple[str, tuple[str, ...]]], page: int = 1):
    """One table passage (`p<page>_s0`), a line per row: ('header' | 'section' | 'data', cells). A section line is one
    `row_section` cell spanning the columns. Every cell has measured geometry, so a link to it has cell precision."""
    columns = max(len(cells) for kind, cells in lines if kind != "section")
    text = "".join("\t".join(cells) + "\n" for _, cells in lines)
    found, at = [], 0
    for row, (kind, cells) in enumerate(lines):
        for column, value in enumerate(cells):
            start = text.index(value, at)
            found.append(TableCell(cell_id=f"r{row}_c{column}", row=row, column=column, rowspan=1,
                                   colspan=columns if kind == "section" else 1, role=ROLES[kind], text=value,
                                   start=start, end=start + len(value), bbox_pt=(column * 50.0, row * 10.0,
                                                                                 column * 50.0 + 49, row * 10.0 + 9)))
            at = start + len(value)
    return replace(passages([text], page)[0], label="Table", table=PageTable(rows=len(lines), columns=columns, cells=found,
                                                                      producer="docling"))


def ground(fields: dict, source, path: tuple, script, schema: Schema = SCHEMA):
    """The real `grounding.semantic(..., projected=True)` on one claim (`path` below the record); the others skipped."""
    every = {("records", 0, *other) for other, _ in leaves(fields)}
    users: list[str] = []

    def recording(system, user, reply_schema):
        users.append(user)
        return script(system, user, reply_schema)
    links, _, issues = grounding.semantic(source, fields, schema, CountingChat(recording), record=0,
        counter=LimitedCounter(WordCounter(), 8192), record_context="the whole document\n{}", projected=True,
        skip_paths=frozenset(every - {("records", 0, *path)}))
    (user,) = users
    return links, issues, user


@pytest.fixture
def without_context_rows(monkeypatch):
    """Builds a request as it would be without the item's own context rows: `_grounding_evidence` ignores them."""
    printed = grounding._grounding_evidence

    def build(*args):
        with monkeypatch.context() as patch:
            patch.setattr(grounding, "_grounding_evidence", lambda labelled, **_: printed(labelled))
            return ground(*args)[2]
    return build


def claims_part(user: str) -> str:
    return user.split("### Claims\n", 1)[1].split("\n### Evidence\n", 1)[0]


def evidence_part(user: str) -> str:
    return user.split("\n### Evidence\n", 1)[1]


def offered_cells(user: str) -> dict[str, tuple[str, str]]:
    """Each offered cell label: (cell id, its printed text)."""
    return {label: (cell, text) for label, cell, text in
            re.findall(r"^(E\d+): Cell [^/\n]+/(r\d+_c\d+): '(.*)'$", user, re.MULTILINE)}


def context(user: str) -> dict[str, dict]:
    """The table context lines: cell id -> row, column, role and text."""
    return {cell: {"row": int(row), "column": int(column), "role": role, "text": text}
            for cell, row, column, role, text in CONTEXT_LINE.findall(evidence_part(user))}


def claim(user: str) -> tuple[str, str, str]:
    """The single claim: its label, its field name and its value."""
    ((label, described, value),) = re.findall(r"^(C\d+) \(([^\n]*?)\): ([^\n]+)$", claims_part(user), re.MULTILINE)
    return label, described.split(":", 1)[0].split(".")[-1], value


def within(user: str) -> str:
    """The claim's enclosing item fields, as the request shows them."""
    return re.findall(r"^Within [^:]+: (.*)$", claims_part(user), re.MULTILINE)[-1]


def table_item(n: int, **values) -> dict:
    return {"sku": f"77{n:03d}", "description": "elbow", "unit": "per 100", "amount": 7.5, "parts": None} | values


# Step 1 -----------------------------------------------------------------------------------------------------------


def test_a_value_shown_only_in_the_prompt_is_not_source_evidence():
    """`elbow 0` is printed only in the request's own claim, never in the source. Control flow: the Evidence section
    does not carry it, so the careful `labelling` answers NONE (nothing linked, nothing reported); a grounder that
    trusts the prompt finds it in the claim and answers the only offered label (the passage), and the link records
    `verbatim is False and hits == 0` (Studio: "Value not found in the linked passage"); a grounder answering with
    the claim's own label `C1` is refused as `unknown_label` and links nothing."""
    fields = {"publisher": "Viega", "currency": "USD", "items": [table_item(0, description="elbow 0")]}
    source = passages(["77000 per 100 7.5"])
    path = ("items", 0, "description")

    careful, issues, user = ground(fields, source, path, labelling([]))
    assert "elbow 0" in claims_part(user) and "elbow 0" not in evidence_part(user)
    assert re.findall(r"^(E\d+):", evidence_part(user), re.MULTILINE) == ["E1"]  # the passage, the only offered label
    assert careful == [] and issues == []

    def trusting_the_prompt(system, user, schema):
        """Answers the first offered label other than NONE whenever the claim's value appears anywhere in the request
        (the claim line included): a stand-in for a model that trusts the prompt instead of the evidence."""
        label, _, value = claim(user)
        options = [option for option in schema["properties"][label]["enum"] if option != "NONE"]
        return {label: options[0] if value in user else "NONE"}
    (link,), issues, _ = ground(fields, source, path, trusting_the_prompt)
    assert link.path == ("records", 0, *path) and link.segment == "p1_s0"
    assert link.verbatim is False and link.hits == 0 and not issues

    links, (issue,), _ = ground(fields, source, path, lambda system, user, schema: {"C1": "C1"})
    assert links == [] and issue.code == "unknown_label" and issue.path == ("records", 0, *path)


# Step 2 -----------------------------------------------------------------------------------------------------------


def header_aware(system, user, schema):
    """Careful about columns: an offered cell supports the claim only when its column's header names the claim's field.
    Whole passages are not read. Control flow on the printed header context, not a model's reading."""
    label, field, value = claim(user)
    cells, shown = offered_cells(user), context(user)
    headers = {cell["column"]: cell["text"] for cell in shown.values() if cell["role"] == "column_header"}
    for option in schema["properties"][label]["enum"]:
        if option in cells and headers.get(shown[cells[option][0]]["column"]) == field and value in cells[option][1]:
            return {label: option}
    return {label: "NONE"}


def test_a_value_in_the_items_own_row_but_another_column_is_judged_by_the_printed_header():
    """`23.47` is the price; the claim reads it as `pack_qty`. Control flow: the request offers only the own-row cell
    printing it (`r1_c3`) and prints every column header with its column, so a header-aware grounder can answer NONE;
    the careless `labelling` links the price cell at cell precision, so the Evidence sheet names the price cell, and
    the link is verbatim with one hit: nothing in code flags it."""
    table = grid([("header", ("sku", "description", "pack_qty", "price")),
                  ("data", ("77317", "elbow", "10", "23.47"))])
    fields = {"publisher": "Viega", "items": [{"sku": "77317", "description": "elbow", "pack_qty": 23.47,
                                               "price": 23.47, "product_group": None}]}
    path = ("items", 0, "pack_qty")

    careful, issues, user = ground(fields, [table], path, header_aware, GROUPED)
    assert [cell for cell, _ in offered_cells(user).values()] == ["r1_c3"]
    headers = [line for line in evidence_part(user).splitlines() if "column_header" in line]
    assert headers == [f"r0_c{n} row=0 column={n} rowspan=1 colspan=1 column_header: '{name}'"
                       for n, name in enumerate(("sku", "description", "pack_qty", "price"))]
    assert careful == [] and issues == []
    (control,), _, _ = ground(fields, [table], ("items", 0, "price"), header_aware, GROUPED)
    assert control.cell == "r1_c3"  # the same grounder links the cell when the header names the claim's field

    (link,), issues, _ = ground(fields, [table], path, labelling([]), GROUPED)
    assert (link.cell, link.precision, link.verbatim, link.hits) == ("r1_c3", "cell", True, 1) and not issues


# Step 3 -----------------------------------------------------------------------------------------------------------


def qualifier_aware(system, user, schema):
    """Careful about qualifiers: NONE when the offered cell prints tokens beyond the value and the item's unit."""
    label, _, value = claim(user)
    unit = re.search(r'"unit": "([^"]*)"', within(user))
    for option in schema["properties"][label]["enum"]:
        text = offered_cells(user).get(option, (None, None))[1]
        if text is None or value not in text:
            continue
        rest = text.replace(value, " ")
        if unit:
            rest = rest.replace(unit.group(1), " ")
        if not re.search(r"\w", rest):
            return {label: option}
    return {label: "NONE"}


def test_a_printed_qualifier_is_shown_but_no_code_can_tell_a_qualified_value_apart():
    """The cell prints `max. 23.47`; the claim is `amount = 23.47`. Control flow: the offered line shows the whole cell
    text, so a qualifier-aware grounder can answer NONE; the careless `labelling` links it, and the link is verbatim
    (the value is a bounded token of the cell) with one hit at cell precision. Nothing in code can tell a qualified
    value from a plain one: this error is caught only by human semantic validation."""
    table = grid([("header", ("sku", "description", "unit", "amount")),
                  ("data", ("77317", "elbow", "per 100", "max. 23.47"))])
    fields = {"publisher": "Viega", "currency": "USD", "items": [table_item(317, amount=23.47)]}
    path = ("items", 0, "amount")

    careful, issues, user = ground(fields, [table], path, qualifier_aware)
    assert list(offered_cells(user).values()) == [("r1_c3", "max. 23.47")]
    assert "Cell p1_s0/r1_c3: 'max. 23.47'" in evidence_part(user)
    assert careful == [] and issues == []
    plain = grid([("header", ("sku", "description", "unit", "amount")),
                  ("data", ("77317", "elbow", "per 100", "23.47"))])
    (control,), _, _ = ground(fields, [plain], path, qualifier_aware)
    assert control.cell == "r1_c3"  # the same grounder links an unqualified cell

    (link,), issues, _ = ground(fields, [table], path, labelling([]))
    assert (link.cell, link.precision, link.verbatim, link.hits) == ("r1_c3", "cell", True, 1) and not issues


# Step 4 -----------------------------------------------------------------------------------------------------------


def ambiguity_aware(system, user, schema):
    """Careful about identity: NONE when more than one offered cell prints the value and the claim's item shows no
    article number (`_enclosing` leaves a null field out of the request)."""
    label, _, value = claim(user)
    printing = [option for option in schema["properties"][label]["enum"]
                if value in offered_cells(user).get(option, ("", ""))[1]]
    if len(printing) > 1 and '"sku"' not in within(user):
        return {label: "NONE"}
    return {label: printing[0] if printing else "NONE"}


def test_an_item_without_an_identifier_is_offered_every_row_printing_its_value():
    """Two rows print `7.5`; the item has no sku. Control flow: both cells are offered and both rows (with their skus)
    are in the table context, so an ambiguity-aware grounder can answer NONE; the careless `labelling` links the first
    and the link records `hits == 2`, the ambiguity Studio can show."""
    table = grid([("header", ("sku", "description", "unit", "amount")),
                  ("data", ("77317", "elbow", "per 100", "7.5")),
                  ("data", ("77318", "elbow", "per 100", "7.5"))])
    fields = {"publisher": "Viega", "currency": "USD", "items": [table_item(0, sku=None)]}
    path = ("items", 0, "amount")

    careful, issues, user = ground(fields, [table], path, ambiguity_aware)
    assert sorted(cell for cell, _ in offered_cells(user).values()) == ["r1_c3", "r2_c3"]
    shown = context(user)
    assert {shown[cell]["text"] for cell in ("r1_c0", "r2_c0")} == {"77317", "77318"}
    assert '"sku"' not in within(user) and careful == [] and issues == []
    identified = {**fields, "items": [table_item(317)]}
    (control,), _, _ = ground(identified, [table], path, ambiguity_aware)
    assert control.cell == "r1_c3"  # with its sku the item is offered its own row only, and the grounder links it

    (link,), issues, _ = ground(fields, [table], path, labelling([]))
    assert (link.cell, link.verbatim, link.hits) == ("r1_c3", True, 2) and not issues


def test_a_repeated_identifier_is_narrowed_by_the_items_other_values_and_counted_in_hits(without_context_rows):
    """Two rows print sku `77317` with different amounts. Control flow: the claim `amount = 23.47` is offered only the
    cell printing it. A `unit = "per 100"` claim printed in both duplicate rows: for the item whose amount is `23.47`
    its most distinctive other value is that amount, so only its own row's cell is offered (one row, not both, as
    the plan expected), while the link still records `hits == 2`; for an item whose only identifying value is the
    repeated sku (no amount read), both cells are offered and the careless link records `hits == 2`. The amount
    claim's offered cell already lies in its item's rows, so no context row is added: its request is byte-identical to
    one built without context rows."""
    table = grid([("header", ("sku", "description", "unit", "amount")),
                  ("data", ("77317", "elbow", "per 100", "23.47")),
                  ("data", ("77317", "elbow", "per 100", "46.0"))])
    fields = {"publisher": "Viega", "currency": "USD",
              "items": [table_item(317, amount=23.47), table_item(317, amount=None)]}

    links, issues, user = ground(fields, [table], ("items", 0, "amount"), labelling([]))
    assert [cell for cell, _ in offered_cells(user).values()] == ["r1_c3"]
    assert user == without_context_rows(fields, [table], ("items", 0, "amount"), labelling([]))
    assert [(link.cell, link.hits) for link in links] == [("r1_c3", 1)] and not issues

    links, issues, user = ground(fields, [table], ("items", 0, "unit"), labelling([]))
    assert [cell for cell, _ in offered_cells(user).values()] == ["r1_c2"]
    assert [(link.cell, link.hits) for link in links] == [("r1_c2", 2)] and not issues

    links, issues, user = ground(fields, [table], ("items", 1, "unit"), labelling([]))
    assert sorted(cell for cell, _ in offered_cells(user).values()) == ["r1_c2", "r2_c2"]
    assert [(link.cell, link.hits) for link in links] == [("r1_c2", 2)] and not issues


def test_an_item_located_to_many_rows_adds_no_context_rows(without_context_rows):
    """A sku-less item whose description and unit are printed in 40 rows, its amount `9.9` only in another row: the
    item is not located to one row, so no row is added to the table context. Control flow: the request is
    byte-identical to one built without context rows, and the offered cell is unchanged."""
    table = grid([("header", ("sku", "description", "unit", "amount"))]
                 + [("data", (f"77{n:03d}", "elbow", "per 100", "7.5")) for n in range(40)]
                 + [("data", ("70001", "tee", "each", "9.9"))])
    fields = {"publisher": "Viega", "currency": "USD", "items": [table_item(0, sku=None, amount=9.9)]}
    path = ("items", 0, "amount")

    _, _, user = ground(fields, [table], path, labelling([]))
    assert [cell for cell, _ in offered_cells(user).values()] == ["r41_c3"]
    assert user == without_context_rows(fields, [table], path, labelling([]))
    assert {cell["row"] for cell in context(user).values()} == {0, 41}


# Step 5 -----------------------------------------------------------------------------------------------------------


def section_aware(system, user, schema):
    """Careful about sections: places the item at the context row printing its sku and accepts a `row_section` cell
    only when it is the nearest section above that row. NONE when the item cannot be placed."""
    label, _, value = claim(user)
    sku = re.search(r'"sku": "([^"]*)"', within(user))
    shown = context(user).values()
    rows = [cell["row"] for cell in shown if cell["role"] == "data" and sku and cell["text"] == sku.group(1)]
    if len(rows) != 1:
        return {label: "NONE"}
    above = [cell for cell in shown if cell["role"] == "row_section" and cell["row"] < rows[0]]
    nearest = max(above, key=lambda cell: cell["row"])["text"] if above else None
    for option, (_, text) in offered_cells(user).items():
        if option in schema["properties"][label]["enum"] and text == value == nearest:
            return {label: option}
    return {label: "NONE"}


def test_a_section_heading_is_judged_against_the_items_own_row(without_context_rows):
    """`77400` is listed under `Tees`; the claim says `product_group = "Elbows"`. Control flow: the only offered cell is
    the `Elbows` section cell, and the table context must print the item's own row so a section-aware grounder can
    place it after the `Tees` section and answer NONE; the careless `labelling` links the `Elbows` section cell."""
    table = grid([("header", ("sku", "description", "pack_qty", "price")),
                  ("section", ("Elbows",)),
                  ("data", ("77317", "elbow", "10", "23.47")),
                  ("data", ("77318", "elbow", "10", "46.0")),
                  ("section", ("Tees",)),
                  ("data", ("77400", "tee", "5", "9.9"))])
    fields = {"publisher": "Viega", "items": [{"sku": "77400", "description": "tee", "pack_qty": 5, "price": 9.9,
                                               "product_group": "Elbows"}]}
    path = ("items", 0, "product_group")

    careful, issues, user = ground(fields, [table], path, section_aware, GROUPED)
    assert list(offered_cells(user).values()) == [("r1_c0", "Elbows")]
    shown = context(user)
    assert shown["r1_c0"]["role"] == shown["r4_c0"]["role"] == "row_section"
    assert shown["r5_c0"] == {"row": 5, "column": 0, "role": "data", "text": "77400"}  # the item's own row
    assert "r5_c0" not in context(without_context_rows(fields, [table], path, section_aware, GROUPED))
    assert careful == [] and issues == []
    listed = {**fields, "items": [{"sku": "77317", "description": "elbow", "pack_qty": 10, "price": 23.47,
                                   "product_group": "Elbows"}]}
    (control,), _, _ = ground(listed, [table], path, section_aware, GROUPED)
    assert control.cell == "r1_c0"  # an item listed under Elbows is linked to the Elbows section

    (link,), issues, _ = ground(fields, [table], path, labelling([]), GROUPED)
    assert (link.cell, link.precision, link.verbatim, link.hits) == ("r1_c0", "cell", True, 1) and not issues


# Routing ----------------------------------------------------------------------------------------------------------


def test_first_support_leaves_a_later_context_printing_the_value_unchecked_and_the_route_says_so():
    """`7.5` is printed in two contexts: in context 1 in the row of the item's sku `77317`, in context 0 under another
    sku. No origin is known. Control flow through `routing.verify_routed` with the real projected `grounding.semantic`:
    routing tries context 1 first (it prints the item's sku), the careless `labelling` links its cell, and the route
    stops there: context 0 is never sent to the grounder, and the route records `coverage == "stopped_after_support"`
    with context 0 still remaining. A recorded coverage state, not a discarded contradiction: this is why verifier
    support is not proof that every conflicting source was considered."""
    header = ("header", ("sku", "description", "unit", "amount"))
    other = grid([header, ("data", ("77999", "elbow", "per 100", "7.5"))], page=1)
    own = grid([header, ("data", ("77317", "elbow", "per 100", "7.5"))], page=2)
    contexts = [Context((other,)), Context((own,))]
    fields = {"publisher": "Viega", "currency": "USD", "items": [table_item(317)]}
    origins = [{"path": list(path), "kind": "value", "sources": []} for path, _ in leaves(fields)]
    claimed = ("records", 0, "items", 0, "amount")
    users: list[str] = []

    links, _, issues, routes = verify_routed(contexts, fields, SCHEMA, CountingChat(labelling(users)), origins=origins,
        value_contexts=contexts, record=0, verifier=grounding.semantic,
        skip_paths=frozenset(("records", 0, *path) for path, _ in leaves(fields)) - {claimed},
        counter=LimitedCounter(WordCounter(), 8192), record_context="the whole document\n{}", projected=True)
    (route,) = routes
    assert route["value_match_units"] == [0, 1] and route["order"] == [1, 0]
    assert [(link.path, link.segment, link.cell) for link in links] == [(claimed, "p2_s0", "r1_c3")] and not issues
    assert route["attempted"] == [1] and route["remaining"] == [0] and route["coverage"] == "stopped_after_support"
    assert len(users) == 1 and "77999" not in users[0]  # context 0 was never shown to the grounder

import assert from "node:assert/strict";
import { test } from "node:test";
import type { SchemaNode } from "extraction/schema";
import {
  buildExportTable,
  createExtractionResultExportControl,
  deriveRowsRepresentOptions,
  ROOT_ROWS,
  type OtherRepeatedFields,
} from "./table.js";

const scalar = (id: string, name: string, type: "string" | "number" | "boolean" = "string"): SchemaNode =>
  ({ id, name, type });
const object = (id: string, name: string, children: SchemaNode[]): SchemaNode =>
  ({ id, name, type: "object", children });
const repeated = (id: string, name: string, children: SchemaNode[]): SchemaNode =>
  ({ id, name, type: "array", children });
const scalarArray = (id: string, name: string): SchemaNode =>
  ({ id, name, type: "array", itemType: "string" });
const choices = (rowsRepresent: string, otherRepeatedFields: OtherRepeatedFields = "preserve") =>
  ({ rowsRepresent, otherRepeatedFields });

const schema: SchemaNode[] = [
  scalar("title", "title"),
  object("meta", "meta", [
    scalar("year", "year", "number"),
    repeated("sections", "sections", [
      scalar("heading", "heading"),
      repeated("paragraphs", "paragraphs", [
        scalar("text", "text"),
        scalarArray("tags", "tags"),
      ]),
      repeated("notes", "notes", [scalar("kind", "kind")]),
    ]),
  ]),
  repeated("contributors", "contributors", [scalar("name", "name")]),
  scalar("evidence", "Evidence"),
  scalar("internal", "_internal"),
  scalar("after", "after"),
];

test("derives the root and nested repeated-object paths through ordinary objects", () => {
  assert.deepEqual(deriveRowsRepresentOptions(schema), [
    { value: ROOT_ROWS, label: "Root result" },
    { value: "meta.sections", label: "meta.sections[]" },
    { value: "meta.sections.paragraphs", label: "meta.sections[].paragraphs[]" },
    { value: "meta.sections.notes", label: "meta.sections[].notes[]" },
    { value: "contributors", label: "contributors[]" },
  ]);
  assert.equal(createExtractionResultExportControl(schema).otherRepeatedFields.value, "preserve");
});

test("projects a selected nested path with root and ancestor scalar context", () => {
  const table = buildExportTable(schema, {
    title: "Paper",
    meta: { year: 2026, sections: [
      { heading: "A", paragraphs: [{ text: "One", tags: ["x", "y"] }, { text: "Two", tags: [] }] },
      { heading: "B", paragraphs: [{ text: "Three", tags: ["z"] }] },
    ] },
    after: "last",
  }, choices("meta.sections.paragraphs", "omit"));

  assert.deepEqual(table.columns, [
    "title", "meta.year", "meta.sections.heading", "meta.sections.paragraphs.text",
    "meta.sections.paragraphs.tags", "Evidence", "_internal", "after",
  ]);
  assert.deepEqual(table.rows.map((row) => ({ ...row })), [
    { title: "Paper", "meta.year": 2026, "meta.sections.heading": "A", "meta.sections.paragraphs.text": "One", "meta.sections.paragraphs.tags": "x, y", Evidence: null, _internal: null, after: "last" },
    { title: "Paper", "meta.year": 2026, "meta.sections.heading": "A", "meta.sections.paragraphs.text": "Two", "meta.sections.paragraphs.tags": "", Evidence: null, _internal: null, after: "last" },
    { title: "Paper", "meta.year": 2026, "meta.sections.heading": "B", "meta.sections.paragraphs.text": "Three", "meta.sections.paragraphs.tags": "z", Evidence: null, _internal: null, after: "last" },
  ]);
});

test("preserves sibling repeated fields as ordered indexed columns or omits them", () => {
  const result = {
    title: "Paper",
    meta: { year: 2026, sections: [{
      heading: "A",
      paragraphs: [{ text: "One", tags: [] }],
      notes: [{ kind: "first" }, { kind: "second" }],
    }] },
    contributors: [{ name: "Ada" }],
    after: "last",
  };
  const preserved = buildExportTable(schema, result, choices("meta.sections.paragraphs"));
  assert.deepEqual(preserved.columns, [
    "title", "meta.year", "meta.sections.heading", "meta.sections.paragraphs.text",
    "meta.sections.paragraphs.tags", "meta.sections.notes.0.kind", "meta.sections.notes.1.kind",
    "contributors.0.name", "Evidence", "_internal", "after",
  ]);
  const omitted = buildExportTable(schema, result, choices("meta.sections.paragraphs", "omit"));
  assert.ok(!omitted.columns.some((column) => column.includes("notes") || column.includes("contributors")));
});

test("keeps schema-ordered headers for an empty selected collection", () => {
  const table = buildExportTable(schema, {
    title: "Empty", meta: { year: 2026, sections: [{ heading: "A", paragraphs: [] }] }, after: "last",
  }, choices("meta.sections.paragraphs", "omit"));
  assert.deepEqual(table.columns, [
    "title", "meta.year", "meta.sections.heading", "meta.sections.paragraphs.text",
    "meta.sections.paragraphs.tags", "Evidence", "_internal", "after",
  ]);
  assert.deepEqual(table.rows, []);
});

test("supports one or many root records and keeps declared Evidence and _-prefixed fields", () => {
  const one = buildExportTable(schema, { title: "One", Evidence: "cited", _internal: "kept", after: "x" }, choices(ROOT_ROWS, "omit"));
  assert.equal(one.rows.length, 1);
  assert.deepEqual(one.columns, ["title", "meta.year", "Evidence", "_internal", "after"]);
  assert.deepEqual({ ...one.rows[0] }, { title: "One", "meta.year": null, Evidence: "cited", _internal: "kept", after: "x" });
  const many = buildExportTable(schema, [
    { title: "One", meta: { year: 1 }, after: "a" },
    { title: "Two", meta: { year: 2 }, after: "b" },
  ], choices(ROOT_ROWS, "omit"));
  assert.deepEqual(many.rows.map((row) => row.title), ["One", "Two"]);
});

test("emits selected rows across multiple root records", () => {
  const table = buildExportTable(schema, [
    { title: "One", meta: { sections: [{ paragraphs: [{ text: "A" }] }] } },
    { title: "Two", meta: { sections: [{ paragraphs: [{ text: "B" }, { text: "C" }] }] } },
  ], choices("meta.sections.paragraphs", "omit"));
  assert.deepEqual(table.rows.map((row) => [row.title, row["meta.sections.paragraphs.text"]]), [
    ["One", "A"], ["Two", "B"], ["Two", "C"],
  ]);
});

test("preserves escaped schema paths and rejects non-finite numbers", () => {
  const escaped = [
    scalar("dot", "a.b", "number"),
    object("a", "a", [scalar("b", "b", "number"), scalar("zero", "0")]),
    scalar("slash", "a\\b"),
    repeated("items", "items", [scalar("name", "name")]),
  ];
  const table = buildExportTable(
    escaped,
    { "a.b": 1, a: { b: 2, "0": "object key" }, "a\\b": "x", items: [{ name: "array item" }] },
    choices(ROOT_ROWS),
  );
  assert.deepEqual(table.columns, ["a\\.b", "a.b", "a.\\0", "a\\\\b", "items.0.name"]);
  assert.throws(() => buildExportTable([scalar("score", "score", "number")], { score: Number.NaN }, choices(ROOT_ROWS)), /finite number/);
});

test("keeps every declared field whatever its name, in nested objects and repeated objects", () => {
  const declared = [
    scalar("title", "title"),
    scalar("evidence", "evidence"),
    object("internal", "internal", [
      scalar("Evidence", "Evidence"),
      scalar("catalogue", "_catalogue_id"),
    ]),
    repeated("entries", "_entries", [
      scalar("page", "page"),
      scalar("entryEvidence", "evidence"),
      scalar("entryInternal", "internal"),
    ]),
  ];
  const record = {
    title: "Paper",
    evidence: "quoted",
    internal: { Evidence: "nested", _catalogue_id: "C-1" },
    _entries: [{ page: "3", evidence: "first", internal: "a" }, { page: "4", evidence: "second", internal: "b" }],
  };

  assert.deepEqual(deriveRowsRepresentOptions(declared), [
    { value: ROOT_ROWS, label: "Root result" },
    { value: "_entries", label: "_entries[]" },
  ]);
  assert.deepEqual(buildExportTable(declared, record, choices(ROOT_ROWS)).columns, [
    "title", "evidence", "internal.Evidence", "internal._catalogue_id",
    "_entries.0.page", "_entries.0.evidence", "_entries.0.internal",
    "_entries.1.page", "_entries.1.evidence", "_entries.1.internal",
  ]);
  const rows = buildExportTable(declared, record, choices("_entries"));
  assert.deepEqual(rows.columns, [
    "title", "evidence", "internal.Evidence", "internal._catalogue_id",
    "_entries.page", "_entries.evidence", "_entries.internal",
  ]);
  assert.deepEqual(rows.rows.map((row) => [row["internal._catalogue_id"], row["_entries.evidence"], row["_entries.internal"]]), [
    ["C-1", "first", "a"], ["C-1", "second", "b"],
  ]);
});

test("a data key the approved schema does not declare never becomes a column", () => {
  const table = buildExportTable(
    [scalar("title", "title"), repeated("items", "items", [scalar("name", "name")])],
    { title: "Paper", evidence: "system", _run: "x", items: [{ name: "a", bbox: [1, 2] }] },
    choices(ROOT_ROWS),
  );
  assert.deepEqual(table.columns, ["title", "items.0.name"]);
});

test("exports a unified Catalog result the Parsing Service produced, by list item or by record", async () => {
  const contract = (await import("../../../prototypes/parsing_service/tests/fixtures/contracts/extract.result.v3.json",
    { with: { type: "json" } })).default;
  const nodes = contract.request.request.schema.schemaNodes as SchemaNode[];
  const byItem = buildExportTable(nodes, contract.artifact.records, choices("finds"));
  assert.deepEqual(byItem.columns, ["label", "site", "material", "gilded", "finds.name", "finds.count", "title"]);
  assert.deepEqual(byItem.rows.map((row) => [row.label, row["finds.name"], row["finds.count"], row.title]),
    [["12", "Nadel", 2, "Fundkatalog Süd"]]);
  const byRecord = buildExportTable(nodes, contract.artifact.records, choices(ROOT_ROWS));
  assert.deepEqual(byRecord.rows.map((row) => [row.label, row.material, row.gilded]), [["12", "Bronze", null], ["第3号", "Jade", true]]);
});

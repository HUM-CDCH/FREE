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
    "meta.sections.paragraphs.tags", "after",
  ]);
  assert.deepEqual(table.rows.map((row) => ({ ...row })), [
    { title: "Paper", "meta.year": 2026, "meta.sections.heading": "A", "meta.sections.paragraphs.text": "One", "meta.sections.paragraphs.tags": "x, y", after: "last" },
    { title: "Paper", "meta.year": 2026, "meta.sections.heading": "A", "meta.sections.paragraphs.text": "Two", "meta.sections.paragraphs.tags": "", after: "last" },
    { title: "Paper", "meta.year": 2026, "meta.sections.heading": "B", "meta.sections.paragraphs.text": "Three", "meta.sections.paragraphs.tags": "z", after: "last" },
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
    "contributors.0.name", "after",
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
    "meta.sections.paragraphs.tags", "after",
  ]);
  assert.deepEqual(table.rows, []);
});

test("supports one or many root records and excludes evidence/internal fields", () => {
  const one = buildExportTable(schema, { title: "One", Evidence: "secret", _internal: "secret", after: "x" }, choices(ROOT_ROWS, "omit"));
  assert.equal(one.rows.length, 1);
  assert.deepEqual(one.columns, ["title", "meta.year", "after"]);
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

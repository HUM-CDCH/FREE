import assert from "node:assert/strict";
import { test } from "node:test";
import type { SchemaNode } from "extraction/schema";
import {
  buildDurableEvidenceTable,
  buildDurableExportTable,
  conform,
  createFieldRegistry,
  durableRecords,
  durableSchemaNodes,
  exportedValue,
  type DurableExportValue,
} from "./durable.js";
import { ROOT_ROWS } from "./table.js";

const title: SchemaNode = { id: "title", name: "title", type: "string" };
const year: SchemaNode = { id: "year", name: "year", type: "integer" };
const gilded: SchemaNode = { id: "gilded", name: "gilded", type: "boolean" };
const names: SchemaNode = { id: "names", name: "names", type: "array", itemType: "string" };
const finds: SchemaNode = { id: "finds", name: "finds", type: "array", children: [
  { id: "name", name: "name", type: "string" }, { id: "count", name: "count", type: "integer" },
] };
const work: SchemaNode = { id: "work", name: "work", type: "object", children: [
  { id: "name", name: "name", type: "string" }, { id: "included", name: "included", type: "boolean" },
] };
const catalogue: SchemaNode = { id: "catalogue", name: "catalogue", type: "string", valueSource: "document" };

function saved(record: number, node: SchemaNode, modelValue: unknown, extra: Partial<DurableExportValue> = {}): DurableExportValue {
  return {
    id: `record-${record}:${node.id}`, recordId: `record-${record}`, path: ["records", record, node.name], node,
    schemaRevisionId: "revision-1", modelValue, processing: "saved", grounding: "ungrounded", links: [], correction: null,
    historicalCorrection: null, ...extra,
  };
}
const decided = (action: "APPROVED" | "EDITED" | "REJECTED" | "PENDING", value?: unknown) =>
  ({ correction: { decision: { action, ...(value === undefined ? {} : { value }) } } });
const root = { rowsRepresent: ROOT_ROWS, otherRepeatedFields: "preserve" as const };

test("exports the reviewed value when edited, nothing when rejected or unsaved, and the model's value otherwise", () => {
  assert.equal(exportedValue(saved(0, title, "Model")), "Model");
  assert.equal(exportedValue(saved(0, title, "Model", decided("APPROVED"))), "Model");
  assert.equal(exportedValue(saved(0, title, "Model", decided("PENDING"))), "Model");
  assert.equal(exportedValue(saved(0, title, "Model", decided("EDITED", "Corrected"))), "Corrected");
  assert.equal(exportedValue(saved(0, title, "Model", decided("REJECTED"))), null);
  assert.equal(exportedValue(saved(0, title, "Model", { processing: "absent" })), undefined);
  assert.equal(exportedValue(saved(0, title, "Model", { processing: "unprocessed" })), undefined);
});

test("projects one row per record with the producing schema's fields as columns, in schema order", () => {
  const values = [
    saved(0, title, "Grave 8"), saved(0, year, 0), saved(0, gilded, false), saved(0, names, ["Ada", "Bob"]),
    saved(0, finds, [{ name: "Nadel", count: 2 }, { name: "Ring", count: 1 }]), saved(0, work, { name: "Book", included: true }),
    saved(1, title, "Grave 9"), saved(1, year, 1902), saved(1, gilded, true), saved(1, names, []),
    saved(1, finds, null), saved(1, work, null),
  ];
  const table = buildDurableExportTable(values, root);
  assert.deepEqual(table.columns, [
    "title", "year", "gilded", "names", "finds.0.name", "finds.0.count", "finds.1.name", "finds.1.count", "work.name", "work.included",
  ]);
  assert.deepEqual(table.rows.map((row) => ({ ...row })), [
    { title: "Grave 8", year: 0, gilded: false, names: "Ada, Bob", "finds.0.name": "Nadel", "finds.0.count": 2, "finds.1.name": "Ring", "finds.1.count": 1, "work.name": "Book", "work.included": true },
    { title: "Grave 9", year: 1902, gilded: true, names: "", "work.name": null, "work.included": null },
  ]);
  const byFind = buildDurableExportTable(values, { rowsRepresent: "finds", otherRepeatedFields: "omit" });
  assert.deepEqual(byFind.columns, ["title", "year", "gilded", "names", "finds.name", "finds.count", "work.name", "work.included"]);
  assert.deepEqual(byFind.rows.map((row) => [row.title, row["finds.name"], row["finds.count"]]), [["Grave 8", "Nadel", 2], ["Grave 8", "Ring", 1]]);
});

test("applies compatible decisions: edits replace the value, rejections leave the cell empty, unsaved fields stay empty", () => {
  const values = [
    saved(0, title, "Model title", decided("EDITED", "Corrected title")),
    saved(0, year, 1901, decided("REJECTED")),
    saved(0, gilded, true, decided("APPROVED")),
    saved(0, names, ["Ada"], decided("EDITED", ["Ada", "Grace"])),
    saved(0, work, { name: "Model", included: false }, { processing: "unprocessed", modelValue: null }),
  ];
  const table = buildDurableExportTable(values, root);
  assert.deepEqual(table.columns, ["title", "year", "gilded", "names", "work.name", "work.included"]);
  assert.deepEqual({ ...table.rows[0] }, { title: "Corrected title", year: null, gilded: true, names: "Ada, Grace", "work.name": null, "work.included": null });
});

test("uses the declared order of matching producing fields even when model values arrived out of order", () => {
  const values = [saved(1, finds, [{ name: "Ring", count: 1 }]), saved(1, year, 1902), saved(0, title, "First"), saved(1, title, "Second")];
  const declared = [title, year, finds];
  const table = buildDurableExportTable(values, root, declared);
  assert.deepEqual(table.columns, ["title", "year", "finds.0.name", "finds.0.count"]);
  assert.deepEqual(durableSchemaNodes(values, declared).map(node => node.name), ["title", "year", "finds"]);
  // A later unrelated declaration is only an order hint; it never changes the saved values' names or types.
  const unrelated: SchemaNode = { ...year, name: "renamed year", type: "string" };
  const old = buildDurableExportTable(values, root, [unrelated, title]);
  assert.deepEqual(old.columns, ["title", "finds.0.name", "finds.0.count", "year"]);
  assert.equal(old.rows[1]!.year, 1902);
});

test("keeps actual field names distinct from generated type labels and prototype property names", () => {
  const stringYear: SchemaNode = { ...year, type: "string" };
  const labelled: SchemaNode = { id: "labelled", name: "year (string)", type: "string" };
  const special: SchemaNode = { id: "special", name: "__proto__", type: "string" };
  const values = [saved(0, year, 1901), saved(1, stringYear, "c. 1902"), saved(0, labelled, "Real field"), saved(0, special, "Literal name")];
  const table = buildDurableExportTable(values, root);
  assert.equal(new Set(table.columns).size, table.columns.length);
  assert.equal(table.rows[0]!["year (string)"], "Real field");
  assert.equal(table.rows[0]!["__proto__"], "Literal name");
  assert.equal(table.rows[1]!["year (string, 2)"], "c. 1902");
});

test("orders records by the ordinal the run found them at and repeats document-level fields on every row", () => {
  const values = [
    saved(2, title, "Third"), saved(0, title, "First"), saved(1, title, "Second"),
    { ...saved(0, catalogue, "Fundkatalog Süd"), id: "catalogue", recordId: "document", path: ["records", 0, "catalogue"] },
  ];
  const table = buildDurableExportTable(values, root);
  assert.deepEqual(table.columns, ["title", "catalogue"]);
  assert.deepEqual(table.rows.map((row) => [row.title, row.catalogue]), [["First", "Fundkatalog Süd"], ["Second", "Fundkatalog Süd"], ["Third", "Fundkatalog Süd"]]);
  const article = buildDurableExportTable([{ ...saved(0, catalogue, "Only the document"), recordId: "document" }], root);
  assert.deepEqual(article.rows.map((row) => ({ ...row })), [{ catalogue: "Only the document" }]);
  assert.deepEqual(buildDurableExportTable([], root), { columns: [], rows: [] });
});

test("keeps a field produced under two types as two named columns instead of guessing or dropping one", () => {
  const yearAsText: SchemaNode = { id: "year", name: "year", type: "string" };
  const values = [
    saved(0, title, "Old"), saved(0, year, 1901),
    { ...saved(1, title, "New"), schemaRevisionId: "revision-2" },
    { ...saved(1, yearAsText, "c. 1902"), schemaRevisionId: "revision-2" },
  ];
  const registry = createFieldRegistry();
  const records = durableRecords(values, registry);
  assert.deepEqual(registry.schemaNodes.map((node) => node.name), ["title", "year", "year (string)"]);
  assert.deepEqual(registry.ambiguous, [{ name: "year", columns: ["year", "year (string)"] }]);
  assert.deepEqual(records.map((record) => record.fields), [{ title: "Old", year: 1901 }, { title: "New", "year (string)": "c. 1902" }]);
  // Another revision with the same shape shares the column: an id or description change is not a new type.
  assert.equal(registry.column({ ...year, id: "year-v3", description: "The year" }).name, "year");
  assert.deepEqual(durableSchemaNodes(values).map((node) => node.name), ["title", "year", "year (string)"]);
});

test("fits a value to its producing node so the projection never drops it", () => {
  assert.deepEqual(conform(names, "Ada"), ["Ada"]);
  assert.deepEqual(conform(names, [1, true, null, { a: 1 }]), [1, true, null, '{"a":1}']);
  assert.equal(conform(title, { nested: 1 }), '{"nested":1}');
  assert.equal(conform(year, Number.NaN), "NaN");
  assert.deepEqual(conform(finds, { name: "Lone", count: 1 }), [{ name: "Lone", count: 1 }]);
  assert.deepEqual(conform(work, { name: "Book", included: true, extra: "dropped by schema" }), { name: "Book", included: true });
  assert.equal(conform(work, null), null);
  assert.equal(conform(title, undefined), undefined);
  // Unicode and formula-looking text pass through untouched; the writers protect formulas.
  assert.equal(conform(title, "=1+1 😀"), "=1+1 😀");
});

test("the Evidence sheet keeps one row per field with its decision, reviewed value and Evidence status", () => {
  const values = [
    saved(0, title, "Model", { ...decided("EDITED", "Corrected"), links: [{ evidenceAnchorId: "a_p1_s1" }], grounding: "grounded" }),
    saved(0, year, 1901, { ...decided("REJECTED"), grounding: "provisional" }),
    saved(0, finds, [{ name: "Nadel", count: 2 }], { historicalCorrection: { revision: 1 } }),
    saved(0, gilded, null, { processing: "absent" }),
    { ...saved(0, catalogue, "Fundkatalog"), recordId: "document" },
  ];
  const table = buildDurableEvidenceTable(values);
  assert.deepEqual(table.columns, ["Record", "Field", "Extracted value", "Decision", "Reviewed value", "Evidence", "Evidence anchors", "Schema revision", "Note"]);
  assert.deepEqual(table.rows.map((row) => [row.Record, row.Field, row["Extracted value"], row.Decision, row["Reviewed value"], row.Evidence, row["Evidence anchors"], row.Note]), [
    [1, "title", "Model", "Edited", "Corrected", "Evidence linked", "a_p1_s1", null],
    [1, "year", 1901, "Rejected", null, "Evidence still being checked", null, null],
    [1, "finds", '[{"name":"Nadel","count":2}]', "To check", null, "No Evidence linked", null, "An earlier correction does not fit this value; it stays saved and is not applied."],
    [1, "gilded", null, "No value", null, "No Evidence linked", null, null],
    ["Document", "catalogue", "Fundkatalog", "To check", null, "No Evidence linked", null, null],
  ]);
  assert.equal(table.rows.every((row) => row["Schema revision"] === "revision-1"), true);
});

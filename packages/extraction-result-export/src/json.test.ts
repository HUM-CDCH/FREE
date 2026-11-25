import assert from "node:assert/strict";
import { test } from "node:test";
import type { SchemaNode } from "extraction/schema";
import type { DurableExportValue } from "./durable.js";
import { durableJsonResults, structuredValue } from "./json.js";

const title: SchemaNode = { id: "title", name: "title", type: "string" };
const finds: SchemaNode = { id: "finds", name: "finds", type: "array", children: [
  { id: "name", name: "name", type: "string" },
  { id: "parts", name: "parts", type: "array", children: [{ id: "part", name: "part", type: "string" }, { id: "count", name: "count", type: "integer" }] },
] };
const parish: SchemaNode = { id: "parish", name: "parish", type: "object", children: [
  { id: "name", name: "name", type: "string" },
  { id: "farms", name: "farms", type: "array", itemType: "string" },
] };
const catalogue: SchemaNode = { id: "catalogue", name: "catalogue", type: "string", valueSource: "document" };

function saved(record: number, node: SchemaNode, modelValue: unknown, extra: Partial<DurableExportValue> = {}): DurableExportValue {
  return {
    id: `record-${record}:${node.id}`, recordId: `record-${record}`, path: ["records", record, node.name], node,
    schemaRevisionId: "revision-1", modelValue, processing: "saved", grounding: "ungrounded", links: [], correction: null,
    historicalCorrection: null, ...extra,
  };
}

test("keeps groups and lists nested at every depth, with every declared part present", () => {
  assert.deepEqual(structuredValue(finds, [{ name: "Axe", parts: [{ part: "blade" }] }]),
    [{ name: "Axe", parts: [{ part: "blade", count: null }] }]);
  assert.deepEqual(structuredValue(parish, { farms: ["Nørgaard"] }), { name: null, farms: ["Nørgaard"] });
  assert.equal(structuredValue(title, undefined), null);
});

test("keeps a value that does not fit its field instead of dropping it", () => {
  assert.deepEqual(structuredValue(finds, { name: "Axe" }), [{ name: "Axe", parts: null }]);
  assert.equal(structuredValue(parish, "Vor Frue"), "Vor Frue");
  assert.deepEqual(structuredValue(parish, { name: "Vor Frue", note: "old" }), { name: "Vor Frue", farms: null, note: "old" });
});

test("writes the reviewed records in the order found, document-wide fields once, rejected and missing values null", () => {
  const results = durableJsonResults([
    saved(1, title, "Second"),
    saved(0, title, "First", { correction: { decision: { action: "EDITED", value: "First, edited" } } }),
    saved(0, finds, [{ name: "Axe", parts: [{ part: "blade", count: 1 }] }]),
    saved(1, finds, [{ name: "Pot" }], { correction: { decision: { action: "REJECTED" } } }),
    saved(0, catalogue, "Museum", { recordId: "document", path: ["catalogue"] }),
  ]);
  assert.deepEqual(results, {
    document: { catalogue: "Museum" },
    records: [
      { title: "First, edited", finds: [{ name: "Axe", parts: [{ part: "blade", count: 1 }] }] },
      { title: "Second", finds: null },
    ],
  });
  assert.equal(JSON.stringify(results).includes("\\\""), false, "nested values are never written as JSON text");
});

test("has no document part when the template reads nothing from the document as a whole", () => {
  assert.deepEqual(durableJsonResults([saved(0, title, "Only")]), { records: [{ title: "Only" }] });
});

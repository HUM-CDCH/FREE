import assert from "node:assert/strict";
import { test } from "node:test";
import type { SchemaNode } from "extraction/schema";
import type { DurableExportValue } from "./durable.js";
import { durableJsonResults, structuredValue, type JsonResults } from "./json.js";

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
  const results = durableJsonResults([saved(0, title, "Only")]);
  assert.deepEqual(results, { records: [{ title: "Only" }] });
  assert.equal("disagreements" in results, false);
});

test("keeps unresolved ValueDisagreements distinguishable from absent/rejected values with readings and pages", () => {
  const year: SchemaNode = { id: "year", name: "year", type: "integer" };
  const datedParish: SchemaNode = {
    id: "parish",
    name: "parish",
    type: "object",
    children: [
      { id: "name", name: "name", type: "string" },
      year,
    ],
  };
  const results = durableJsonResults([
    saved(0, title, null, { processing: "absent" }),
    saved(0, year, null, {
      disagreement: [
        {
          path: [],
          alternatives: [
            { value: 1827, segments: ["p3_s0"] },
            { value: 1828, segments: ["p4_s0", "p9_s1"] },
          ],
        },
      ],
    }),
    saved(0, datedParish, { name: "Vor Frue", year: null }, {
      disagreement: [
        {
          path: ["year"],
          alternatives: [
            { value: 1901, segments: ["p1_s0"] },
            { value: 1902, segments: ["p2_s0"] },
          ],
        },
      ],
    }),
    saved(0, finds, [{ name: "Pot" }], { correction: { decision: { action: "REJECTED" } } }),
    saved(0, catalogue, null, {
      recordId: "document",
      path: ["catalogue"],
      disagreement: [
        {
          path: [],
          alternatives: [
            { value: "Museum North", segments: ["p1_s0"] },
            { value: "Museum South", segments: ["p5_s0"] },
          ],
        },
      ],
    }),
  ]);
  assert.deepEqual(results, {
    document: { catalogue: null },
    records: [
      { title: null, year: null, parish: { name: "Vor Frue", year: null }, finds: null },
    ],
    disagreements: [
      {
        record: null,
        field: "catalogue",
        part: "",
        path: [],
        review: "Readings differ",
        alternatives: [
          { value: "Museum North", readIn: "p. 1" },
          { value: "Museum South", readIn: "p. 5" },
        ],
      },
      {
        record: 0,
        field: "year",
        part: "",
        path: [],
        review: "Readings differ",
        alternatives: [
          { value: 1827, readIn: "p. 3" },
          { value: 1828, readIn: "pp. 4, 9" },
        ],
      },
      {
        record: 0,
        field: "parish",
        part: "year",
        path: ["year"],
        review: "Readings differ",
        alternatives: [
          { value: 1901, readIn: "p. 1" },
          { value: 1902, readIn: "p. 2" },
        ],
      },
    ],
  });
});

test("locates Value Disagreements at literal dotted keys and nested keys in both records and document", () => {
  const metadata: SchemaNode = { id: "metadata", name: "metadata", type: "object", children: [
    { id: "literal", name: "a.b", type: "string" },
    { id: "group", name: "a", type: "object", children: [{ id: "leaf", name: "b", type: "string" }] },
  ] };
  const documentMetadata: SchemaNode = { ...metadata, id: "document-metadata", name: "document metadata", valueSource: "document" };
  const alternatives = [
    { value: "First reading", segments: ["p1_s0"] },
    { value: "Second reading", segments: ["p2_s0"] },
  ];
  const blanks = { "a.b": null, a: { b: null } };
  const cases = [
    { ids: ["literal"], path: ["a.b"], chosen: { "a.b": "First reading", a: { b: null } } },
    { ids: ["group", "leaf"], path: ["a", "b"], chosen: { "a.b": null, a: { b: "First reading" } } },
  ];
  const exports: JsonResults[] = cases.map(({ ids }) => {
    const disagreement = [{ path: ids, alternatives }];
    const results = durableJsonResults([
      saved(0, metadata, blanks, { disagreement }),
      saved(0, documentMetadata, blanks, { recordId: "document", path: ["document metadata"], disagreement }),
    ]);
    return JSON.parse(JSON.stringify(results));
  });
  assert.notDeepEqual(exports[0], exports[1], "different disagreeing places need distinguishable exports");

  for (const [index, { path, chosen }] of cases.entries()) {
    const { records, document, disagreements } = exports[index]!;
    assert.deepEqual({ records, document }, { records: [{ metadata: blanks }], document: { "document metadata": blanks } });
    assert.ok(disagreements);
    assert.equal(disagreements.length, 2);
    for (const entry of disagreements) {
      assert.equal(entry.part, "a.b");
      assert.deepEqual(entry.path, path);
      const fields = entry.record === null ? document : records[entry.record];
      assert.ok(fields);
      const field = fields[entry.field] as Record<string, unknown>;
      const parent = entry.path.slice(0, -1).reduce((object, key) => object[key] as Record<string, unknown>, field);
      const key = entry.path.at(-1)!;
      assert.equal(parent[key], null);
      parent[key] = entry.alternatives[0]!.value;
    }
    assert.deepEqual(records, [{ metadata: chosen }]);
    assert.deepEqual(document, { "document metadata": chosen });
  }
});

test("fails the JSON export if a Value Disagreement path cannot be resolved", () => {
  const disputed = saved(0, parish, { name: null, farms: null }, {
    disagreement: [{
      path: ["missing"],
      alternatives: [
        { value: "Vor Frue", segments: ["p1_s0"] },
        { value: "Sankt Petri", segments: ["p2_s0"] },
      ],
    }],
  });
  assert.throws(() => durableJsonResults([disputed]), /invalid path in field "parish"/);
});

test("keeps resolved disagreement decisions, sparse record indices, and disambiguated field names in JSON", () => {
  const year: SchemaNode = { id: "year", name: "year", type: "integer" };
  const yearText: SchemaNode = { id: "year", name: "year", type: "string" };
  const alternatives = [
    { value: 1827, segments: ["p3_s0"] },
    { value: 1828, segments: ["p4_s0"] },
  ];
  const approved = saved(2, year, null, {
    disagreement: [{ path: [], alternatives }],
    correction: { decision: { action: "APPROVED", value: 1827, choices: [{ path: [], value: 1827 }] } },
  });
  const edited = saved(5, year, null, {
    disagreement: [{ path: [], alternatives }],
    correction: { decision: { action: "EDITED", value: 1829 } },
  });
  const rejected = saved(5, yearText, null, {
    disagreement: [{
      path: [],
      alternatives: [
        { value: "c. 1827", segments: ["p3_s0"] },
        { value: "c. 1828", segments: ["p4_s0"] },
      ],
    }],
    correction: { decision: { action: "REJECTED" } },
  });
  const pending = saved(0, year, null, {
    disagreement: [{ path: [], alternatives }],
    correction: { decision: { action: "PENDING" } },
  });
  const results = durableJsonResults([edited, rejected, approved, pending]);
  assert.deepEqual(results, {
    records: [
      { year: null, "year (string)": null },
      { year: 1827, "year (string)": null },
      { year: 1829, "year (string)": null },
    ],
    disagreements: [
      {
        record: 0,
        field: "year",
        part: "",
        path: [],
        review: "Readings differ",
        alternatives: [
          { value: 1827, readIn: "p. 3" },
          { value: 1828, readIn: "p. 4" },
        ],
      },
      {
        record: 1,
        field: "year",
        part: "",
        path: [],
        review: "Chosen",
        alternatives: [
          { value: 1827, readIn: "p. 3" },
          { value: 1828, readIn: "p. 4" },
        ],
      },
      {
        record: 2,
        field: "year",
        part: "",
        path: [],
        review: "Edited",
        alternatives: [
          { value: 1827, readIn: "p. 3" },
          { value: 1828, readIn: "p. 4" },
        ],
      },
      {
        record: 2,
        field: "year (string)",
        part: "",
        path: [],
        review: "Rejected",
        alternatives: [
          { value: "c. 1827", readIn: "p. 3" },
          { value: "c. 1828", readIn: "p. 4" },
        ],
      },
    ],
  });
});

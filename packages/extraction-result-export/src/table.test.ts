import assert from "node:assert/strict";
import { test } from "node:test";
import { flattenRecord, toTable } from "./table.js";

test("flattens nested objects and indexed arrays", () => {
  assert.deepEqual(
    { ...flattenRecord({
      title: "Paper",
      author: { name: "Ada" },
      contributors: [{ name: "Grace" }, { name: "Linus" }],
    }) },
    {
      title: "Paper",
      "author.name": "Ada",
      "contributors.0.name": "Grace",
      "contributors.1.name": "Linus",
    },
  );
});

test("escapes separators, so paths cannot collide", () => {
  assert.deepEqual({ ...flattenRecord({ "a.b": 1, a: { b: 2 }, "a\\b": 3 }) }, {
    "a\\.b": 1,
    "a.b": 2,
    "a\\\\b": 3,
  });
});

test("distinguishes array indexes from numeric object keys without changing schema array paths", () => {
  const table = toTable(
    [{ items: [{ name: "array" }] }, { items: { "0": { name: "object" } } }],
    ["items.0.name"],
  );

  assert.deepEqual(table.columns, ["items.0.name", "items.\\0.name"]);
  assert.equal(table.rows[0]!["items.0.name"], "array");
  assert.equal(table.rows[1]!["items.\\0.name"], "object");
});

test("keeps object-prototype names as ordinary fields", () => {
  const row = flattenRecord(JSON.parse('{"__proto__":"safe","constructor":"also safe"}'));
  assert.deepEqual(Object.keys(row), ["__proto__", "constructor"]);
  assert.equal(row["__proto__"], "safe");
});

test("keeps primitives native and writes null, undefined, and empty containers as empty", () => {
  assert.deepEqual(
    { ...flattenRecord({
      number: 4.5,
      enabled: false,
      text: "4.5",
      nothing: null,
      absent: undefined,
      emptyList: [],
      emptyObject: {},
    }) },
    {
      number: 4.5,
      enabled: false,
      text: "4.5",
      nothing: null,
      absent: null,
      emptyList: null,
      emptyObject: null,
    },
  );
});

test("rejects a number that a spreadsheet cannot hold", () => {
  assert.throws(() => flattenRecord({ score: Number.NaN }), /score must hold a finite number/);
});

test("puts schema fields first and heterogeneous fields in first-seen order", () => {
  const table = toTable(
    [
      { later: 1, name: "first" },
      { extra: true, name: "second", final: 3 },
    ],
    ["name", "missing", "name"],
  );

  assert.deepEqual(table.columns, ["name", "missing", "later", "extra", "final"]);
  assert.equal(table.rows.length, 2);
});

test("makes one row for each record, and one column for a primitive record", () => {
  assert.deepEqual(toTable([1, null, true]).rows.map((row) => ({ ...row })), [
    { value: 1 },
    { value: null },
    { value: true },
  ]);
});

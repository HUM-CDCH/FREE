import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEvidenceTable, buildExtractionTable } from "./provenance.js";

test("one Evidence row per claim keeps equal values at different paths apart and labels decisions and outcomes", () => {
  const table = buildEvidenceTable([
    { path: ["rooms", 0, "defects", 0, "defect"], extracted: "cracked tile", decision: "APPROVED", outcome: "supported", anchorId: "a_p1_s1", page: 1, precision: "segment", verbatim: true, lexicalHits: 2 },
    { path: ["rooms", 1, "defects", 1, "defect"], extracted: "cracked tile", decision: "EDITED", reviewed: "cracked tile (reviewed)", outcome: "supported", anchorId: "a_p2_s1", page: 2, precision: "segment", verbatim: true, lexicalHits: 2 },
    { path: ["publisher"], extracted: "Viega", outcome: "not_completed", reasons: ["grounding_exceeds_budget"] },
    { path: ["items", 1, "description"], extracted: "not printed", decision: "REJECTED", reviewed: null, outcome: "unsupported" },
    { path: ["notes"], extracted: "see back", outcome: "excluded", reasons: ["unverified"] },
  ]);
  assert.deepEqual(table.columns, ["Field", "Extracted value", "Decision", "Reviewed value", "Verifier outcome", "Reasons", "Evidence anchor", "Page", "Precision", "Value printed in anchor", "Other anchors printing the value"]);
  // Rows follow the result path (R11), not the order given.
  assert.deepEqual(table.rows.map((row) => [row.Field, row["Evidence anchor"], row["Verifier outcome"], row.Decision, row["Reviewed value"]]), [
    ["items[2].description", null, "Unsupported: checks finished, no evidence", "REJECTED", null],
    ["notes", null, "Excluded by schema policy", null, null],
    ["publisher", null, "Not completed", null, null],
    ["rooms[1].defects[1].defect", "a_p1_s1", "Verifier-supported", "APPROVED", null],
    ["rooms[2].defects[2].defect", "a_p2_s1", "Verifier-supported", "EDITED", "cracked tile (reviewed)"],
  ]);
  assert.equal(table.rows[3]!["Other anchors printing the value"], 1);
  assert.equal(table.rows[2]!.Reasons, "grounding_exceeds_budget");
});

test("several records name the record on each row, before the field", () => {
  const table = buildEvidenceTable([{ record: 2, path: ["site"], extracted: "Hill", outcome: "supported", anchorId: "a_p1_s2" }]);
  assert.deepEqual(table.columns.slice(0, 2), ["Record", "Field"]);
  assert.equal(table.rows[0]!.Record, 3);
});

test("a value a key or structure rule linked is never called verifier-supported", () => {
  const table = buildEvidenceTable([
    { path: ["sku"], extracted: "77317", outcome: "supported", linkedBy: "verifier", anchorId: "a_p1_s1" },
    { path: ["title"], extracted: "Catalogue", outcome: "supported", linkedBy: "rule", anchorId: "a_p1_s2" },
  ]);
  assert.deepEqual(table.columns.length, 11);
  assert.deepEqual(table.rows.map((row) => row["Verifier outcome"]), [
    "Verifier-supported",
    "Linked by rule, not verifier-checked",
  ]);
});

test("rows given out of order follow the record, then each path step: numbers numerically, names lexicographically", () => {
  const claim = (record: number, path: (string | number)[]) => ({ record, path, extracted: null, outcome: "unsupported" as const });
  const table = buildEvidenceTable([
    claim(1, ["site"]),
    claim(0, ["items", 10, "sku"]),
    claim(0, ["items", 2, "sku"]),
    claim(0, ["items", 2, "pack_qty"]),
    claim(0, ["publisher"]),
    claim(0, ["items"]),
    claim(10, ["site"]),
    claim(2, ["site"]),
  ]);
  assert.deepEqual(table.rows.map((row) => `${row.Record} ${row.Field}`), [
    "1 items", "1 items[3].pack_qty", "1 items[3].sku", "1 items[11].sku", "1 publisher", "2 site", "3 site", "11 site",
  ]);
});

test("the Extraction sheet is key/value rows in the given order", () => {
  const table = buildExtractionTable([["Extraction ID", "x-1"], ["Claims", 5], ["Not completed", 2]]);
  assert.deepEqual(table.columns, ["Item", "Value"]);
  assert.deepEqual(table.rows, [{ Item: "Extraction ID", Value: "x-1" }, { Item: "Claims", Value: 5 }, { Item: "Not completed", Value: 2 }]);
});

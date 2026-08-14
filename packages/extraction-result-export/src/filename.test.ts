import assert from "node:assert/strict";
import { test } from "node:test";
import { createExportFilename } from "./filename.js";

test("uses the source name without its path and extension", () => {
  assert.equal(
    createExportFilename("C:\\uploads\\report.final.pdf", "xlsx"),
    "report.final-extraction-result.xlsx",
  );
});

test("removes Windows hazards, reserved names, and trailing dots", () => {
  assert.equal(
    createExportFilename('bad<>:"|?* name...pdf', "csv"),
    "bad------- name-extraction-result.csv",
  );
  assert.equal(createExportFilename("CON.pdf", "csv"), "_CON-extraction-result.csv");
  assert.equal(createExportFilename("...", "csv"), "result-extraction-result.csv");
});

test("stays within the Windows name limit", () => {
  assert.equal(createExportFilename(`${"a".repeat(300)}.pdf`, "xlsx").length, 255);
});

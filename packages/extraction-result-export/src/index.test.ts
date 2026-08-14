import assert from "node:assert/strict";
import { test } from "node:test";
import { exportExtractionResult } from "./index.js";
import { stubBrowser } from "./test-browser.js";

test("downloads the visible result as CSV with the derived name", async () => {
  const browser = stubBrowser();
  try {
    await exportExtractionResult(
      { name: "Ada", active: true, notes: { source: "=cmd" } },
      { format: "csv", filename: "C:\\uploads\\source.pdf", columns: ["active", "name"] },
    );

    const [download] = browser.downloads;
    assert.equal(download!.filename, "source-extraction-result.csv");
    assert.equal(
      await download!.blob.text(),
      "active,name,notes.source\r\ntrue,Ada,'=cmd",
    );
  } finally {
    browser.restore();
  }
});

test("downloads the visible result as a workbook with the derived name", async () => {
  const browser = stubBrowser();
  try {
    await exportExtractionResult([{ score: 1 }, { score: 2 }], {
      format: "xlsx",
      filename: "report.json",
    });

    const [download] = browser.downloads;
    assert.equal(download!.filename, "report-extraction-result.xlsx");
    assert.deepEqual([...new Uint8Array(await download!.blob.arrayBuffer()).slice(0, 2)], [0x50, 0x4b]);
  } finally {
    browser.restore();
  }
});

test("rejects an unsupported format before it reads the result", async () => {
  await assert.rejects(
    exportExtractionResult({}, { format: "pdf" as "csv", filename: "source.pdf" }),
    /Unsupported export format: pdf/,
  );
});

test("rejects an oversized XLSX record array before flattening it", async () => {
  const records = new Array(1_048_576);
  Object.defineProperty(records, 0, {
    get: () => { throw new Error("flattened"); },
  });

  await assert.rejects(
    exportExtractionResult(records, { format: "xlsx", filename: "source.pdf" }),
    /1,048,577/,
  );
});

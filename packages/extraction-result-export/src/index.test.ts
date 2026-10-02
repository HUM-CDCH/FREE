import assert from "node:assert/strict";
import { test } from "node:test";
import { exportExtractionResult } from "./index.js";
import { strFromU8, unzipSync } from "fflate";
import { stubBrowser } from "./test-browser.js";

const field = (id: string, name: string, type: "string" | "number" | "boolean" = "string") =>
  ({ id, name, type } as const);

test("downloads the visible result as CSV with the derived name", async () => {
  const browser = stubBrowser();
  try {
    await exportExtractionResult(
      { name: "Ada", active: true, notes: { source: "=cmd" } },
      {
        format: "csv",
        filename: "C:\\uploads\\source.pdf",
        schemaNodes: [
          field("active", "active", "boolean"),
          field("name", "name"),
          { id: "notes", name: "notes", type: "object", children: [field("source", "source")] },
        ],
      },
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
      schemaNodes: [field("score", "score", "number")],
    });

    const [download] = browser.downloads;
    assert.equal(download!.filename, "report-extraction-result.xlsx");
    assert.deepEqual([...new Uint8Array(await download!.blob.arrayBuffer()).slice(0, 2)], [0x50, 0x4b]);
  } finally {
    browser.restore();
  }
});

test("keeps a contested field an empty cell, listing its candidates on the workbook's Review notes sheet alone", async () => {
  const browser = stubBrowser();
  const options = { filename: "source.pdf", schemaNodes: [field("name", "name"), field("year", "year", "number")] };
  const contested = [{ path: ["year"], candidates: [1901, 1902] }];
  try {
    await exportExtractionResult({ name: "Ada", year: null }, { ...options, format: "csv", contested });
    await exportExtractionResult({ name: "Ada", year: null }, { ...options, format: "xlsx", contested });
    await exportExtractionResult({ name: "Ada", year: null }, { ...options, format: "xlsx" });
    const [csv, workbook, plain] = browser.downloads;
    assert.equal(await csv!.blob.text(), "name,year\r\nAda,");
    const files = unzipSync(new Uint8Array(await workbook!.blob.arrayBuffer()));
    const plainFiles = unzipSync(new Uint8Array(await plain!.blob.arrayBuffer()));
    assert.equal(strFromU8(files["xl/worksheets/sheet1.xml"]!), strFromU8(plainFiles["xl/worksheets/sheet1.xml"]!));
    assert.equal(plainFiles["xl/worksheets/sheet2.xml"], undefined);
    assert.match(strFromU8(files["xl/workbook.xml"]!), /<sheet[^>]*name="Review notes"/);
    assert.match(strFromU8(files["xl/worksheets/sheet2.xml"]!), /<c r="C2"[^>]*><v>1901<\/v><\/c><c r="D2"[^>]*><v>1902<\/v>/);
  } finally {
    browser.restore();
  }
});

test("a provenance leaves the CSV bytes as they were and adds the Extraction and Evidence sheets to the workbook", async () => {
  const browser = stubBrowser();
  const options = { filename: "source.pdf", schemaNodes: [field("name", "name"), field("year", "year", "number")] };
  const provenance = {
    identity: [["Extraction ID", "x-1"], ["Claims", 2]] as const,
    claims: [
      { path: ["name"], extracted: "Ada", outcome: "supported", anchorId: "a_p1_s1", page: 1 },
      { path: ["year"], extracted: 1901, outcome: "unsupported" },
    ] as const,
  };
  try {
    await exportExtractionResult({ name: "Ada", year: 1901 }, { ...options, format: "csv" });
    await exportExtractionResult({ name: "Ada", year: 1901 }, { ...options, format: "csv", provenance });
    await exportExtractionResult({ name: "Ada", year: 1901 }, { ...options, format: "xlsx" });
    await exportExtractionResult({ name: "Ada", year: 1901 }, { ...options, format: "xlsx", provenance });
    const [plainCsv, csv, plain, workbook] = browser.downloads;
    assert.equal(await csv!.blob.text(), await plainCsv!.blob.text());
    assert.equal(await csv!.blob.text(), "name,year\r\nAda,1901");
    const files = unzipSync(new Uint8Array(await workbook!.blob.arrayBuffer()));
    const plainFiles = unzipSync(new Uint8Array(await plain!.blob.arrayBuffer()));
    assert.equal(strFromU8(files["xl/worksheets/sheet1.xml"]!), strFromU8(plainFiles["xl/worksheets/sheet1.xml"]!));
    assert.deepEqual([...strFromU8(files["xl/workbook.xml"]!).matchAll(/<sheet\b[^>]*name="([^"]+)"/g)].map((match) => match[1]),
      ["Results", "Extraction", "Evidence"]);
    assert.match(strFromU8(files["xl/sharedStrings.xml"]!), /<t>Unsupported: checks finished, no evidence<\/t>/);
  } finally {
    browser.restore();
  }
});

test("rejects an unsupported format before it reads the result", async () => {
  await assert.rejects(
    exportExtractionResult({}, { format: "pdf" as "csv", filename: "source.pdf", schemaNodes: [] }),
    /Unsupported export format: pdf/,
  );
});

test("rejects an oversized XLSX record array before flattening it", async () => {
  const records = new Array(1_048_576);
  Object.defineProperty(records, 0, {
    get: () => { throw new Error("flattened"); },
  });

  await assert.rejects(
    exportExtractionResult(records, {
      format: "xlsx",
      filename: "source.pdf",
      schemaNodes: [field("score", "score", "number")],
    }),
    /1,048,577/,
  );
});

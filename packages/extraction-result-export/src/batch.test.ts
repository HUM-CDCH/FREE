import assert from "node:assert/strict";
import { test } from "node:test";
import { strFromU8, unzipSync } from "fflate";
import {
  buildBatchExportTable,
  exportBatchExtractionResults,
} from "./batch.js";
import { ROOT_ROWS } from "./table.js";
import { stubBrowser } from "./test-browser.js";

const field = (name: string, type: "string" | "number" = "string") =>
  ({ id: name, name, type }) as const;

const rootChoices = {
  rowsRepresent: ROOT_ROWS,
  otherRepeatedFields: "preserve" as const,
};
const batchExtractionId = "batch-00000000-0000-4000-8000-000000000001";
const extractionResult = (...records: readonly Record<string, unknown>[]) => ({
  records,
});

test("names every row by its Source Document under the shared pinned schema", () => {
  const table = buildBatchExportTable(
    [field("title"), field("year", "number")],
    [
      {
        sourceDocumentId: "document-1",
        sourceDocumentName: "duplicate.pdf",
        result: extractionResult({ title: "A", year: 1801 }),
      },
      {
        sourceDocumentId: "document-2",
        sourceDocumentName: "duplicate.pdf",
        result: extractionResult({ title: "B", year: 1802 }),
      },
    ],
    rootChoices,
    batchExtractionId,
  );

  assert.deepEqual(table.columns, [
    "Source Document",
    "Source Document ID",
    "Batch Extraction ID",
    "title",
    "year",
  ]);
  assert.deepEqual(table.rows, [
    {
      "Source Document": "duplicate.pdf",
      "Source Document ID": "document-1",
      "Batch Extraction ID": batchExtractionId,
      title: "A",
      year: 1801,
    },
    {
      "Source Document": "duplicate.pdf",
      "Source Document ID": "document-2",
      "Batch Extraction ID": batchExtractionId,
      title: "B",
      year: 1802,
    },
  ]);
});

test("keeps one row per repeated record when rows represent an array path", () => {
  const nodes = [
    field("title"),
    {
      id: "places",
      name: "places",
      type: "array" as const,
      children: [field("name")],
    },
  ];

  const table = buildBatchExportTable(
    nodes,
    [
      {
        sourceDocumentId: "document-1",
        sourceDocumentName: "first.pdf",
        result: extractionResult({
          title: "A",
          places: [{ name: "Rome" }, { name: "Oslo" }],
        }),
      },
      {
        sourceDocumentId: "document-empty",
        sourceDocumentName: "empty.pdf",
        result: extractionResult({ title: "No places", places: [] }),
      },
      {
        sourceDocumentId: "document-2",
        sourceDocumentName: "second.pdf",
        result: extractionResult({ title: "B", places: [{ name: "Paris" }] }),
      },
    ],
    { rowsRepresent: "places", otherRepeatedFields: "preserve" },
    batchExtractionId,
  );

  assert.deepEqual(table.columns, [
    "Source Document",
    "Source Document ID",
    "Batch Extraction ID",
    "title",
    "places.name",
  ]);
  assert.deepEqual(
    table.rows.map((row) => [
      row["Source Document"],
      row["Source Document ID"],
      row["places.name"],
    ]),
    [
      ["first.pdf", "document-1", "Rome"],
      ["first.pdf", "document-1", "Oslo"],
      ["second.pdf", "document-2", "Paris"],
    ],
  );
});

test("keeps schema fields with reserved provenance names from being overwritten", () => {
  const table = buildBatchExportTable(
    [
      field("Source Document"),
      field("Source Document (2)"),
      field("Source Document ID"),
      field("Batch Extraction ID"),
    ],
    [{
      sourceDocumentId: "document-1",
      sourceDocumentName: "first.pdf",
      result: extractionResult({
        "Source Document": "cited",
        "Source Document (2)": "also cited",
        "Source Document ID": "schema-document-id",
        "Batch Extraction ID": "schema-batch-id",
      }),
    }],
    rootChoices,
    batchExtractionId,
  );

  assert.deepEqual(table.columns, [
    "Source Document (3)",
    "Source Document ID (2)",
    "Batch Extraction ID (2)",
    "Source Document",
    "Source Document (2)",
    "Source Document ID",
    "Batch Extraction ID",
  ]);
  assert.deepEqual(table.rows, [
    {
      "Source Document (3)": "first.pdf",
      "Source Document ID (2)": "document-1",
      "Batch Extraction ID (2)": batchExtractionId,
      "Source Document": "cited",
      "Source Document (2)": "also cited",
      "Source Document ID": "schema-document-id",
      "Batch Extraction ID": "schema-batch-id",
    },
  ]);
});

test("unions the indexed columns members disagree about", () => {
  const nodes = [
    {
      id: "places",
      name: "places",
      type: "array" as const,
      children: [field("name")],
    },
  ];

  const table = buildBatchExportTable(
    nodes,
    [
      {
        sourceDocumentId: "document-1",
        sourceDocumentName: "first.pdf",
        result: extractionResult({ places: [{ name: "Rome" }] }),
      },
      {
        sourceDocumentId: "document-2",
        sourceDocumentName: "second.pdf",
        result: extractionResult({
          places: [{ name: "Paris" }, { name: "Oslo" }],
        }),
      },
    ],
    rootChoices,
    batchExtractionId,
  );

  assert.deepEqual(table.columns, [
    "Source Document",
    "Source Document ID",
    "Batch Extraction ID",
    "places.0.name",
    "places.1.name",
  ]);
  assert.equal(table.rows[0]!["places.1.name"], undefined);
  assert.equal(table.rows[1]!["places.1.name"], "Oslo");
});

test("rejects a member without the canonical records envelope", () => {
  assert.throws(
    () =>
      buildBatchExportTable(
        [field("title")],
        [{
          sourceDocumentId: "document-1",
          sourceDocumentName: "first.pdf",
          result: { title: "obsolete unwrapped result" },
        }],
        rootChoices,
        batchExtractionId,
      ),
    /must contain exactly one records array of objects/,
  );
});

test("downloads the batch as CSV named after the pinned schema", async () => {
  const browser = stubBrowser();
  try {
    await exportBatchExtractionResults(
      [
        {
          sourceDocumentId: "document-1",
          sourceDocumentName: "first.pdf",
          result: extractionResult({ title: "=cmd" }),
        },
        {
          sourceDocumentId: "document-2",
          sourceDocumentName: "second.pdf",
          result: extractionResult({ title: "B, with comma" }),
        },
      ],
      {
        format: "csv",
        filename: "Places revision 4",
        schemaNodes: [field("title")],
        batchExtractionId,
      },
    );

    const [download] = browser.downloads;
    assert.equal(
      download!.filename,
      "Places revision 4-batch-extraction-results.csv",
    );
    assert.equal(
      await download!.blob.text(),
      `Source Document,Source Document ID,Batch Extraction ID,title\r\nfirst.pdf,document-1,${batchExtractionId},'=cmd\r\nsecond.pdf,document-2,${batchExtractionId},"B, with comma"`,
    );
  } finally {
    browser.restore();
  }
});

test("downloads the batch as a workbook", async () => {
  const browser = stubBrowser();
  try {
    await exportBatchExtractionResults(
      [{
        sourceDocumentId: "document-1",
        sourceDocumentName: "first.pdf",
        result: extractionResult({ score: 1 }),
      }],
      {
        format: "xlsx",
        filename: "Places.json",
        schemaNodes: [field("score", "number")],
        batchExtractionId,
      },
    );

    const [download] = browser.downloads;
    assert.equal(download!.filename, "Places-batch-extraction-results.xlsx");
    const archive = unzipSync(
      new Uint8Array(await download!.blob.arrayBuffer()),
    );
    assert.match(
      strFromU8(archive["xl/worksheets/sheet1.xml"]!),
      /<v>1<\/v>/,
    );
  } finally {
    browser.restore();
  }
});

test("rejects an unsupported format before it reads any member", async () => {
  await assert.rejects(
    exportBatchExtractionResults([], {
      format: "pdf" as "csv",
      filename: "Places",
      schemaNodes: [],
      batchExtractionId,
    }),
    /Unsupported export format: pdf/,
  );
});

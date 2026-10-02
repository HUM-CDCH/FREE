import assert from "node:assert/strict";
import { test } from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { buildEvidenceTable, buildExtractionTable } from "./provenance.js";
import { buildReviewNotesTable } from "./review-notes.js";
import type { Table } from "./table.js";
import { serializeCsv } from "./csv.js";
import { createXlsxBlob } from "./xlsx.js";

async function workbookFiles(
  table: Table,
  companions?: readonly { sheet: string; table: Table }[],
): Promise<Record<string, string>> {
  const blob = await createXlsxBlob(table, companions);
  assert.equal(blob.type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const archive = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  return Object.fromEntries(
    Object.entries(archive).map(([path, bytes]) => [path, strFromU8(bytes)]),
  );
}

test("writes a Results sheet with a bold frozen header, filters, and native cells", async () => {
  const files = await workbookFiles(
    { columns: ["name", "score", "active", "missing"], rows: [
      { name: "=2+2", score: 7, active: true, missing: null },
      { name: "Ada", score: 9.5, active: false },
    ] },
  );

  assert.match(files["xl/workbook.xml"]!, /<sheet[^>]*name="Results"/);
  assert.match(files["xl/worksheets/sheet1.xml"]!, /<pane[^>]*ySplit="1"[^>]*state="frozen"/);
  assert.match(files["xl/worksheets/sheet1.xml"]!, /<autoFilter ref="A1:D3"\/>/);

  const headerStyle = Number(files["xl/worksheets/sheet1.xml"]!.match(/<c r="A1"[^>]*s="(\d+)"/)?.[1]);
  const cellStyles = files["xl/styles.xml"]!.match(/<cellXfs[^>]*>(.*?)<\/cellXfs>/s)?.[1].match(/<xf\b[^>]*>.*?<\/xf>/gs);
  const headerFont = Number(cellStyles?.[headerStyle]?.match(/\bfontId="(\d+)"/)?.[1]);
  const fonts = files["xl/styles.xml"]!.match(/<fonts[^>]*>(.*?)<\/fonts>/s)?.[1].match(/<font>.*?<\/font>/gs);
  assert.match(fonts?.[headerFont] ?? "", /<b\/>/);

  // Numbers and booleans stay native, a null cell stays absent, and no cell holds a formula.
  assert.match(files["xl/worksheets/sheet1.xml"]!, /<c r="B2"[^>]*><v>7<\/v>/);
  assert.match(files["xl/worksheets/sheet1.xml"]!, /<c r="C2"[^>]*t="b"[^>]*><v>1<\/v>/);
  assert.doesNotMatch(files["xl/worksheets/sheet1.xml"]!, /r="D2"/);
  assert.doesNotMatch(files["xl/worksheets/sheet1.xml"]!, /<f>/);

  // The formula-looking value reaches the sheet as text.
  assert.match(files["xl/sharedStrings.xml"]!, /<t>'=2\+2<\/t>/);
});

test("keeps the filter reference inside the worksheet element order", async () => {
  const files = await workbookFiles({ columns: ["a"], rows: [{ a: 1 }] });
  assert.match(files["xl/worksheets/sheet1.xml"]!, /<\/sheetData><autoFilter/);
});

test("feeds CSV and XLSX the identical canonical table", async () => {
  const table: Table = { columns: ["name", "score"], rows: [{ name: "Ada", score: 7 }] };
  assert.equal(serializeCsv(table), "name,score\r\nAda,7");
  const files = await workbookFiles(table);
  assert.match(files["xl/sharedStrings.xml"]!, /<t>name<\/t>.*<t>score<\/t>.*<t>Ada<\/t>/s);
  assert.match(files["xl/worksheets/sheet1.xml"]!, /<c r="B2"[^>]*><v>7<\/v>/);
});

test("rejects a workbook beyond the Excel limits instead of truncating it", async () => {
  await assert.rejects(
    createXlsxBlob({ columns: ["a"], rows: new Array(1_048_576).fill({ a: 1 }) }),
    /1,048,576 rows including the header/,
  );
  await assert.rejects(
    createXlsxBlob({ columns: new Array(16_385).fill("a"), rows: [] }),
    /16,384 columns/,
  );
});

test("adds a Review notes sheet for contested fields and leaves the Results sheet as it was", async () => {
  const table: Table = { columns: ["title", "year"], rows: [{ title: "Ada", year: null }] };
  const notes = buildReviewNotesTable([{ path: ["year"], candidates: [1901, "=1902"] }]);
  const plain = await workbookFiles(table);
  const files = await workbookFiles(table, [{ sheet: "Review notes", table: notes }]);

  assert.equal(files["xl/worksheets/sheet1.xml"], plain["xl/worksheets/sheet1.xml"]);
  assert.match(files["xl/workbook.xml"]!, /<sheet[^>]*name="Results".*<sheet[^>]*name="Review notes"/s);
  assert.match(files["xl/worksheets/sheet1.xml"]!, /<autoFilter ref="A1:B2"\/>/);
  assert.doesNotMatch(files["xl/worksheets/sheet2.xml"]!, /<autoFilter/);
  assert.match(files["xl/worksheets/sheet2.xml"]!, /<c r="C2"[^>]*><v>1901<\/v>/);
  // The field path reuses the Results header's "year" string; the candidates keep their formula protection.
  assert.match(files["xl/sharedStrings.xml"]!, /<t>year<\/t>.*<t>Field<\/t>.*<t>Sources disagreed; left empty in Results<\/t><\/si><si><t>'=1902<\/t>/s);
  assert.equal(plain["xl/worksheets/sheet2.xml"], undefined);
});

test("adds the Review notes, Extraction and Evidence sheets in order, leaving the Results sheet as it was", async () => {
  const table: Table = { columns: ["title", "year"], rows: [{ title: "Ada", year: null }] };
  const notes = buildReviewNotesTable([{ path: ["year"], candidates: [1901, 1902] }]);
  const identity = buildExtractionTable([["Extraction ID", "x-1"], ["Claims", 2]]);
  const evidence = buildEvidenceTable([
    { path: ["title"], extracted: "Ada", outcome: "supported", anchorId: "a_p1_s1", page: 1 },
    { path: ["year"], extracted: null, outcome: "not_completed", reasons: ["call_failed"] },
  ]);
  const plain = await workbookFiles(table);
  const files = await workbookFiles(table, [
    { sheet: "Review notes", table: notes },
    { sheet: "Extraction", table: identity },
    { sheet: "Evidence", table: evidence },
  ]);

  assert.deepEqual([...files["xl/workbook.xml"]!.matchAll(/<sheet\b[^>]*name="([^"]+)"/g)].map((match) => match[1]),
    ["Results", "Review notes", "Extraction", "Evidence"]);
  assert.equal(files["xl/worksheets/sheet1.xml"], plain["xl/worksheets/sheet1.xml"]);
  assert.match(files["xl/worksheets/sheet1.xml"]!, /<autoFilter ref="A1:B2"\/>/);
  for (const sheet of ["sheet2.xml", "sheet3.xml", "sheet4.xml"])
    assert.doesNotMatch(files[`xl/worksheets/${sheet}`]!, /<autoFilter/);
  assert.match(files["xl/worksheets/sheet3.xml"]!, /<c r="B3"[^>]*><v>2<\/v>/);
  assert.match(files["xl/sharedStrings.xml"]!, /<t>Verifier outcome<\/t>.*<t>Verifier-supported<\/t>.*<t>Not completed<\/t>/s);
});

test("a companion without rows adds no sheet", async () => {
  const table: Table = { columns: ["title"], rows: [{ title: "Ada" }] };
  const files = await workbookFiles(table, [{ sheet: "Evidence", table: buildEvidenceTable([]) }]);
  assert.deepEqual([...files["xl/workbook.xml"]!.matchAll(/<sheet\b[^>]*name="([^"]+)"/g)].map((match) => match[1]), ["Results"]);
});

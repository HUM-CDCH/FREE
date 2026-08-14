import assert from "node:assert/strict";
import { test } from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { toTable, type Table } from "./table.js";
import { createXlsxBlob } from "./xlsx.js";

async function workbookFiles(table: Table): Promise<Record<string, string>> {
  const blob = await createXlsxBlob(table);
  assert.equal(blob.type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const archive = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  return Object.fromEntries(
    Object.entries(archive).map(([path, bytes]) => [path, strFromU8(bytes)]),
  );
}

test("writes a Results sheet with a bold frozen header, filters, and native cells", async () => {
  const files = await workbookFiles(
    toTable([
      { name: "=2+2", score: 7, active: true, missing: null },
      { name: "Ada", score: 9.5, active: false },
    ]),
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
  const files = await workbookFiles(toTable({ a: 1 }));
  assert.match(files["xl/worksheets/sheet1.xml"]!, /<\/sheetData><autoFilter/);
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

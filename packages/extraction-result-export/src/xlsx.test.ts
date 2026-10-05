import assert from "node:assert/strict";
import { test } from "node:test";
import { strFromU8, unzipSync } from "fflate";
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

test("adds companion sheets in order, leaving the Results sheet as it was and protecting their formulas", async () => {
  const table: Table = { columns: ["title", "year"], rows: [{ title: "Ada", year: null }] };
  const versions: Table = { columns: ["Snapshot", "Model value"], rows: [{ Snapshot: 1, "Model value": "=1902" }] };
  const processing: Table = { columns: ["Extraction", "State"], rows: [{ Extraction: "x-1", State: "PAUSED" }, { Extraction: "x-2", State: "STOPPED" }] };
  const plain = await workbookFiles(table);
  const files = await workbookFiles(table, [{ sheet: "Model versions", table: versions }, { sheet: "Processing", table: processing }]);

  assert.deepEqual([...files["xl/workbook.xml"]!.matchAll(/<sheet\b[^>]*name="([^"]+)"/g)].map((match) => match[1]),
    ["Results", "Model versions", "Processing"]);
  assert.equal(files["xl/worksheets/sheet1.xml"], plain["xl/worksheets/sheet1.xml"]);
  assert.match(files["xl/worksheets/sheet1.xml"]!, /<autoFilter ref="A1:B2"\/>/);
  for (const sheet of ["sheet2.xml", "sheet3.xml"])
    assert.doesNotMatch(files[`xl/worksheets/${sheet}`]!, /<autoFilter/);
  assert.match(files["xl/worksheets/sheet2.xml"]!, /<c r="A2"[^>]*><v>1<\/v>/);
  assert.match(files["xl/sharedStrings.xml"]!, /<t>'=1902<\/t>/);
  assert.equal(plain["xl/worksheets/sheet2.xml"], undefined);
});

test("a companion without rows adds no sheet", async () => {
  const table: Table = { columns: ["title"], rows: [{ title: "Ada" }] };
  const files = await workbookFiles(table, [{ sheet: "Processing", table: { columns: ["Extraction"], rows: [] } }]);
  assert.deepEqual([...files["xl/workbook.xml"]!.matchAll(/<sheet\b[^>]*name="([^"]+)"/g)].map((match) => match[1]), ["Results"]);
});

test("a large companion sheet builds past the zip writer's worker threshold", async () => {
  const columns = ["Snapshot", "Record", "Field", "Model value"];
  const versions: Table = { columns, rows: Array.from({ length: 3000 }, (_, index) => ({
    Snapshot: 1 + index % 4, Record: `record ${index}`, Field: `field ${index % 5}`, "Model value": `Profipress G 22 mm, item ${index + 1}`,
  })) };
  const started = performance.now();
  const files = await workbookFiles({ columns: ["title"], rows: [{ title: "Price list" }] }, [{ sheet: "Model versions", table: versions }]);
  // Generous: guards only against blow-up.
  assert.ok(performance.now() - started < 10_000, `built in ${performance.now() - started} ms`);
  // fflate deflates a part of 160,000 bytes or more in a Blob-URL Worker: Studio's Content-Security-Policy must allow
  // `worker-src blob:` (prototypes/studio/server/contentSecurityPolicy.ts) or such an export never finishes.
  assert.ok(new TextEncoder().encode(files["xl/worksheets/sheet2.xml"]!).length >= 160_000);
  assert.equal(files["xl/worksheets/sheet2.xml"]!.match(/<row\b/g)?.length, 3001);
});

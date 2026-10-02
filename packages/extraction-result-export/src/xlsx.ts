import type { Feature, SheetData } from "write-excel-file/universal";
import { protectFormula, validateSpreadsheetDimensions } from "./safety.js";
import type { CellValue, Table } from "./table.js";

const protectCell = (value: CellValue): CellValue =>
  typeof value === "string" ? protectFormula(value) : value;

const sheetData = (table: Table): SheetData => [
  table.columns.map((column) => ({ value: protectFormula(column), fontWeight: "bold" })),
  ...table.rows.map((row) =>
    table.columns.map((column) => protectCell(row[column] ?? null)),
  ),
];

/** A sheet after the Results sheet: the Review notes, or an Extraction's Extraction and Evidence sheets. */
export interface CompanionSheet {
  readonly sheet: string;
  readonly table: Table;
}

/** The Results sheet, then each companion with rows, in order; companions leave the Results sheet as it was. */
export async function createXlsxBlob(table: Table, companions: readonly CompanionSheet[] = []): Promise<Blob> {
  validateSpreadsheetDimensions(table.rows.length, table.columns.length);
  const sheets = companions.filter((companion) => companion.table.rows.length > 0);
  for (const { table: companion } of sheets)
    validateSpreadsheetDimensions(companion.rows.length, companion.columns.length);

  const data = sheetData(table);
  const options = {
    features:
      table.columns.length === 0
        ? []
        : [autoFilter(table.columns.length, table.rows.length + 1)],
  };
  // Loaded here, so a CSV export never pays for the workbook writer.
  const { default: writeXlsxFile } = await import("write-excel-file/universal");
  return (sheets.length > 0
    ? writeXlsxFile([
        { data, sheet: "Results", stickyRowsCount: 1 },
        ...sheets.map((companion) => ({ data: sheetData(companion.table), sheet: companion.sheet, stickyRowsCount: 1 })),
      ], options)
    : writeXlsxFile(data, { sheet: "Results", stickyRowsCount: 1 }, options)
  ).toBlob();
}

/** `write-excel-file` writes no filter, so this hook adds the element the sheet needs. */
function autoFilter(columnCount: number, rowCount: number): Feature<Blob> {
  const reference = `A1:${columnName(columnCount)}${rowCount}`;
  return {
    files: {
      transform: {
        "xl/worksheets/sheet{id}.xml": {
          // `<autoFilter/>` must follow `<sheetData/>` to keep the worksheet element order.
          // The Results sheet's alone: a companion sheet carries no filter.
          transform: (xml, _options, { sheetIndex }) =>
            sheetIndex === 0 ? xml.replace("</sheetData>", `</sheetData><autoFilter ref="${reference}"/>`) : xml,
        },
      },
    },
  };
}

function columnName(count: number): string {
  let index = count;
  let name = "";
  while (index > 0) {
    index--;
    name = String.fromCharCode(65 + (index % 26)) + name;
    index = Math.floor(index / 26);
  }
  return name;
}

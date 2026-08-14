import type { Feature, SheetData } from "write-excel-file/universal";
import { protectFormula, validateSpreadsheetDimensions } from "./safety.js";
import type { CellValue, Table } from "./table.js";

const protectCell = (value: CellValue): CellValue =>
  typeof value === "string" ? protectFormula(value) : value;

export async function createXlsxBlob(table: Table): Promise<Blob> {
  validateSpreadsheetDimensions(table.rows.length, table.columns.length);

  const data: SheetData = [
    table.columns.map((column) => ({ value: protectFormula(column), fontWeight: "bold" })),
    ...table.rows.map((row) =>
      table.columns.map((column) => protectCell(row[column] ?? null)),
    ),
  ];

  // Loaded here, so a CSV export never pays for the workbook writer.
  const { default: writeXlsxFile } = await import("write-excel-file/universal");
  return writeXlsxFile(
    data,
    { sheet: "Results", stickyRowsCount: 1 },
    {
      features:
        table.columns.length === 0
          ? []
          : [autoFilter(table.columns.length, table.rows.length + 1)],
    },
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
          transform: (xml) =>
            xml.replace("</sheetData>", `</sheetData><autoFilter ref="${reference}"/>`),
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

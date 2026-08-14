import { protectFormula } from "./safety.js";
import type { CellValue, Table } from "./table.js";

function csvCell(value: CellValue): string {
  const text =
    value === null ? "" : typeof value === "string" ? protectFormula(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function serializeCsv(table: Table): string {
  return [
    table.columns.map(csvCell).join(","),
    ...table.rows.map((row) => table.columns.map((column) => csvCell(row[column] ?? null)).join(",")),
  ].join("\r\n");
}

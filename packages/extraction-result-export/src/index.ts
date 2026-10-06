/**
 * The spreadsheet writers durable exports build on (prototypes/studio/src/durableExport.ts): one canonical table per
 * sheet, written as CSV or XLSX with formula protection and the Excel limits enforced.
 */
export type ExportFormat = "csv" | "xlsx";
export { createXlsxBlob, type CompanionSheet } from "./xlsx.js";
export { serializeCsv } from "./csv.js";
export type { CellValue, Table } from "./table.js";

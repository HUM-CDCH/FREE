const FORMULA_PREFIX = /^[=+\-@]/;
const MAX_EXCEL_ROWS = 1_048_576;
const MAX_EXCEL_COLUMNS = 16_384;

/** Keeps a formula-looking string a string in Excel and in Sheets. */
export const protectFormula = (value: string): string =>
  FORMULA_PREFIX.test(value) ? `'${value}` : value;

/** Rejects a workbook that Excel cannot hold. The export never truncates. */
export function validateSpreadsheetDimensions(rowCount: number, columnCount: number): void {
  const totalRows = rowCount + 1;
  if (totalRows > MAX_EXCEL_ROWS) {
    throw new RangeError(
      `Excel holds at most ${MAX_EXCEL_ROWS.toLocaleString("en-US")} rows including the header; this export has ${totalRows.toLocaleString("en-US")}.`,
    );
  }
  if (columnCount > MAX_EXCEL_COLUMNS) {
    throw new RangeError(
      `Excel holds at most ${MAX_EXCEL_COLUMNS.toLocaleString("en-US")} columns; this export has ${columnCount.toLocaleString("en-US")}.`,
    );
  }
}

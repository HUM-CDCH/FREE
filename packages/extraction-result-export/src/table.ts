export type CellValue = string | number | boolean | null;

/** One canonical sheet: its column order and its rows, keyed by column. */
export interface Table {
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, CellValue>>[];
}

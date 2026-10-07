import type { SchemaNode } from "extraction/schema";

export type CellValue = string | number | boolean | null;

export interface Table {
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, CellValue>>[];
}

export const ROOT_ROWS = "$";
export type OtherRepeatedFields = "preserve" | "omit";
export interface ExportChoices {
  readonly rowsRepresent: string;
  readonly otherRepeatedFields: OtherRepeatedFields;
}
export interface Choice<T extends string> { readonly value: T; readonly label: string }
export interface ExtractionResultExportControlModel {
  readonly rowsRepresent: { readonly value: string; readonly options: readonly Choice<string>[] };
  readonly otherRepeatedFields: {
    readonly value: OtherRepeatedFields;
    readonly options: readonly Choice<OtherRepeatedFields>[];
  };
}

type Selection = ReadonlyMap<string, number>;
type OrderedCell = { readonly column: string; readonly order: readonly number[]; readonly value: CellValue };

/** Escapes separators and numeric object keys so they cannot impersonate nested paths or indexes. */
function escapeSegment(segment: string): string {
  const escaped = segment.replaceAll("\\", "\\\\").replaceAll(".", "\\.");
  return /^\d+$/.test(segment) ? `\\${escaped}` : escaped;
}
function childPath(parent: string, name: string): string {
  return parent ? `${parent}.${escapeSegment(name)}` : escapeSegment(name);
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function valueAt(value: unknown, name: string): unknown {
  return isObject(value) && Object.hasOwn(value, name) ? value[name] : undefined;
}
function isObjectArray(node: SchemaNode): node is SchemaNode & { type: "array"; children: SchemaNode[] } {
  return node.type === "array" && node.children !== undefined;
}

/** Root plus every declared array-of-object path, including paths through ordinary objects. */
export function deriveRowsRepresentOptions(nodes: readonly SchemaNode[]): Choice<string>[] {
  const options: Choice<string>[] = [{ value: ROOT_ROWS, label: "Root result" }];
  const visit = (level: readonly SchemaNode[], parent = "", display: readonly string[] = []): void => {
    for (const node of level) {
      const path = childPath(parent, node.name);
      const label = [...display, node.type === "array" && node.children ? `${node.name}[]` : node.name];
      if (isObjectArray(node)) {
        options.push({ value: path, label: label.join(".") });
        visit(node.children, path, label);
      } else if (node.type === "object") {
        visit(node.children, path, label);
      }
    }
  };
  visit(nodes);
  return options;
}

/** Small headless model used by the React control and any other UI. */
export function createExtractionResultExportControl(
  nodes: readonly SchemaNode[],
  value: Partial<ExportChoices> = {},
): ExtractionResultExportControlModel {
  const rowsRepresent = value.rowsRepresent ?? ROOT_ROWS;
  const options = deriveRowsRepresentOptions(nodes);
  if (!options.some((option) => option.value === rowsRepresent)) {
    throw new Error(`Unknown Rows represent path: ${rowsRepresent}`);
  }
  return {
    rowsRepresent: { value: rowsRepresent, options },
    otherRepeatedFields: {
      value: value.otherRepeatedFields ?? "preserve",
      options: [
        { value: "preserve", label: "Preserve as indexed columns" },
        { value: "omit", label: "Omit" },
      ],
    },
  };
}

function selectedRows(
  nodes: readonly SchemaNode[], value: unknown, target: string, parent: string,
  selected: ReadonlyMap<string, number>,
): Selection[] {
  for (const node of nodes) {
    const path = childPath(parent, node.name);
    if (target !== path && !target.startsWith(`${path}.`)) continue;
    const child = valueAt(value, node.name);
    if (isObjectArray(node)) {
      if (!Array.isArray(child)) return [];
      return child.flatMap((item, index) => {
        const next = new Map(selected).set(path, index);
        return target === path ? [next] : selectedRows(node.children, item, target, path, next);
      });
    }
    if (node.type === "object") return selectedRows(node.children, child, target, path, selected);
    return [];
  }
  return [];
}

function cellValue(value: unknown, column: string): CellValue {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean") {
    return value ?? null;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Field ${column} must hold a finite number.`);
    return value;
  }
  throw new TypeError(`Field ${column} holds an unsupported ${typeof value} value.`);
}

function flatten(
  nodes: readonly SchemaNode[], value: unknown, parent: string, order: readonly number[],
  selected: Selection, repeated: OtherRepeatedFields, output: OrderedCell[],
): void {
  nodes.forEach((node, schemaIndex) => {
    const path = childPath(parent, node.name);
    const nodeOrder = [...order, schemaIndex];
    const child = valueAt(value, node.name);
    if (node.type === "object") {
      flatten(node.children, child, path, nodeOrder, selected, repeated, output);
    } else if (isObjectArray(node)) {
      const selectedIndex = selected.get(path);
      if (selectedIndex !== undefined) {
        const item = Array.isArray(child) ? child[selectedIndex] : undefined;
        flatten(node.children, item, path, nodeOrder, selected, repeated, output);
      } else if (repeated === "preserve" && Array.isArray(child)) {
        child.forEach((item, itemIndex) => flatten(
          node.children, item, `${path}.${itemIndex}`, [...nodeOrder, itemIndex], selected, repeated, output,
        ));
      }
    } else if (node.type === "array") {
      const joined = Array.isArray(child)
        ? child.map((item) => String(cellValue(item, path) ?? "")).join(", ")
        : null;
      output.push({ column: path, order: nodeOrder, value: joined });
    } else {
      output.push({ column: path, order: nodeOrder, value: cellValue(child, path) });
    }
  });
}

function compareOrder(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return left.length - right.length;
}

/** Pure schema-led projection shared by CSV and XLSX. */
export function buildExportTable(
  nodes: readonly SchemaNode[], result: unknown, choices: ExportChoices,
): Table {
  if (!deriveRowsRepresentOptions(nodes).some((option) => option.value === choices.rowsRepresent)) {
    throw new Error(`Unknown Rows represent path: ${choices.rowsRepresent}`);
  }
  const records = Array.isArray(result) ? result : [result];
  const selections = records.flatMap((record) => {
    if (choices.rowsRepresent === ROOT_ROWS) {
      return [{ record, selected: new Map<string, number>() }];
    }
    return selectedRows(nodes, record, choices.rowsRepresent, "", new Map())
      .map((selected) => ({ record, selected }));
  });
  const targetPaths = new Set<string>();
  if (choices.rowsRepresent !== ROOT_ROWS) {
    const collect = (level: readonly SchemaNode[], parent = ""): void => {
      for (const node of level) {
        const path = childPath(parent, node.name);
        if (choices.rowsRepresent !== path && !choices.rowsRepresent.startsWith(`${path}.`)) continue;
        if (isObjectArray(node)) targetPaths.add(path);
        if (node.children) collect(node.children, path);
      }
    };
    collect(nodes);
  }
  const rows = selections.map(({ record, selected }) => {
    const cells: OrderedCell[] = [];
    flatten(nodes, record, "", [], selected, choices.otherRepeatedFields, cells);
    return cells;
  });
  const template: OrderedCell[] = [];
  flatten(nodes, undefined, "", [], new Map([...targetPaths].map((path) => [path, 0])), choices.otherRepeatedFields, template);
  const orderedColumns = new Map<string, readonly number[]>();
  for (const cell of [...template, ...rows.flat()]) {
    if (!orderedColumns.has(cell.column)) orderedColumns.set(cell.column, cell.order);
  }
  const columns = [...orderedColumns]
    .sort(([, left], [, right]) => compareOrder(left, right))
    .map(([column]) => column);
  return {
    columns,
    rows: rows.map((cells) => {
      const row: Record<string, CellValue> = Object.create(null);
      for (const cell of cells) row[cell.column] = cell.value;
      return row;
    }),
  };
}

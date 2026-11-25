import type { SchemaNode } from "extraction/schema";
import { createFieldRegistry, durableRecords, exportedValue, type DurableExportValue, type FieldRegistry } from "./durable.js";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A saved value in the shape its field declares, for the JSON export: a group stays an object with every declared part
 * (null when empty, in the template's order), a list stays a list of its items, and nothing is flattened to text. A value
 * that does not fit its field (a lone item where a list is declared, a word where a group is) is kept, never dropped:
 * a lone item becomes a one-item list; anything else is written as it was saved. Parts a value holds beyond its field's
 * declaration follow the declared ones.
 */
export function structuredValue(node: SchemaNode, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (node.type === "object") {
    if (!isObject(value)) return value;
    const declared = new Set(node.children.map((child) => child.name));
    return {
      ...Object.fromEntries(node.children.map((child) => [child.name, structuredValue(child, value[child.name])])),
      ...Object.fromEntries(Object.entries(value).filter(([name]) => !declared.has(name))),
    };
  }
  if (node.type === "array") {
    const items = Array.isArray(value) ? value : [value];
    const children = node.children;
    if (!children) return items.map((item) => item ?? null);
    const item: SchemaNode = { id: node.id, name: node.name, type: "object", children };
    return items.map((each) => structuredValue(item, each));
  }
  return value;
}

/** One Source Document's results as nested JSON: the fields read once for the whole document, and the records. */
export interface JsonResults {
  /** Fields read from the document as a whole (its catalogue name, its filename), present only when the template has them. */
  readonly document?: Record<string, unknown>;
  /** One object per record, in the order the run found them, every declared field present (null when it has no value). */
  readonly records: Record<string, unknown>[];
}

/**
 * The researcher's reviewed values with the template's hierarchy kept: edits applied, rejected or missing values null.
 * Field names are the export's column names, so a field produced under two types keeps both (`year (string)`).
 */
export function durableJsonResults(values: readonly DurableExportValue[], registry: FieldRegistry = createFieldRegistry(values)): JsonResults {
  const nodes = registry.schemaNodes;
  const own = nodes.filter((node) => !node.valueSource);
  const shared = nodes.filter((node) => node.valueSource);
  const byRecord = new Map<string, Map<string, unknown>>();
  const documentFields = new Map<string, unknown>();
  for (const value of values) {
    const column = registry.column(value.node).name;
    const exported = exportedValue(value);
    const shaped = structuredValue(value.node, exported);
    if (value.node.valueSource) { documentFields.set(column, shaped); continue; }
    const fields = byRecord.get(value.recordId) ?? new Map<string, unknown>();
    fields.set(column, shaped);
    byRecord.set(value.recordId, fields);
  }
  // The records' order is the spreadsheet's: the order the run found them.
  const order = durableRecords(values, registry).map((record) => record.recordId).filter((id) => byRecord.has(id));
  const records = order.map((id) => Object.fromEntries(own.map((node) => [node.name, byRecord.get(id)!.get(node.name) ?? null])));
  return {
    ...(shared.length > 0 ? { document: Object.fromEntries(shared.map((node) => [node.name, documentFields.get(node.name) ?? null])) } : {}),
    records,
  };
}

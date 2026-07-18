export { isRecord } from "../shared/schema";
import { isRecord } from "../shared/schema";

export function countTemplateFields(value: unknown): number {
	if (Array.isArray(value)) {
		return countTemplateFields(value[0]);
	}
	if (isRecord(value)) {
		return Object.entries(value).reduce<number>(
			(sum, [key, child]) =>
				sum + (key === "_evidence" ? 0 : countTemplateFields(child)),
			0,
		);
	}
	return 1;
}

export const FIELD_TYPES = [
	"verbatim-string",
	"string",
	"date",
	"number",
	"integer",
	"boolean",
	"object",
	"array",
] as const;

export function fieldTypeLabel(value: unknown): string {
	if (Array.isArray(value)) {
		return "array";
	}
	if (isRecord(value)) {
		return "object";
	}
	return String(value);
}

// Fields are addressed by their chain of record keys; array hops (the
// template's repeating groups live in the array's first element) are
// traversed implicitly so paths stay stable across list nesting.
export type TemplatePath = string[];

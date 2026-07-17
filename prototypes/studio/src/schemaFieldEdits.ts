import type { SchemaChange } from "../shared/schema";
import { fieldTypeLabel } from "./template";
import type { TemplatePath } from "./template";

function fieldValueForType(type: string) {
	if (type === "object") return {};
	if (type === "array") return ["string"];
	return type;
}

export function fieldEditChanges(
	path: TemplatePath,
	currentValue: unknown,
	name: string,
	type: string,
): SchemaChange[] {
	const currentName = path.at(-1);
	if (currentName === undefined) return [];

	const changes: SchemaChange[] = [];
	let targetPath = path;
	if (currentName !== name) {
		changes.push({ operation: "rename", path, name });
		targetPath = [...path.slice(0, -1), name];
	}
	if (fieldTypeLabel(currentValue) !== type) {
		changes.push({
			operation: "set",
			path: targetPath,
			value: fieldValueForType(type),
		});
	}
	return changes;
}

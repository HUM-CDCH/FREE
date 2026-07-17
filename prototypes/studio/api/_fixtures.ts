import { readFileSync } from "node:fs";

export function parseJson<T>(text: string, label: string): T {
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw new Error(`Invalid JSON: ${label}`, { cause: error });
	}
}

export function fixture<T>(name: string): T {
	const text = readFileSync(
		new URL(`./test-fixtures/${name}`, import.meta.url),
		"utf8",
	);
	return parseJson<T>(text, `test fixture ${name}`);
}

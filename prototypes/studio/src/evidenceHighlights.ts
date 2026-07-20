import { isRecord } from "./template";

// Paul Tol's Muted palette: distinguishable across common forms of color blindness.
export const PALETTE: string[] = [
	"rgba(148, 203, 236, 0.55)",
	"rgba(220, 205, 125, 0.55)",
	"rgba(194, 106, 119, 0.45)",
	"rgba(93, 168, 153, 0.45)",
];

export type Highlight = {
	value: string;
	snippet: string | null;
	hintPage: number | null;
	color: string;
	path: string[];
};

export function sameResultPath(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function highlightAlpha(path: string[], focusPath: string[] | null): number {
	if (focusPath === null) return 0.4;
	const active = sameResultPath(path, focusPath);
	return active ? 0.75 : 0.15;
}

function scalarText(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "boolean") return String(value);
	return "";
}

function collectScalarEvidence(
	value: string,
	evidence: Record<string, unknown>,
	color: string,
	path: string[],
	out: Highlight[],
): void {
	const snippets = (evidence.snippets as unknown[]).filter(
		(snippet): snippet is string =>
			typeof snippet === "string" && snippet.trim().length > 0,
	);
	const hintPage = typeof evidence.page === "number" ? evidence.page : null;
	if (snippets.length === 0) {
		out.push({ value, snippet: null, hintPage, color, path });
		return;
	}
	for (const snippet of snippets) {
		out.push({ value, snippet: snippet.trim(), hintPage, color, path });
	}
}

function collectEvidence(
	resultValue: unknown,
	evidence: unknown,
	color: string,
	path: string[],
	out: Highlight[],
): boolean {
	if (!isRecord(evidence) || !Array.isArray(evidence.snippets)) return false;

	if (Array.isArray(resultValue)) {
		let collected = false;
		resultValue.forEach((item, index) => {
			const value = scalarText(item);
			if (!value) return;
			collectScalarEvidence(value, evidence, color, [...path, String(index)], out);
			collected = true;
		});
		return collected;
	}

	const value = scalarText(resultValue);
	if (!value) return false;
	collectScalarEvidence(value, evidence, color, path, out);
	return true;
}

function collectHighlightNode(
	node: unknown,
	color: string,
	path: string[],
	out: Highlight[],
): void {
	if (Array.isArray(node)) {
		node.forEach((item, index) =>
			collectHighlightNode(item, color, [...path, String(index)], out),
		);
		return;
	}
	if (isRecord(node)) {
		const localEvidence = isRecord(node._evidence) ? node._evidence : {};
		for (const [key, value] of Object.entries(node)) {
			if (key === "_evidence") continue;
			const childPath = [...path, key];
			if (!collectEvidence(value, localEvidence[key], color, childPath, out)) {
				collectHighlightNode(value, color, childPath, out);
			}
		}
		return;
	}

	const value = scalarText(node);
	if (value) out.push({ value, snippet: null, hintPage: null, color, path });
}

export function buildHighlights(
	result: Record<string, unknown>,
	fieldColorMap: Record<string, string>,
): Highlight[] {
	const out: Highlight[] = [];
	const localEvidence = isRecord(result._evidence) ? result._evidence : {};
	let index = 0;
	for (const [key, value] of Object.entries(result)) {
		if (key === "_evidence") continue;
		const color = fieldColorMap[key] ?? PALETTE[index % PALETTE.length];
		if (!collectEvidence(value, localEvidence[key], color, [key], out)) {
			collectHighlightNode(value, color, [key], out);
		}
		index += 1;
	}
	return out;
}

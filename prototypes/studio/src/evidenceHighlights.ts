import { isRecord } from "./template";

export const PALETTE: string[] = [
	"rgba(255, 220, 0, 0.35)",
	"rgba(59, 130, 246, 0.30)",
	"rgba(34, 197, 94, 0.30)",
	"rgba(239, 68, 68, 0.25)",
];

type Highlight = {
	value: string;
	snippet: string | null;
	hintPage: number | null;
	color: string;
};

function collectHighlightNode(
	node: unknown,
	color: string,
	out: Highlight[],
): void {
	if (Array.isArray(node)) {
		node.forEach((item) => collectHighlightNode(item, color, out));
		return;
	}
	if (isRecord(node)) {
		const localEvidence = isRecord(node._evidence) ? node._evidence : {};
		for (const [key, value] of Object.entries(node)) {
			if (key === "_evidence") continue;
			if (!collectEvidence(value, localEvidence[key], color, out)) {
				collectHighlightNode(value, color, out);
			}
		}
		return;
	}

	const value = scalarText(node);
	if (value) out.push({ value, snippet: null, hintPage: null, color });
}

function collectEvidence(
	resultValue: unknown,
	evidence: unknown,
	color: string,
	out: Highlight[],
): boolean {
	if (!isRecord(evidence) || !Array.isArray(evidence.snippets)) return false;

	if (Array.isArray(resultValue)) {
		const scalarValues = resultValue.map(scalarText).filter(Boolean);
		if (scalarValues.length === 0) return false;
		for (const value of scalarValues)
			collectScalarEvidence(value, evidence, color, out);
		return true;
	}

	const value = scalarText(resultValue);
	if (!value) return false;
	collectScalarEvidence(value, evidence, color, out);
	return true;
}

function collectScalarEvidence(
	value: string,
	evidence: Record<string, unknown>,
	color: string,
	out: Highlight[],
): void {
	const snippets = (evidence.snippets as unknown[]).filter(
		(snippet): snippet is string =>
			typeof snippet === "string" && snippet.trim().length > 0,
	);
	const hintPage = typeof evidence.page === "number" ? evidence.page : null;
	if (snippets.length === 0) {
		out.push({ value, snippet: null, hintPage, color });
		return;
	}
	for (const snippet of snippets) {
		out.push({ value, snippet: snippet.trim(), hintPage, color });
	}
}

function scalarText(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "boolean") return String(value);
	return "";
}

export function buildHighlights(
	result: Record<string, unknown>,
	colorMap: Record<string, string>,
): Highlight[] {
	const out: Highlight[] = [];
	const localEvidence = isRecord(result._evidence) ? result._evidence : {};
	for (const [key, value] of Object.entries(result)) {
		if (key === "_evidence") continue;
		const color = colorMap[key] ?? PALETTE[0];
		if (!collectEvidence(value, localEvidence[key], color, out)) {
			collectHighlightNode(value, color, out);
		}
	}
	return out;
}

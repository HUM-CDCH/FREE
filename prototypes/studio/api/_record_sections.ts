type Heading = {
	readonly start: number;
	readonly level: number;
	readonly title: string;
	readonly signature: string;
};

type HeadingGroup = {
	readonly headings: readonly Heading[];
	readonly firstStart: number;
	readonly level: number;
};

/** Partition Markdown when one numbered heading shape clearly repeats as records. */
export function partitionRepeatedMarkdownRecords(
	markdown: string,
): readonly string[] | null {
	const headings = parseHeadings(markdown);
	const groups = new Map<string, Heading[]>();
	for (const heading of headings) {
		const key = `${heading.level}:${heading.signature}`;
		const group = groups.get(key) ?? [];
		group.push(heading);
		groups.set(key, group);
	}

	const candidates: HeadingGroup[] = [];
	for (const group of groups.values()) {
		const distinctTitles = new Set(
			group.map((heading) => normalizeTitle(heading.title)),
		);
		if (group.length >= 2 && distinctTitles.size >= 2) {
			candidates.push({
				headings: group,
				firstStart: group[0].start,
				level: group[0].level,
			});
		}
	}
	candidates.sort(
		(left, right) =>
			right.headings.length - left.headings.length ||
			left.level - right.level ||
			left.firstStart - right.firstStart,
	);
	const selected = candidates[0]?.headings;
	if (!selected) return null;
	const preamble = markdown.slice(0, selected[0].start).trim();

	return selected.map((heading, index) => {
		const end = selected[index + 1]?.start ?? markdown.length;
		const section = markdown.slice(heading.start, end).trim();
		return preamble ? `${preamble}\n\n${section}` : section;
	});
}

export function repeatedRecordsMixTableSchemas(
	markdown: string,
	records: readonly unknown[],
): boolean {
	const tables = parseMarkdownTables(markdown);
	return records.some(
		(record) =>
			isRecord(record) &&
			Object.values(record).some((value) =>
				childArrayMixesTables(value, tables),
			),
	);
}

type MarkdownTable = {
	readonly header: string;
	readonly cells: ReadonlySet<string>;
};

function childArrayMixesTables(
	node: unknown,
	tables: readonly MarkdownTable[],
): boolean {
	if (!Array.isArray(node)) return false;
	if (node.every(isRecord)) {
		const headers = new Set<string>();
		for (const item of node) {
			const identity = Object.values(item).find(isScalarIdentity);
			if (identity === undefined) continue;
			const normalized = normalizeCell(String(identity));
			const table = tables.find((candidate) => candidate.cells.has(normalized));
			if (table) headers.add(table.header);
		}
		if (headers.size > 1) return true;
	}
	return node.some(
		(item) =>
			isRecord(item) &&
			Object.values(item).some((value) => childArrayMixesTables(value, tables)),
	);
}

function parseMarkdownTables(markdown: string): MarkdownTable[] {
	const lines = markdown.split(/\r?\n/);
	const tables: MarkdownTable[] = [];
	for (let index = 0; index < lines.length - 1; index += 1) {
		if (!isTableRow(lines[index]) || !isSeparatorRow(lines[index + 1]))
			continue;
		const header = tableCells(lines[index]).map(normalizeCell).join("|");
		const cells = new Set<string>();
		index += 2;
		while (index < lines.length && isTableRow(lines[index])) {
			for (const cell of tableCells(lines[index]))
				cells.add(normalizeCell(cell));
			index += 1;
		}
		index -= 1;
		tables.push({ header, cells });
	}
	return tables;
}

function tableCells(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((cell) => cell.trim());
}

function isTableRow(line: string): boolean {
	return line.trim().startsWith("|") && line.trim().endsWith("|");
}

function isSeparatorRow(line: string): boolean {
	const cells = tableCells(line);
	return (
		isTableRow(line) &&
		cells.length > 0 &&
		cells.every((cell) => /^:?-{3,}:?$/.test(cell))
	);
}

function normalizeCell(value: string): string {
	return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function isScalarIdentity(value: unknown): value is string | number {
	return (
		(typeof value === "string" && value.trim() !== "") ||
		typeof value === "number"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHeadings(markdown: string): Heading[] {
	const headings: Heading[] = [];
	const pattern = /^(#{1,6})[ \t]+(.+?)[ \t]*$/gm;
	for (const match of markdown.matchAll(pattern)) {
		const title = match[2];
		const signature = headingSignature(title);
		if (signature.includes("{number}")) {
			headings.push({
				start: match.index,
				level: match[1].length,
				title,
				signature,
			});
		}
	}
	return headings;
}

function headingSignature(title: string): string {
	return normalizeTitle(title)
		.replace(/\p{N}+(?:\s*[-–—]\s*\p{N}+)?/gu, "{number}")
		.replace(/\s+/g, " ");
}

function normalizeTitle(title: string): string {
	return title.normalize("NFKC").trim().toLocaleLowerCase("und");
}

import { useEffect, useRef } from "react";
import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import { buildHighlights, PALETTE } from "./evidenceHighlights";
import { matchPdfTextItems } from "./pdfTextMatching";
import { isRecord } from "./template";

function buildTopLevelColorMap(schema: unknown): Record<string, string> {
	if (!isRecord(schema)) return {};
	const map: Record<string, string> = {};
	let i = 0;
	for (const key of Object.keys(schema)) {
		map[key] = PALETTE[i % PALETTE.length];
		i++;
	}
	return map;
}

// ── text-layer helpers ────────────────────────────────────────────────────────

type HasStr = {
	str: string;
	transform: number[];
	width: number;
	height: number;
};

type PageTextData = {
	items: HasStr[];
	normStrs: string[];
	viewportScale: number;
	viewportHeight: number;
};

async function getPageTextData(
	pdfViewer: PDFViewer,
	pageNumber: number,
): Promise<PageTextData | null> {
	const pageCount = pdfViewer.pdfDocument?.numPages ?? 0;
	if (pageNumber < 1 || pageNumber > pageCount) return null;
	const pdfPage = await pdfViewer.pdfDocument?.getPage(pageNumber);
	if (!pdfPage) return null;

	const textContent = await pdfPage.getTextContent();
	const CSS_UNITS = 96.0 / 72.0;
	const viewport = pdfPage.getViewport({
		scale: pdfViewer.currentScale * CSS_UNITS,
	});

	const items: HasStr[] = [];
	const normStrs: string[] = [];
	for (const raw of textContent.items) {
		if (!("str" in raw)) continue;
		const item = raw as HasStr;
		const norm = item.str.replace(/\s+/g, " ").trim();
		if (norm) {
			items.push(item);
			normStrs.push(norm);
		}
	}

	return {
		items,
		normStrs,
		viewportScale: viewport.scale,
		viewportHeight: viewport.height,
	};
}

function rectsForQuery(data: PageTextData, query: string): DOMRect[] {
	const indexes = matchPdfTextItems(data.normStrs, query);
	return indexes.map((index) => {
		const item = data.items[index];
		if (!item) return new DOMRect();
		const [, , , , tx, ty] = item.transform;
		const x = tx * data.viewportScale;
		const y = data.viewportHeight - (ty + item.height) * data.viewportScale;
		return new DOMRect(
			x,
			y,
			item.width * data.viewportScale,
			item.height * data.viewportScale,
		);
	});
}

// Find `value` within the region where `snippet` appears on a page.
// Falls back to searching value across the whole page if snippet isn't found.
function searchValueAnchoredBySnippet(
	data: PageTextData,
	snippet: string,
	value: string,
): DOMRect[] {
	const snippetItems = matchPdfTextItems(data.normStrs, snippet);
	if (snippetItems.length > 0) {
		const first = snippetItems[0] ?? 0;
		const last = snippetItems.at(-1) ?? first;
		const subData: PageTextData = {
			items: data.items.slice(first, last + 1),
			normStrs: data.normStrs.slice(first, last + 1),
			viewportScale: data.viewportScale,
			viewportHeight: data.viewportHeight,
		};
		const rects = rectsForQuery(subData, value);
		if (rects.length > 0) return rects;
	}

	return rectsForQuery(data, value);
}

// ── main search ───────────────────────────────────────────────────────────────

type PageRects = { pageNumber: number; rects: DOMRect[] };

async function findValueRects(
	pdfViewer: PDFViewer,
	value: string,
	snippet: string | null,
	hintPage: number | null,
): Promise<PageRects | null> {
	const pageCount = pdfViewer.pdfDocument?.numPages ?? 0;
	const valueNorm = value.replace(/\s+/g, " ").trim();
	if (!valueNorm) return null;

	// Build query list with progressive shortening for direct fallback
	const words = valueNorm.split(" ");
	const queries: string[] = [valueNorm];
	if (words.length > 4) queries.push(words.slice(0, 5).join(" "));
	if (words.length > 2) queries.push(words.slice(0, 3).join(" "));

	// Page order: hint page first, then the rest
	const pages =
		hintPage != null
			? [
					hintPage,
					...Array.from({ length: pageCount }, (_, i) => i + 1).filter(
						(p) => p !== hintPage,
					),
				]
			: Array.from({ length: pageCount }, (_, i) => i + 1);

	if (snippet) {
		// Snippet-anchored: search for value within snippet context
		for (const p of pages) {
			const data = await getPageTextData(pdfViewer, p);
			if (!data) continue;
			const rects = searchValueAnchoredBySnippet(data, snippet, valueNorm);
			if (rects.length > 0) return { pageNumber: p, rects };
		}
	}

	// Direct search with progressive shortening (no snippet, or snippet search failed)
	for (const query of queries) {
		for (const p of pages) {
			const data = await getPageTextData(pdfViewer, p);
			if (!data) continue;
			const rects = rectsForQuery(data, query);
			if (rects.length > 0) return { pageNumber: p, rects };
		}
	}

	return null;
}

// ── component ─────────────────────────────────────────────────────────────────

type Props = {
	pdfViewer: PDFViewer | null;
	result: unknown;
	containerEl: HTMLDivElement | null;
	schema: unknown;
};

export default function EvidenceHighlightLayer({
	pdfViewer,
	result,
	containerEl,
	schema,
}: Props) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);

	useEffect(() => {
		if (!pdfViewer || !result || !containerEl || !isRecord(result)) return;

		const colorMap = buildTopLevelColorMap(schema);
		const highlights = buildHighlights(result, colorMap);
		if (highlights.length === 0) return;

		let cancelled = false;

		async function render() {
			const canvas = canvasRef.current;
			if (!canvas || !pdfViewer || !containerEl) return;

			const { scrollWidth, scrollHeight } = containerEl;
			canvas.width = scrollWidth;
			canvas.height = scrollHeight;

			const ctx = canvas.getContext("2d");
			if (!ctx) return;
			ctx.clearRect(0, 0, canvas.width, canvas.height);

			const containerRect = containerEl.getBoundingClientRect();

			for (const h of highlights) {
				if (cancelled) return;

				const found = await findValueRects(
					pdfViewer,
					h.value,
					h.snippet,
					h.hintPage,
				);
				if (!found) continue;

				const pageEl = containerEl.querySelector(
					`.page[data-page-number="${found.pageNumber}"]`,
				) as HTMLElement | null;
				if (!pageEl) continue;

				const pageRect = pageEl.getBoundingClientRect();
				const pageTop =
					pageRect.top -
					containerRect.top +
					containerEl.scrollTop +
					pageEl.clientTop;
				const pageLeft =
					pageRect.left -
					containerRect.left +
					containerEl.scrollLeft +
					pageEl.clientLeft;

				for (const rect of found.rects) {
					if (cancelled) return;
					ctx.fillStyle = h.color;
					ctx.fillRect(
						pageLeft + rect.x,
						pageTop + rect.y,
						rect.width,
						rect.height,
					);
				}
			}
		}

		void render();
		return () => {
			cancelled = true;
		};
	}, [pdfViewer, result, containerEl, schema]);

	if (!result) return null;

	return (
		<canvas
			ref={canvasRef}
			className="pointer-events-none absolute top-0 left-0 z-10"
			aria-hidden="true"
		/>
	);
}

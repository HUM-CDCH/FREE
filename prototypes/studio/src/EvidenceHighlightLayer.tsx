import { useEffect, useRef, useState } from "react";
import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import { buildHighlights, PALETTE, sameResultPath, type Highlight } from "./evidenceHighlights";
import { drawEntry } from "./evidencePaint";
import { matchPdfTextItems } from "./pdfTextMatching";
import { isRecord } from "./template";

function buildTopLevelColorMap(schema: unknown): Record<string, string> {
	if (!isRecord(schema)) return {};
	return Object.fromEntries(
		Object.keys(schema).map((key, index) => [key, PALETTE[index % PALETTE.length]]),
	);
}

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
	const cssUnits = 96 / 72;
	const viewport = pdfPage.getViewport({
		scale: pdfViewer.currentScale * cssUnits,
	});
	const items: HasStr[] = [];
	const normStrs: string[] = [];
	for (const raw of textContent.items) {
		if (!("str" in raw)) continue;
		const item = raw as HasStr;
		const normalized = item.str.replace(/\s+/g, " ").trim();
		if (!normalized) continue;
		items.push(item);
		normStrs.push(normalized);
	}

	return {
		items,
		normStrs,
		viewportScale: viewport.scale,
		viewportHeight: viewport.height,
	};
}

function rectsForQuery(data: PageTextData, query: string): DOMRect[] {
	return matchPdfTextItems(data.normStrs, query).map((index) => {
		const item = data.items[index];
		if (!item) return new DOMRect();
		const [, , , , tx, ty] = item.transform;
		return new DOMRect(
			tx * data.viewportScale,
			data.viewportHeight - (ty + item.height) * data.viewportScale,
			item.width * data.viewportScale,
			item.height * data.viewportScale,
		);
	});
}

function searchValueAnchoredBySnippet(
	data: PageTextData,
	snippet: string,
	value: string,
): DOMRect[] {
	const snippetItems = matchPdfTextItems(data.normStrs, snippet);
	if (snippetItems.length > 0) {
		const first = snippetItems[0] ?? 0;
		const last = snippetItems.at(-1) ?? first;
		const rects = rectsForQuery(
			{
				items: data.items.slice(first, last + 1),
				normStrs: data.normStrs.slice(first, last + 1),
				viewportScale: data.viewportScale,
				viewportHeight: data.viewportHeight,
			},
			value,
		);
		if (rects.length > 0) return rects;
	}
	return rectsForQuery(data, value);
}

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
	const words = valueNorm.split(" ");
	const queries = [valueNorm];
	if (words.length > 4) queries.push(words.slice(0, 5).join(" "));
	if (words.length > 2) queries.push(words.slice(0, 3).join(" "));
	const allPages = Array.from({ length: pageCount }, (_, index) => index + 1);
	const pages =
		hintPage === null
			? allPages
			: [hintPage, ...allPages.filter((page) => page !== hintPage)];

	if (snippet) {
		for (const pageNumber of pages) {
			const data = await getPageTextData(pdfViewer, pageNumber);
			if (!data) continue;
			const rects = searchValueAnchoredBySnippet(data, snippet, valueNorm);
			if (rects.length > 0) return { pageNumber, rects };
		}
	}
	for (const query of queries) {
		for (const pageNumber of pages) {
			const data = await getPageTextData(pdfViewer, pageNumber);
			if (!data) continue;
			const rects = rectsForQuery(data, query);
			if (rects.length > 0) return { pageNumber, rects };
		}
	}
	return null;
}

type CachedEntry = {
	highlight: Highlight;
	rects: Array<Pick<DOMRect, "x" | "y" | "width" | "height">>;
	pageTop: number;
	pageLeft: number;
};

type Props = {
	pdfViewer: PDFViewer | null;
	result: unknown;
	containerEl: HTMLDivElement | null;
	schemaTemplate: unknown;
	focusPath: string[] | null;
};

export default function EvidenceHighlightLayer({
	pdfViewer,
	result,
	containerEl,
	schemaTemplate,
	focusPath,
}: Props) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const schemaTemplateRef = useRef(schemaTemplate);
	const focusPathRef = useRef(focusPath);
	const cachedEntriesRef = useRef<CachedEntry[]>([]);
	const [scale, setScale] = useState(1);
	const [containerVersion, setContainerVersion] = useState(0);
	const [cacheVersion, setCacheVersion] = useState(0);

	useEffect(() => {
		schemaTemplateRef.current = schemaTemplate;
	}, [schemaTemplate]);

	useEffect(() => {
		focusPathRef.current = focusPath;
	}, [focusPath]);

	useEffect(() => {
		if (!pdfViewer) return;
		const onScaleChange = () => setScale(pdfViewer.currentScale);
		pdfViewer.eventBus.on("scalechanging", onScaleChange);
		return () => pdfViewer.eventBus.off("scalechanging", onScaleChange);
	}, [pdfViewer]);

	useEffect(() => {
		if (!containerEl || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() =>
			setContainerVersion((version) => version + 1),
		);
		observer.observe(containerEl);
		return () => observer.disconnect();
	}, [containerEl]);

	useEffect(() => {
		if (!pdfViewer || !containerEl || !isRecord(result)) return;
		const highlights = buildHighlights(
			result,
			buildTopLevelColorMap(schemaTemplateRef.current),
		);
		cachedEntriesRef.current = [];
		if (highlights.length === 0) return;
		let cancelled = false;

		async function render() {
			const canvas = canvasRef.current;
			if (!canvas || !pdfViewer || !containerEl) return;
			canvas.width = containerEl.scrollWidth;
			canvas.height = containerEl.scrollHeight;
			const context = canvas.getContext("2d");
			if (!context) return;
			context.clearRect(0, 0, canvas.width, canvas.height);
			const containerRect = containerEl.getBoundingClientRect();

			for (const highlight of highlights) {
				if (cancelled) return;
				const found = await findValueRects(
					pdfViewer,
					highlight.value,
					highlight.snippet,
					highlight.hintPage,
				);
				if (!found || cancelled) continue;
				const pageEl = containerEl.querySelector(
					`.page[data-page-number="${found.pageNumber}"]`,
				) as HTMLElement | null;
				if (!pageEl) continue;
				const pageRect = pageEl.getBoundingClientRect();
				const entry: CachedEntry = {
					highlight,
					rects: found.rects,
					pageTop:
						pageRect.top -
						containerRect.top +
						containerEl.scrollTop +
						pageEl.clientTop,
					pageLeft:
						pageRect.left -
						containerRect.left +
						containerEl.scrollLeft +
						pageEl.clientLeft,
				};
				cachedEntriesRef.current.push(entry);
				drawEntry(context, entry, focusPathRef.current);
			}
			if (!cancelled) setCacheVersion((version) => version + 1);
		}

		void render();
		return () => {
			cancelled = true;
		};
	}, [pdfViewer, result, containerEl, scale, containerVersion]);

	useEffect(() => {
		if (!containerEl) return;
		const canvas = canvasRef.current;
		const entries = cachedEntriesRef.current;
		if (!canvas || entries.length === 0) return;
		if (focusPath) {
			const entry = entries.find((candidate) =>
				sameResultPath(candidate.highlight.path, focusPath),
			);
			const rect = entry?.rects[0];
			if (entry && rect) {
				containerEl.scrollTo({
					top: Math.max(
						0,
						entry.pageTop + rect.y - containerEl.clientHeight / 2 + rect.height / 2,
					),
					behavior: "smooth",
				});
			}
		}
		const context = canvas.getContext("2d");
		if (!context) return;
		context.clearRect(0, 0, canvas.width, canvas.height);
		entries.forEach((entry) => drawEntry(context, entry, focusPath));
	}, [focusPath, cacheVersion, containerEl]);

	if (!result) return null;
	return (
		<canvas
			ref={canvasRef}
			className="pointer-events-none absolute top-0 left-0 z-10"
			aria-hidden="true"
		/>
	);
}

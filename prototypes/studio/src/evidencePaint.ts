import { highlightAlpha, type Highlight } from "./evidenceHighlights";

type PaintEntry = {
	highlight: Highlight;
	rects: Array<Pick<DOMRect, "x" | "y" | "width" | "height">>;
	pageTop: number;
	pageLeft: number;
};

export function drawEntry(
	context: Pick<CanvasRenderingContext2D, "save" | "restore" | "fillRect" | "globalAlpha" | "fillStyle">,
	entry: PaintEntry,
	focusPath: string[] | null,
): void {
	context.save();
	context.globalAlpha = highlightAlpha(entry.highlight.path, focusPath);
	context.fillStyle = entry.highlight.color;
	for (const rect of entry.rects) {
		context.fillRect(entry.pageLeft + rect.x - 1, entry.pageTop + rect.y - 2, rect.width + 2, rect.height + 2);
	}
	context.restore();
}

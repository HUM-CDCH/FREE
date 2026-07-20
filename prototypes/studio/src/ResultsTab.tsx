import { useEffect, useMemo, useState } from "react";
import { isRecord } from "./template";
import { resultStats } from "./resultStats";
import type { ExtractionController } from "./useExtraction";
import { Button, Overline, ResultValue, SegmentedControl } from "./ui";

type ResultsTabProps = {
	controller: ExtractionController;
	schemaReady: boolean;
	onValueClick?: (path: string[], value: string) => void;
	focusPath?: string[] | null;
	onClearFocus?: () => void;
	documentMarkdown: string | null;
};

type View = "review" | "json" | "markdown";

function getAtPath(value: unknown, path: string[]): unknown {
	return path.reduce<unknown>((current, key) => {
		if (Array.isArray(current)) return current[Number.parseInt(key, 10)];
		if (isRecord(current)) return current[key];
		return undefined;
	}, value);
}

function pathsEqual(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function summaryItem(label: string, value: string | number) {
	return (
		<span className="rounded-full border border-line bg-surface-muted px-2 py-1 text-xs font-semibold text-ink-muted">
			{label}: <span className="font-mono text-ink">{value}</span>
		</span>
	);
}

function ResultsTab({
	controller,
	schemaReady,
	onValueClick,
	focusPath,
	onClearFocus,
	documentMarkdown,
}: ResultsTabProps) {
	const { state } = controller;
	const [view, setView] = useState<View>("review");
	const [navPath, setNavPath] = useState<string[]>([]);
	const [backStack, setBackStack] = useState<string[][]>([]);
	const [forwardStack, setForwardStack] = useState<string[][]>([]);
	const displayResult = state.status === "ready" ? state.result : null;
	const stats = useMemo(
		() => (displayResult ? resultStats(displayResult) : null),
		[displayResult],
	);

	useEffect(() => {
		const timeout = window.setTimeout(() => {
			setNavPath([]);
			setBackStack([]);
			setForwardStack([]);
		}, 0);
		return () => window.clearTimeout(timeout);
	}, [state]);

	function drillInto(path: string[]) {
		setBackStack((previous) => [...previous, navPath]);
		setForwardStack([]);
		setNavPath(path);
	}

	function jumpToAncestor(path: string[]) {
		setForwardStack((previous) => [...previous, navPath]);
		setBackStack((previous) => {
			const ancestorIndex = previous.findLastIndex((candidate) => pathsEqual(candidate, path));
			return ancestorIndex >= 0 ? previous.slice(0, ancestorIndex) : previous;
		});
		setNavPath(path);
	}

	function goBack() {
		const previous = backStack.at(-1);
		if (!previous) return;
		setForwardStack((stack) => [...stack, navPath]);
		setNavPath(previous);
		setBackStack((stack) => stack.slice(0, -1));
	}

	function goForward() {
		const next = forwardStack.at(-1);
		if (!next) return;
		setBackStack((stack) => [...stack, navPath]);
		setNavPath(next);
		setForwardStack((stack) => stack.slice(0, -1));
	}

	const currentEntries = useMemo(() => {
		const node = navPath.length === 0 ? displayResult : getAtPath(displayResult, navPath);
		if (Array.isArray(node)) {
			return node.map((value, index) => ({
				pathKey: String(index),
				displayName: `Item ${index + 1}`,
				value,
			}));
		}
		if (isRecord(node)) {
			return Object.entries(node)
				.filter(([key]) => key !== "_evidence")
				.map(([key, value]) => ({ pathKey: key, displayName: key, value }));
		}
		return [];
	}, [displayResult, navPath]);

	async function copyJson() {
		if (displayResult) {
			await navigator.clipboard.writeText(JSON.stringify(displayResult, null, 2));
		}
	}

	function downloadJson() {
		if (!displayResult) return;
		const url = URL.createObjectURL(
			new Blob([JSON.stringify(displayResult, null, 2)], {
				type: "application/json",
			}),
		);
		const link = document.createElement("a");
		link.href = url;
		link.download = "free-extraction-result.json";
		link.click();
		URL.revokeObjectURL(url);
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex min-h-9.5 shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-1.5">
				<Overline as="h2">Extraction results</Overline>
				<SegmentedControl
					aria-label="Extraction strategy"
					value={controller.strategy}
					onChange={controller.setStrategy}
					options={[
						{ value: "catalog", label: "Catalog" },
						{ value: "article", label: "Article" },
					]}
				/>
			</header>

			{state.status === "ready" && displayResult && stats && (
				<>
					<div className="shrink-0 border-b border-line bg-surface px-3 py-2">
						{state.warnings.length > 0 && (
							<ul className="mb-2 space-y-1" aria-label="Extraction warnings">
								{state.warnings.map((warning) => (
									<li
										key={warning}
										className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-ink"
									>
										{warning}
									</li>
								))}
							</ul>
						)}
						<div className="flex flex-wrap gap-1.5">
							{summaryItem("Status", "ready")}
							{summaryItem("Fields", stats.fields)}
							{summaryItem("Missing", stats.missing)}
							{stats.arrayItems > 0 && summaryItem("Array items", stats.arrayItems)}
						</div>
						<div className="mt-2 flex flex-wrap items-center justify-between gap-2">
							<SegmentedControl
								aria-label="Result view"
								value={view}
								onChange={setView}
								options={[
									{ value: "review", label: "Review" },
									{ value: "json", label: "Raw JSON" },
									{ value: "markdown", label: "Markdown" },
								]}
							/>
							<div className="flex flex-wrap gap-1.5">
								{focusPath && onClearFocus && (
									<Button variant="secondary" size="sm" onClick={onClearFocus}>
										× Clear
									</Button>
								)}
								<Button variant="secondary" size="sm" onClick={() => void controller.runExtraction()}>
									Rerun
								</Button>
								<Button variant="secondary" size="sm" onClick={() => void copyJson()}>
									Copy JSON
								</Button>
								<Button variant="secondary" size="sm" onClick={downloadJson}>
									Download
								</Button>
							</div>
						</div>
					</div>

					{view === "review" ? (
						<div className="flex min-h-0 flex-1 flex-col">
							<div className="flex shrink-0 items-center gap-0.5 border-b border-line bg-surface px-2 py-1">
								{(navPath.length > 0 || backStack.length > 0 || forwardStack.length > 0) && <button type="button" title="Back" disabled={backStack.length === 0} onClick={goBack} className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[13px] font-bold leading-none text-ink-muted hover:bg-accent-ghost/40 hover:text-ink disabled:cursor-default disabled:opacity-30">‹</button>}
								{(navPath.length > 0 || backStack.length > 0 || forwardStack.length > 0) && <button type="button" title="Forward" disabled={forwardStack.length === 0} onClick={goForward} className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[13px] font-bold leading-none text-ink-muted hover:bg-accent-ghost/40 hover:text-ink disabled:cursor-default disabled:opacity-30">›</button>}
								<span className="mx-1 h-3.5 w-px shrink-0 bg-line" />
								{navPath.length === 0 ? <span className="px-1.5 py-0.5 text-[12px] font-semibold text-ink">Results</span> : <button type="button" className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[12px] font-semibold text-ink-muted hover:text-accent" onClick={() => jumpToAncestor([])}>Results</button>}
								{navPath.map((segment, index) => {
									const number = Number.parseInt(segment, 10);
									const label = Number.isNaN(number) || String(number) !== segment ? segment : `Item ${number + 1}`;
									return (
										<span key={`${segment}-${index}`} className="flex items-center gap-0.5">
											<span className="text-[11px] text-ink-faint">›</span>
											{index < navPath.length - 1 ? (
												<button type="button" className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[12px] font-semibold text-ink-muted hover:text-accent" onClick={() => jumpToAncestor(navPath.slice(0, index + 1))}>{label}</button>
											) : (
												<span className="px-1.5 py-0.5 text-[12px] font-semibold text-ink">{label}</span>
											)}
										</span>
									);
								})}
							</div>
							<div className="scrollbar-subtle min-h-0 flex-1 overflow-auto bg-canvas px-3 py-2">
								{currentEntries.map(({ pathKey, displayName, value }) => (
									<ResultValue
										key={pathKey}
										name={displayName}
										value={value}
										path={[...navPath, pathKey]}
										onValueClick={onValueClick}
										onNavigateTo={isRecord(value) || Array.isArray(value) ? drillInto : undefined}
										defaultExpanded={navPath.length === 0}
										expandText={navPath.length > 0}
									/>
								))}
							</div>
						</div>
					) : view === "json" ? (
						<pre className="scrollbar-subtle m-0 min-h-0 flex-1 overflow-auto whitespace-pre bg-canvas px-4 py-3.5 font-mono text-[11px] leading-relaxed text-ink">
							{JSON.stringify(displayResult, null, 2)}
						</pre>
					) : documentMarkdown === null ? (
						<div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-[13px] text-ink-muted" role="status">
							Source Markdown is unavailable for this document.
						</div>
					) : (
						<pre className="scrollbar-subtle m-0 min-h-0 flex-1 overflow-auto whitespace-pre-wrap bg-canvas px-4 py-3.5 font-mono text-[11px] leading-relaxed text-ink">{documentMarkdown}</pre>
					)}
				</>
			)}

			{state.status === "running" && (
				<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
					<span aria-hidden="true" className="animate-spin-slow size-7 rounded-full border-[3px] border-line border-t-accent" />
					<p className="text-[13px] font-semibold text-ink">Running {controller.strategy} extraction…</p>
					<p className="max-w-[34ch] text-[13px] leading-snug text-ink-muted">This can take a while on large source documents.</p>
				</div>
			)}

			{state.status === "error" && (
				<div className="m-3.25 rounded-xl border border-danger/40 bg-surface px-4 py-3">
					<p className="text-[13px] font-semibold text-danger">Extraction failed</p>
					<p className="mt-1 wrap-anywhere text-[13px] leading-snug text-ink-muted">{state.message}</p>
					<Button variant="primary" size="md" className="mt-2.5" onClick={() => void controller.runExtraction()}>
						Retry extraction
					</Button>
				</div>
			)}

			{state.status === "idle" && (
				<div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
					<p className="text-[13.5px] font-semibold text-ink">No results yet</p>
					<p className="mt-1.5 max-w-[34ch] text-[13px] leading-snug text-ink-muted">
						{schemaReady
							? `Run ${controller.strategy} extraction against the completed canonical document.`
							: "Generate or choose a schema first, then run extraction."}
					</p>
					<Button variant="primary" size="md" className="mt-4" disabled={!controller.canRun} onClick={() => void controller.runExtraction()}>
						{schemaReady ? `Run ${controller.strategy}` : "Choose a schema first"}
					</Button>
				</div>
			)}
		</div>
	);
}

export default ResultsTab;

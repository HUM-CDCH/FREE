import PanelToggleIcon from "./PanelToggleIcon";
import AnnotationSetTab from "./AnnotationSidebar";
import type { AnnotationSetItem } from "./AnnotationSidebar";
import ChatTab from "./ChatTab";
import SchemaPanel from "./SchemaPanel";
import type { SchemaGenerationState, TemplateState } from "./SchemaPanel";
import type { PinnedSchema } from "./pinnedSchemas";
import ResultsTab from "./ResultsTab";
import type { ExtractionController } from "./useExtraction";
import type { AnnotationsMode } from "./api";
import type {
	ExtractionSchemaEnvelope,
	SchemaChange,
	SchemaSuggestion,
} from "../shared/schema";

export type RailTab = "annot" | "chat" | "schema" | "results";

type RightRailProps = {
	open: boolean;
	onToggle: () => void;
	tab: RailTab;
	onTabChange: (tab: RailTab) => void;
	annotationItems: AnnotationSetItem[];
	onSelectAnnotation: (id: string) => void;
	onRemoveAnnotation: (id: string) => void;
	schemaState: TemplateState;
	schemaGeneration: SchemaGenerationState;
	schemaSuggestion: SchemaSuggestion | null;
	schemaSuggestionStale: boolean;
	schemaStale: boolean;
	schemaReady: boolean;
	pinnedSchemas: readonly PinnedSchema[];
	selectedPinnedSchemaId: string | null;
	onSelectPinnedSchema: (id: string) => void;
	schemaFieldCount: number;
	onGenerate: () => void;
	onSchemaChange: (changes: readonly SchemaChange[], message: string) => void;
	onApplySchemaSuggestion: () => void;
	onRejectSchemaSuggestion: () => void;
	annotationsMode: AnnotationsMode;
	onAnnotationsModeChange: (mode: AnnotationsMode) => void;
	extraction: ExtractionController;
	documentMarkdown: string | null;
	chatSchema: ExtractionSchemaEnvelope | null;
	schemaRevision: number;
	documentEpoch: number;
};

function TabBadge({
	label,
	active,
	done,
}: {
	label: string;
	active: boolean;
	done?: boolean;
}) {
	const tone = done
		? "bg-green-soft text-green"
		: `text-accent ${active ? "bg-accent-soft" : "bg-accent-ghost"}`;
	return (
		<span
			className={`inline-grid h-4 min-w-4.5 place-items-center rounded-full px-1.5 font-mono text-[10px] leading-none tabular-nums ${tone}`}
		>
			{label}
		</span>
	);
}

function RightRail({
	open,
	onToggle,
	tab,
	onTabChange,
	annotationItems,
	onSelectAnnotation,
	onRemoveAnnotation,
	schemaState,
	schemaGeneration,
	schemaSuggestion,
	schemaSuggestionStale,
	schemaStale,
	schemaReady,
	pinnedSchemas,
	selectedPinnedSchemaId,
	onSelectPinnedSchema,
	schemaFieldCount,
	onGenerate,
	onSchemaChange,
	onApplySchemaSuggestion,
	onRejectSchemaSuggestion,
	annotationsMode,
	onAnnotationsModeChange,
	extraction,
	documentMarkdown,
	chatSchema,
	schemaRevision,
	documentEpoch,
}: RightRailProps) {
	if (!open) {
		return (
			<div className="flex h-full flex-col items-center">
				<button
					className="flex cursor-pointer items-center justify-center py-3 text-ink-muted outline-none transition-colors hover:text-accent focus-visible:text-accent"
					type="button"
					title="Expand panel"
					onClick={onToggle}
				>
					<PanelToggleIcon side="right" />
				</button>
				<span className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-ink-muted [writing-mode:vertical-rl]">
					Annot · Chat · Schema · Results
				</span>
			</div>
		);
	}

	const resultsBadge = extraction.hasResults
		? { label: "✓", done: true }
		: null;

	const tabs: {
		key: RailTab;
		label: string;
		badge?: { label: string; done?: boolean } | null;
	}[] = [
		{
			key: "annot",
			label: "Annot.",
			badge: annotationItems.length
				? { label: String(annotationItems.length) }
				: null,
		},
		{ key: "chat", label: "Chat" },
		{
			key: "schema",
			label: "Schema",
			badge: schemaFieldCount ? { label: String(schemaFieldCount) } : null,
		},
		{ key: "results", label: "Results", badge: resultsBadge },
	];

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div
				className="flex shrink-0 items-stretch border-b border-line"
				role="tablist"
			>
				{tabs.map(({ key, label, badge }) => {
					const active = tab === key;
					return (
						<button
							key={key}
							className={`flex flex-1 cursor-pointer items-center justify-center gap-1.5 border-b-2 px-1 pb-2.5 pt-3 text-xs font-bold outline-none transition-colors hover:text-ink focus-visible:text-ink ${
								active
									? "border-accent text-ink"
									: "border-transparent text-ink-muted"
							}`}
							type="button"
							role="tab"
							aria-selected={active}
							onClick={() => onTabChange(key)}
						>
							<span>{label}</span>
							{badge && (
								<TabBadge
									label={badge.label}
									active={active}
									done={badge.done}
								/>
							)}
						</button>
					);
				})}
				<button
					className="flex cursor-pointer items-center justify-center border-b-2 border-transparent px-2.5 text-ink-muted outline-none transition-colors hover:text-accent focus-visible:text-accent"
					type="button"
					title="Collapse panel"
					onClick={onToggle}
				>
					<PanelToggleIcon side="right" />
				</button>
			</div>

			{/* All tab bodies stay mounted so chat drafts and schema edit state survive tab switches. */}
			<div className="min-h-0 flex-1" hidden={tab !== "annot"}>
				<AnnotationSetTab
					items={annotationItems}
					onSelectItem={onSelectAnnotation}
					onRemoveItem={onRemoveAnnotation}
				/>
			</div>
			<div className="min-h-0 flex-1" hidden={tab !== "chat"}>
				<ChatTab
					markdown={documentMarkdown}
					annotations={annotationItems}
					schema={chatSchema}
					revision={schemaRevision}
					documentEpoch={documentEpoch}
				/>
			</div>
			<div className="min-h-0 flex-1" hidden={tab !== "schema"}>
				<SchemaPanel
					state={schemaState}
					generationState={schemaGeneration}
					suggestion={schemaSuggestion}
					suggestionStale={schemaSuggestionStale}
					stale={schemaStale}
					pinnedSchemas={pinnedSchemas}
					selectedPinnedSchemaId={selectedPinnedSchemaId}
					onSelectPinnedSchema={onSelectPinnedSchema}
					onGenerate={onGenerate}
					onSchemaChange={onSchemaChange}
					onApplySuggestion={onApplySchemaSuggestion}
					onRejectSuggestion={onRejectSchemaSuggestion}
					annotationCount={annotationItems.length}
					annotationsMode={annotationsMode}
					onAnnotationsModeChange={onAnnotationsModeChange}
				/>
			</div>
			<div className="min-h-0 flex-1" hidden={tab !== "results"}>
				<ResultsTab controller={extraction} schemaReady={schemaReady} />
			</div>
		</div>
	);
}

export default RightRail;

import { useState } from "react";
import type { SchemaChange } from "../shared/schema";
import type { AnnotationsMode, ExtractionSchemaEnvelope } from "./api";
import { Panel, Overline, SegmentedControl, Spinner, Button } from "./ui";
import {
	FIELD_TYPES,
	countTemplateFields,
	fieldTypeLabel,
	isRecord,
} from "./template";
import type { TemplatePath } from "./template";
import type { PinnedSchema } from "./pinnedSchemas";
import { fieldEditChanges } from "./schemaFieldEdits";

export type TemplateState =
	| { status: "idle" }
	| { status: "generating" }
	| {
			status: "ready";
			schema: ExtractionSchemaEnvelope;
			inputsKey: string;
			source: "generated" | "pinned";
			pinnedSchemaId?: string;
			edited?: boolean;
	  }
	| { status: "error"; message: string };

type SchemaPanelProps = {
	state: TemplateState;
	stale: boolean;
	pinnedSchemas: readonly PinnedSchema[];
	selectedPinnedSchemaId: string | null;
	onSelectPinnedSchema: (id: string) => void;
	onGenerate: () => void;
	onSchemaChange: (changes: readonly SchemaChange[], message: string) => void;
	annotationCount: number;
	annotationsMode: AnnotationsMode;
	onAnnotationsModeChange: (mode: AnnotationsMode) => void;
};

type FieldEditing = {
	pathKey: string;
	name: string;
	type: string;
};

type FieldEditorProps = {
	editable: boolean;
	editing: FieldEditing | null;
	onStartEdit: (path: TemplatePath, name: string, type: string) => void;
	onEditingChange: (editing: FieldEditing) => void;
	onSaveEdit: (path: TemplatePath) => void;
	onCancelEdit: () => void;
	onRemove: (path: TemplatePath, name: string) => void;
};

function pathKey(path: TemplatePath) {
	return path.join("\0");
}

function TypeChip({ label }: { label: string }) {
	return (
		<span className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 font-mono text-[10px] font-medium leading-none text-ink-muted">
			{label}
		</span>
	);
}

function FieldName({ name }: { name: string }) {
	return (
		<span className="min-w-0 truncate font-mono text-[12.5px] font-medium text-ink">
			{name}
		</span>
	);
}

function typeOptions(current: string) {
	const options: string[] = [...FIELD_TYPES];
	if (!options.includes(current)) {
		options.unshift(current);
	}
	return options;
}

function templateValueAtPath(
	record: Record<string, unknown>,
	path: TemplatePath,
) {
	let value: unknown = record;
	for (const segment of path) {
		if (Array.isArray(value)) value = value[0];
		if (!isRecord(value)) return undefined;
		value = value[segment];
	}
	return value;
}

function FieldEditForm({
	path,
	editing,
	onEditingChange,
	onSaveEdit,
	onCancelEdit,
}: {
	path: TemplatePath;
	editing: FieldEditing;
	onEditingChange: (editing: FieldEditing) => void;
	onSaveEdit: (path: TemplatePath) => void;
	onCancelEdit: () => void;
}) {
	return (
		<div className="my-0.5 flex flex-col gap-1.5 rounded-lg border border-accent bg-accent-ghost px-2.5 py-2">
			<input
				className="min-w-0 rounded-md border border-line-strong bg-surface px-2 py-1 font-mono text-xs font-semibold text-ink outline-none focus-visible:border-accent"
				value={editing.name}
				placeholder="field_name"
				autoFocus
				onChange={(event) =>
					onEditingChange({ ...editing, name: event.target.value })
				}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						onSaveEdit(path);
					}
					if (event.key === "Escape") {
						onCancelEdit();
					}
				}}
			/>
			<div className="flex items-center gap-1.5">
				<select
					className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-1.5 py-1 font-mono text-[11px] text-ink outline-none focus-visible:border-accent"
					value={editing.type}
					onChange={(event) =>
						onEditingChange({ ...editing, type: event.target.value })
					}
				>
					{typeOptions(editing.type).map((option) => (
						<option key={option} value={option}>
							{option}
						</option>
					))}
				</select>
				<button
					className="shrink-0 cursor-pointer rounded-md border border-accent bg-accent px-2.5 py-1 text-[11.5px] font-bold text-white outline-none transition-[filter] hover:brightness-108"
					type="button"
					onClick={() => onSaveEdit(path)}
				>
					Save
				</button>
				<button
					className="shrink-0 cursor-pointer rounded-md border border-line-strong bg-surface px-2 py-1 text-[11.5px] font-semibold text-ink-muted outline-none transition-colors hover:text-accent"
					type="button"
					title="Cancel"
					onClick={onCancelEdit}
				>
					✕
				</button>
			</div>
		</div>
	);
}

function FieldActions({
	path,
	name,
	type,
	editor,
}: {
	path: TemplatePath;
	name: string;
	type: string;
	editor: FieldEditorProps;
}) {
	return (
		<span className="flex shrink-0 items-center gap-0.5">
			<button
				className="cursor-pointer px-1 text-[11px] leading-none text-ink-faint outline-none transition-colors hover:text-accent focus-visible:text-accent"
				type="button"
				title={`Edit field: ${name}`}
				onClick={() => editor.onStartEdit(path, name, type)}
			>
				✎
			</button>
			<button
				className="cursor-pointer px-1 text-[10px] leading-none text-ink-faint outline-none transition-colors hover:text-accent focus-visible:text-accent"
				type="button"
				title={`Remove field: ${name}`}
				onClick={() => editor.onRemove(path, name)}
			>
				✕
			</button>
		</span>
	);
}

function NestedFields({
	value,
	path,
	editor,
}: {
	value: Record<string, unknown>;
	path: TemplatePath;
	editor: FieldEditorProps;
}) {
	return (
		<div className="ml-1.5 mt-1.5 border-l border-line pl-2.5">
			<TemplateFields template={value} path={path} editor={editor} />
		</div>
	);
}

function TemplateField({
	name,
	value,
	path,
	editor,
}: {
	name: string;
	value: unknown;
	path: TemplatePath;
	editor: FieldEditorProps;
}) {
	const type = fieldTypeLabel(value);

	if (editor.editable && editor.editing?.pathKey === pathKey(path)) {
		return (
			<li>
				<FieldEditForm
					path={path}
					editing={editor.editing}
					onEditingChange={editor.onEditingChange}
					onSaveEdit={editor.onSaveEdit}
					onCancelEdit={editor.onCancelEdit}
				/>
			</li>
		);
	}

	const rowClasses =
		"-mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-accent-ghost";

	if (Array.isArray(value)) {
		const first: unknown = value[0];
		if (isRecord(first)) {
			return (
				<li>
					<div className={rowClasses}>
						<FieldName name={name} />
						<TypeChip label="list" />
						<span className="min-w-0 flex-1" />
						{editor.editable && (
							<FieldActions
								path={path}
								name={name}
								type={type}
								editor={editor}
							/>
						)}
					</div>
					<NestedFields value={first} path={path} editor={editor} />
				</li>
			);
		}
		return (
			<li className={rowClasses}>
				<FieldName name={name} />
				<TypeChip
					label={`list of ${typeof first === "string" ? first : "values"}`}
				/>
				<span className="min-w-0 flex-1" />
				{editor.editable && (
					<FieldActions path={path} name={name} type={type} editor={editor} />
				)}
			</li>
		);
	}

	if (isRecord(value)) {
		return (
			<li>
				<div className={rowClasses}>
					<FieldName name={name} />
					<span className="min-w-0 flex-1" />
					{editor.editable && (
						<FieldActions path={path} name={name} type={type} editor={editor} />
					)}
				</div>
				<NestedFields value={value} path={path} editor={editor} />
			</li>
		);
	}

	return (
		<li className={rowClasses}>
			<FieldName name={name} />
			<TypeChip label={String(value)} />
			<span className="min-w-0 flex-1" />
			{editor.editable && (
				<FieldActions path={path} name={name} type={type} editor={editor} />
			)}
		</li>
	);
}

function TemplateFields({
	template,
	path,
	editor,
}: {
	template: Record<string, unknown>;
	path: TemplatePath;
	editor: FieldEditorProps;
}) {
	return (
		<ul className="flex flex-col gap-1">
			{Object.entries(template)
				.filter(([name]) => name !== "_evidence")
				.map(([name, value]) => (
					<TemplateField
						key={name}
						name={name}
						value={value}
						path={[...path, name]}
						editor={editor}
					/>
				))}
		</ul>
	);
}

function WorkingIndicator() {
	return (
		<div className="rounded-md border border-line bg-canvas px-4 py-8">
			<Spinner
				label="Producing schema…"
				hint="This can take a while on large documents."
			/>
		</div>
	);
}

function AnnotationsModeToggle({
	mode,
	onChange,
}: {
	mode: AnnotationsMode;
	onChange: (mode: AnnotationsMode) => void;
}) {
	return (
		<SegmentedControl
			aria-label="How highlights shape the schema"
			value={mode}
			onChange={onChange}
			options={[
				{
					value: "hints",
					label: "Hints",
					title:
						"Schema covers the whole document, highlights must be included",
				},
				{
					value: "fields",
					label: "Fields",
					title: "Schema is built primarily from the highlights",
				},
			]}
		/>
	);
}

function SchemaPanel({
	state,
	stale,
	pinnedSchemas,
	selectedPinnedSchemaId,
	onSelectPinnedSchema,
	onGenerate,
	onSchemaChange,
	annotationCount,
	annotationsMode,
	onAnnotationsModeChange,
}: SchemaPanelProps) {
	const [view, setView] = useState<"fields" | "json">("fields");
	const [editing, setEditing] = useState<FieldEditing | null>(null);
	const ready = state.status === "ready";
	const template = ready ? state.schema.record : null;
	const fieldCount = ready ? countTemplateFields(state.schema.record) : 0;

	function selectPinnedSchema(id: string) {
		setEditing(null);
		onSelectPinnedSchema(id);
	}

	function startEdit(path: TemplatePath, name: string, type: string) {
		setEditing({ pathKey: pathKey(path), name, type });
	}

	function saveEdit(path: TemplatePath) {
		if (!editing || !ready) {
			return;
		}
		const name = editing.name.trim().toLowerCase().replace(/\s+/g, "_");
		if (!name) {
			setEditing(null);
			return;
		}
		const currentValue = templateValueAtPath(state.schema.record, path);
		const changes = fieldEditChanges(path, currentValue, name, editing.type);
		if (changes.length > 0) {
			onSchemaChange(changes, "✎ Schema updated");
		}
		setEditing(null);
	}

	function removeField(path: TemplatePath) {
		if (!ready) {
			return;
		}
		setEditing(null);
		onSchemaChange(
			[{ operation: "remove", path }],
			"Field removed from schema",
		);
	}

	function addField() {
		if (!ready) {
			return;
		}
		let name = "nyt_felt";
		let suffix = 2;
		while (name in state.schema.record) {
			name = `nyt_felt_${suffix++}`;
		}
		onSchemaChange(
			[{ operation: "set", path: [name], value: "verbatim-string" }],
			"✎ Schema updated",
		);
		setView("fields");
		setEditing({ pathKey: pathKey([name]), name, type: "verbatim-string" });
	}

	const editor: FieldEditorProps = {
		editable: ready,
		editing,
		onStartEdit: startEdit,
		onEditingChange: setEditing,
		onSaveEdit: saveEdit,
		onCancelEdit: () => setEditing(null),
		onRemove: removeField,
	};

	return (
		<Panel
			header={
				<>
					<div className="min-w-0">
						<Overline as="h2">Extraction Schema</Overline>
						<p className="truncate font-mono text-xs font-medium text-ink">
							{ready
								? (state.schema.name ?? "Generated schema")
								: "Choose or generate a schema"}
						</p>
					</div>
					<SegmentedControl
						aria-label="Schema view"
						value={view}
						onChange={setView}
						options={[
							{ value: "fields", label: "Fields" },
							{
								value: "json",
								label: <span className="font-mono">{"{ }"}</span>,
							},
						]}
					/>
				</>
			}
			footer={
				<>
					<p className="text-[11px] leading-snug text-ink-faint">
						{state.status === "generating" && (
							<span className="inline-flex items-center gap-1.5">
								<span
									aria-hidden="true"
									className="size-1.5 animate-pulse rounded-full bg-amber-500"
								/>
								Producing schema from the document…
							</span>
						)}
						{ready &&
							(state.source === "pinned" ? (
								`${fieldCount} field${fieldCount === 1 ? "" : "s"} · pinned from FREE-technical`
							) : stale ? (
								<span className="inline-flex items-center gap-1.5">
									<span
										aria-hidden="true"
										className="size-1.5 shrink-0 rounded-full bg-amber-500"
									/>
									Highlights changed — regenerate to update the schema
								</span>
							) : (
								`${fieldCount} field${fieldCount === 1 ? "" : "s"} · produced from the document${
									state.edited ? " · edited by you" : ""
								}`
							))}
						{state.status === "idle" &&
							"Generate to produce the schema from the document"}
						{state.status === "error" && "Generation failed"}
					</p>
					{ready && (
						<div className="flex shrink-0 items-center gap-2">
							{state.source === "generated" && annotationCount > 0 && (
								<AnnotationsModeToggle
									mode={annotationsMode}
									onChange={onAnnotationsModeChange}
								/>
							)}
							<Button variant="pill" size="sm" onClick={onGenerate}>
								{state.source === "generated"
									? "Regenerate"
									: "Generate from document"}
							</Button>
						</div>
					)}
				</>
			}
		>
			<label className="mb-3 block text-[11px] font-semibold text-ink-muted">
				Pinned extraction schema
				<select
					className="mt-1 w-full rounded-md border border-line-strong bg-surface px-2 py-1.5 font-mono text-xs text-ink outline-none focus-visible:border-accent"
					value={selectedPinnedSchemaId ?? ""}
					onChange={(event) => {
						if (event.target.value) selectPinnedSchema(event.target.value);
					}}
				>
					<option value="" disabled>
						Generated from this document
					</option>
					{pinnedSchemas.map((schema) => (
						<option key={schema.id} value={schema.id}>
							{schema.domain} / {schema.name}
						</option>
					))}
				</select>
			</label>

			{state.status === "idle" && (
				<div className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center">
					<p className="text-[13px] font-semibold text-ink">No schema yet</p>
					<p className="mt-1 text-xs leading-relaxed text-ink-muted">
						FREE produces the extraction schema from the document with the
						extraction model.
					</p>
					{annotationCount > 0 && (
						<div className="mt-3 flex items-center justify-center gap-2">
							<span className="text-[11px] text-ink-faint">
								Use highlights as
							</span>
							<AnnotationsModeToggle
								mode={annotationsMode}
								onChange={onAnnotationsModeChange}
							/>
						</div>
					)}
					<Button
						variant="pill"
						size="sm"
						className="mt-3"
						onClick={onGenerate}
					>
						Generate schema
					</Button>
				</div>
			)}

			{state.status === "generating" && <WorkingIndicator />}

			{state.status === "error" && (
				<div className="rounded-xl border border-dashed border-danger/40 px-4 py-6 text-center">
					<p className="text-[13px] leading-snug text-danger">
						{state.message}
					</p>
					<Button
						variant="pill"
						size="sm"
						className="mt-3"
						onClick={onGenerate}
					>
						Retry
					</Button>
				</div>
			)}

			{ready &&
				(view === "json" ? (
					<pre className="overflow-x-auto whitespace-pre rounded-md border border-line bg-canvas p-2.5 font-mono text-[11px] leading-relaxed text-ink">
						{JSON.stringify(state.schema, null, 2)}
					</pre>
				) : isRecord(template) ? (
					<>
						<TemplateFields template={template} path={[]} editor={editor} />
						<button
							className="mt-2.5 block w-full cursor-pointer rounded-lg border-[1.5px] border-dashed border-line-strong bg-transparent py-2 text-xs font-semibold text-ink-muted outline-none transition-colors hover:border-accent hover:text-accent focus-visible:border-accent focus-visible:text-accent"
							type="button"
							onClick={addField}
						>
							+ Add field
						</button>
					</>
				) : (
					<pre className="scrollbar-subtle max-h-72 overflow-y-auto whitespace-pre-wrap wrap-break-word rounded-md border border-line bg-canvas p-2.5 font-mono text-[11px] leading-relaxed text-ink-muted">
						{String(template)}
					</pre>
				))}
		</Panel>
	);
}

export default SchemaPanel;

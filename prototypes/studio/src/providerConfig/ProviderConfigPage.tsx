import { useState } from "react";
import { Button, EmptyState, Overline, Pill } from "../ui";
import {
	API_PROVIDERS,
	CONNECTION_KINDS,
	INITIAL_CONNECTIONS,
	INITIAL_ROUTES,
	ROUTABLE_TASKS,
	type ApiProviderKey,
	type Connection,
	type ConnectionKind,
	type Draft,
	type TaskId,
} from "./providerConfig.data";

const fieldClass =
	"w-full rounded-lg border border-line-strong bg-canvas px-2.75 py-2 text-[12.5px] text-ink outline-none transition-colors placeholder:text-ink-faint focus-visible:border-accent";
const tones = {
	ok: { pill: "success", dot: "bg-green", text: "text-green", border: "border-line" },
	warn: { pill: "stale", dot: "bg-stale", text: "text-stale-ink", border: "border-stale" },
	err: { pill: "danger", dot: "bg-danger", text: "text-danger", border: "border-danger/40" },
} as const;

function modelsFor(connection: Connection) {
	return connection.kind === "api" && connection.apiProvider
		? API_PROVIDERS[connection.apiProvider].models
		: CONNECTION_KINDS[connection.kind].models;
}

function kindNameFor(connection: Connection) {
	return connection.kind === "api" && connection.apiProvider
		? API_PROVIDERS[connection.apiProvider].name
		: CONNECTION_KINDS[connection.kind].name;
}

function connectionStatus(connection: Connection) {
	if (!connection.reachable) return { kind: "err", text: "Unreachable" } as const;
	if (connection.kind === "api" && !connection.apiKey)
		return { kind: "warn", text: "Key required" } as const;
	return {
		kind: "ok",
		text: connection.kind === "codex" || connection.kind === "claudecode" ? "Detected" : "Connected",
	} as const;
}

function Dot({ kind }: { kind: keyof typeof tones }) {
	return <span aria-hidden="true" className={`size-1.25 shrink-0 rounded-full ${tones[kind].dot}`} />;
}

function ProviderConfigPage({ onClose }: { onClose: () => void }) {
	const [connections, setConnections] = useState(INITIAL_CONNECTIONS);
	const [routes, setRoutes] = useState(INITIAL_ROUTES);
	const [draft, setDraft] = useState<Draft | "pick" | null>(null);
	const [showAdvanced, setShowAdvanced] = useState(false);

	function pickKind(kind: ConnectionKind) {
		const provider = kind === "api" ? API_PROVIDERS.openai : null;
		const config = CONNECTION_KINDS[kind];
		setShowAdvanced(false);
		setDraft({
			kind,
			apiProvider: provider ? "openai" : undefined,
			name: provider?.name ?? config.name,
			baseUrl:
				provider?.defaultUrl ?? ("defaultUrl" in config ? config.defaultUrl : ""),
			apiKey: "",
		});
	}

	function save() {
		if (!draft || draft === "pick") return;
		setConnections((current) => [
			...current,
			{ ...draft, name: draft.name || CONNECTION_KINDS[draft.kind].name, id: crypto.randomUUID(), reachable: true },
		]);
		setDraft(null);
	}

	function updateRoute(taskId: TaskId, connectionId: string) {
		const connection = connections.find((item) => item.id === connectionId);
		setRoutes((current) => ({
			...current,
			[taskId]: { connectionId, model: connection ? modelsFor(connection)[0]?.id : null },
		}));
	}

	const routeStatuses = ROUTABLE_TASKS.map((task) => {
		const route = routes[task.id];
		const connection = connections.find((item) => item.id === route.connectionId);
		if (!connection) return { kind: "err", text: route.connectionId ? "Connection removed · pick another" : "Select a connection" } as const;
		const status = connectionStatus(connection);
		if (status.kind !== "ok") return status;
		return modelsFor(connection).some((model) => model.id === route.model)
			? ({ kind: "ok", text: "Ready" } as const)
			: ({ kind: "warn", text: "Model unavailable" } as const);
	});
	const allReady = routeStatuses.every((status) => status.kind === "ok");
	const anyError = routeStatuses.some((status) => status.kind === "err");
	const connectedIds = new Set(Object.values(routes).map((route) => route.connectionId).filter(Boolean));
	const singleConnection = connectedIds.size === 1;
	const overall = allReady ? "ok" : anyError ? "err" : "warn";

	return (
		<div className="mx-auto max-w-4xl overflow-hidden rounded-2xl border border-line bg-surface-muted shadow-page">
			<header className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-2.75">
				<div className="flex items-center gap-2"><b className="text-[13px] tracking-[0.08em] text-accent">FREE</b><span className="text-[11px] font-medium text-ink-faint">/ Providers</span></div>
				<div className="flex items-center gap-3"><Pill tone={tones[overall].pill} outline className="gap-1.5"><Dot kind={overall} />{allReady ? singleConnection ? "Single provider · ready" : "Mixed · ready" : "Needs attention"}</Pill><button type="button" onClick={onClose} aria-label="Close provider configuration" title="Close" className="text-ink-muted transition-colors hover:text-accent">✕</button></div>
			</header>
			<div className="grid grid-cols-1 md:grid-cols-[1.08fr_1fr]">
				<section className="min-h-90 border-b border-line p-4.5 md:border-r md:border-b-0">
					<div className="mb-3.25 flex items-center justify-between"><Overline>Your connections</Overline>{draft === null && <Button variant="primary" size="sm" onClick={() => setDraft("pick")}>+ New connection</Button>}</div>
					{draft === null && <div className="flex flex-col gap-2.25">
						{connections.map((connection) => {
							const status = connectionStatus(connection);
							return <div key={connection.id} className={`rounded-xl border bg-surface p-3 ${tones[status.kind].border}`}>
								<div className="flex items-center justify-between gap-2"><b className="min-w-0 truncate text-[12.5px] text-ink">{connection.name}</b><div className="flex shrink-0 items-center gap-1.5"><Pill tone={tones[status.kind].pill} className="gap-1"><Dot kind={status.kind} />{status.text}</Pill><button type="button" title="Delete connection" aria-label={`Delete ${connection.name}`} onClick={() => setConnections((current) => current.filter((item) => item.id !== connection.id))} className="grid size-5.5 place-items-center rounded-md border border-line text-sm text-ink-faint transition-colors hover:border-danger/40 hover:text-danger">×</button></div></div>
								<p className="mt-1 truncate font-mono text-[11px] text-ink-faint">{connection.baseUrl || "Local agent harness"}</p><p className="mt-0.5 text-[10.5px] text-ink-faint">{kindNameFor(connection)} · {modelsFor(connection).length} models</p>
							</div>;
						})}
						{connections.length === 0 && <EmptyState title="No connections yet." description="Add one to route your tasks." />}
					</div>}
					{draft === "pick" && <div>
						<div className="mb-2.75 flex items-center justify-between"><span className="text-xs text-ink-muted">Choose a connection type</span><button type="button" onClick={() => setDraft(null)} className="text-[11px] font-semibold text-ink-muted hover:text-ink">Cancel</button></div>
						<div className="grid grid-cols-2 gap-2">{Object.entries(CONNECTION_KINDS).map(([kind, config]) => <button key={kind} type="button" onClick={() => pickKind(kind as ConnectionKind)} className="flex flex-col items-start gap-0.5 rounded-lg border border-line-strong bg-surface p-2.75 text-left outline-none transition-colors hover:border-accent/50 focus-visible:border-accent"><b className="text-xs text-ink">{config.name}</b><span className="text-[10px] text-ink-faint">{config.tagline}</span></button>)}</div>
					</div>}
					{draft && draft !== "pick" && <div className="flex flex-col gap-3">
						<b className="text-[13px] text-ink">New {draft.kind === "api" && draft.apiProvider ? API_PROVIDERS[draft.apiProvider].name : CONNECTION_KINDS[draft.kind].name} connection</b>
						{draft.kind === "api" && <label className="flex flex-col gap-1.5"><span className="font-mono text-[10px] font-semibold uppercase tracking-[0.07em] text-ink-muted">Provider</span><select value={draft.apiProvider} onChange={(event) => {
							const key = event.target.value as ApiProviderKey;
							const provider = API_PROVIDERS[key];
							setDraft({ ...draft, apiProvider: key, name: provider.name, baseUrl: provider.defaultUrl });
						}} className={`${fieldClass} cursor-pointer`}>{Object.entries(API_PROVIDERS).map(([key, provider]) => <option key={key} value={key}>{provider.name}</option>)}</select></label>}
						<label className="flex flex-col gap-1.5"><span className="font-mono text-[10px] font-semibold uppercase tracking-[0.07em] text-ink-muted">Display name</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="e.g. Lab GPU box" className={fieldClass} /></label>
						{(draft.kind === "api" || draft.kind === "ollama") && <label className="flex flex-col gap-1.5"><span className="font-mono text-[10px] font-semibold uppercase tracking-[0.07em] text-ink-muted">{draft.kind === "api" ? "API key" : "API key (only if your server requires one)"}</span><input type="password" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} placeholder="sk-…" className={`font-mono ${fieldClass}`} /></label>}
						{(draft.kind === "ollama" || (draft.kind === "api" && showAdvanced)) && <label className="flex flex-col gap-1.5"><span className="font-mono text-[10px] font-semibold uppercase tracking-[0.07em] text-ink-muted">{draft.kind === "api" ? "API base URL" : "Server URL"}</span><input value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="http://localhost:11434" className={`font-mono ${fieldClass}`} /></label>}
						{draft.kind === "api" && <button type="button" onClick={() => setShowAdvanced((current) => !current)} className="self-start font-mono text-[10.5px] font-semibold text-accent">{showAdvanced ? "Hide advanced" : "Advanced · custom base URL"}</button>}
						<p className="text-[11px] leading-relaxed text-ink-faint">{draft.kind === "api" ? "The base URL is set from the provider · open Advanced to change it for a proxy or gateway." : draft.kind === "ollama" ? "Point at localhost or a remote machine. Any OpenAI-compatible server works." : `Uses your local ${CONNECTION_KINDS[draft.kind].name} sign-in · no URL or key needed.`}</p>
						<div className="mt-0.5 flex gap-2"><Button variant="primary" size="md" disabled={(draft.kind === "ollama" && !draft.baseUrl) || (draft.kind === "api" && !draft.apiKey)} onClick={save}>Save connection</Button><Button variant="secondary" size="md" onClick={() => setDraft(null)}>Cancel</Button></div>
					</div>}
				</section>
				<section className="p-4.5">
					<Overline as="p" className="mb-3.25">Task routing</Overline>
					<div className="flex flex-col gap-3.25">{ROUTABLE_TASKS.map((task, index) => {
						const route = routes[task.id];
						const connection = connections.find((item) => item.id === route.connectionId);
						const status = routeStatuses[index];
						return <div key={task.id} className="rounded-xl border border-line bg-surface p-3.5">
							<b className="text-[12.5px] text-ink">{task.label}</b><p className="mb-2.75 text-[10.5px] text-ink-faint">{task.sub}</p>
							<div className="flex flex-col gap-2"><select value={connection?.id ?? ""} onChange={(event) => updateRoute(task.id, event.target.value)} className={`${fieldClass} cursor-pointer`}><option value="" disabled>Select a connection…</option>{connections.map((item) => <option key={item.id} value={item.id}>{item.name} · {kindNameFor(item)}</option>)}</select>
							{connection && <select value={route.model ?? ""} onChange={(event) => setRoutes((current) => ({ ...current, [task.id]: { ...route, model: event.target.value } }))} className={`cursor-pointer font-mono ${fieldClass}`}>{modelsFor(connection).map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select>}</div>
							<div className="mt-2.25 flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.04em]"><Dot kind={status.kind} /><span className={tones[status.kind].text}>{status.text}</span></div>
						</div>;
					})}<p className="px-0.5 text-[11px] font-medium text-ink-muted">{singleConnection ? "All tasks use the same connection." : "Mixed setup · each task uses a different connection."}</p></div>
				</section>
			</div>
		</div>
	);
}

export default ProviderConfigPage;

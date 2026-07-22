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

const providerOptions = Object.entries(API_PROVIDERS).map(([key, provider]) => <option key={key} value={key}>{provider.name}</option>);
const keyPlaceholder: Record<ApiProviderKey, string> = { openai: "sk-...", anthropic: "sk-ant-...", google: "AIza..." };

const EyeIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>;
const EyeOffIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4" aria-hidden="true"><path d="M10.6 10.6a3 3 0 0 0 4.2 4.2M9.4 5.2A9.7 9.7 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.3 4.1M6.1 6.1A17.6 17.6 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 3.9-.8" /><path d="m2 2 20 20" /></svg>;

function ApiKeyField({ label = "API key", value, onChange, placeholder, className = "gap-1.5" }: { label?: string; value: string; onChange: (value: string) => void; placeholder: string; className?: string }) {
	const [reveal, setReveal] = useState(false);
	// ponytail: type=text + CSS masking (not type=password) so browser/password managers don't offer "strong password" suggestions on a secret that isn't a login password.
	return <label className={`flex flex-col ${className}`}><span className="font-mono text-[10px] font-semibold uppercase tracking-[0.07em] text-ink-muted">{label}</span><div className="relative"><input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} autoComplete="off" data-1p-ignore data-lpignore="true" className={`pr-9 font-mono ${reveal ? "" : "[-webkit-text-security:disc]"} ${fieldClass}`} />{value && <button type="button" onClick={() => setReveal((current) => !current)} aria-label={reveal ? "Hide API key" : "Show API key"} className="absolute inset-y-0 right-2.5 flex items-center text-ink-faint transition-colors hover:text-ink">{reveal ? EyeOffIcon : EyeIcon}</button>}</div></label>;
}

function ProviderConfigPage({ onClose }: { onClose: () => void }) {
	const [connections, setConnections] = useState(INITIAL_CONNECTIONS);
	const [routes, setRoutes] = useState(INITIAL_ROUTES);
	const [draft, setDraft] = useState<Draft | "pick" | null>(null);
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [mode, setMode] = useState<"simple" | "advanced">("simple");
	const [simple, setSimple] = useState({ provider: "openai" as ApiProviderKey, apiKey: "", model: API_PROVIDERS.openai.models[0].id as string });

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
			{ ...draft, apiKey: draft.apiKey.trim(), name: draft.name || CONNECTION_KINDS[draft.kind].name, id: crypto.randomUUID(), reachable: true },
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

	const simpleConnection = connections.find((item) => item.kind === "api" && item.apiProvider === simple.provider);
	const simpleProvider = API_PROVIDERS[simple.provider];
	const hasDraft = !!simple.apiKey.trim();
	const hasStoredKey = !!simpleConnection?.apiKey;
	const simpleApplied = !hasDraft && hasStoredKey && ROUTABLE_TASKS.every((task) => routes[task.id].connectionId === simpleConnection.id && routes[task.id].model === simple.model);

	function applySimple() {
		const apiKey = simple.apiKey.trim() || simpleConnection?.apiKey;
		if (!apiKey) return;
		const connection: Connection = simpleConnection
			? { ...simpleConnection, apiKey, reachable: true }
			: { id: crypto.randomUUID(), kind: "api", apiProvider: simple.provider, name: simpleProvider.name, baseUrl: simpleProvider.defaultUrl, apiKey, reachable: true };
		setConnections((current) => (simpleConnection ? current.map((item) => (item.id === connection.id ? connection : item)) : [...current, connection]));
		setRoutes({ ext: { connectionId: connection.id, model: simple.model }, chat: { connectionId: connection.id, model: simple.model } });
		setSimple((current) => ({ ...current, apiKey: "" }));
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
	const singleConnection = new Set(Object.values(routes).map((route) => route.connectionId).filter(Boolean)).size === 1;
	const routesUniform = !!routes.ext.connectionId && ROUTABLE_TASKS.every((task) => routes[task.id].connectionId === routes.ext.connectionId && routes[task.id].model === routes.ext.model);
	const simpleStatusText = simpleApplied
		? `${simpleProvider.name} · ${simpleProvider.models.find((model) => model.id === simple.model)?.label}`
		: !hasStoredKey && !hasDraft
			? `Paste your ${simpleProvider.name} API key.`
			: "Not saved · Apply.";

	return (
		<div className="mx-auto max-w-4xl overflow-hidden rounded-2xl border border-line bg-surface-muted shadow-page">
			<header className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-2.75">
				<b className="text-[13px] text-ink">Providers</b>
				<div className="flex shrink-0 items-center gap-3"><div role="group" aria-label="Configuration mode" className="flex shrink-0 gap-0.5 rounded-lg border border-line bg-surface-muted p-0.5">{(["simple", "advanced"] as const).map((value) => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)} className={`cursor-pointer rounded-md px-3 py-[5px] text-[10.5px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${mode === value ? "bg-canvas text-accent shadow-[0_1px_2px_rgba(60,50,40,0.12)]" : "bg-transparent text-ink-faint hover:text-ink"}`}>{value === "simple" ? "Single model" : "Task routing"}</button>)}</div><button type="button" onClick={onClose} aria-label="Close provider configuration" title="Close" className="text-ink-muted transition-colors hover:text-accent">✕</button></div>
			</header>
			{mode === "simple" && <div className="flex flex-col gap-4 p-4.5">
				{!routesUniform && <div className="flex items-center gap-2 rounded-[9px] border border-stale bg-stale-soft px-3 py-2.25 text-[11px] font-medium leading-[1.35] text-stale-ink"><span aria-hidden="true" className="size-1.25 shrink-0 rounded-full bg-current" />Tasks currently use different models — pick one below and Apply to use it everywhere.</div>}
				<div className="grid grid-cols-2 gap-3.5">
					<label className="flex flex-col gap-1.75"><span className="font-mono text-[10px] font-semibold uppercase tracking-[0.07em] text-ink-muted">Provider</span><select value={simple.provider} onChange={(event) => { const provider = event.target.value as ApiProviderKey; setSimple({ provider, apiKey: "", model: API_PROVIDERS[provider].models[0].id }); }} className={`${fieldClass} cursor-pointer`}>{providerOptions}</select></label>
					<label className="flex flex-col gap-1.75"><span className="font-mono text-[10px] font-semibold uppercase tracking-[0.07em] text-ink-muted">Model</span><select value={simple.model} onChange={(event) => setSimple((current) => ({ ...current, model: event.target.value }))} className={`cursor-pointer font-mono ${fieldClass}`}>{simpleProvider.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label>
				</div>
				<ApiKeyField value={simple.apiKey} onChange={(apiKey) => setSimple((current) => ({ ...current, apiKey }))} placeholder={hasStoredKey ? keyPlaceholder[simple.provider] : "Paste your API key"} className="gap-1.75" />
				<div className="flex items-center justify-between gap-3">
					<div className="flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.04em]"><Dot kind={simpleApplied ? "ok" : "warn"} /><span className={tones[simpleApplied ? "ok" : "warn"].text}>{simpleStatusText}</span></div>
					<Button variant="primary" size="md" disabled={!hasDraft && !hasStoredKey} onClick={applySimple}>Apply</Button>
				</div>
			</div>}
			{mode === "advanced" && <div className="grid grid-cols-1 md:grid-cols-[1.08fr_1fr]">
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
							setDraft({ ...draft, apiProvider: key, name: provider.name, baseUrl: provider.defaultUrl, apiKey: "" });
						}} className={`${fieldClass} cursor-pointer`}>{providerOptions}</select></label>}
						<label className="flex flex-col gap-1.5"><span className="font-mono text-[10px] font-semibold uppercase tracking-[0.07em] text-ink-muted">Display name</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="e.g. Lab GPU box" className={fieldClass} /></label>
						{(draft.kind === "api" || draft.kind === "ollama") && <ApiKeyField label={draft.kind === "api" ? "API key" : "API key (only if your server requires one)"} value={draft.apiKey} onChange={(apiKey) => setDraft({ ...draft, apiKey })} placeholder={draft.kind === "api" && draft.apiProvider ? keyPlaceholder[draft.apiProvider] : "Optional API key"} />}
						{(draft.kind === "ollama" || (draft.kind === "api" && showAdvanced)) && <label className="flex flex-col gap-1.5"><span className="font-mono text-[10px] font-semibold uppercase tracking-[0.07em] text-ink-muted">{draft.kind === "api" ? "API base URL" : "Server URL"}</span><input value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="http://localhost:11434" className={`font-mono ${fieldClass}`} /></label>}
						{draft.kind === "api" && <button type="button" onClick={() => setShowAdvanced((current) => !current)} className="self-start font-mono text-[10.5px] font-semibold text-accent">{showAdvanced ? "Hide advanced" : "Advanced · custom base URL"}</button>}
						<p className="text-[11px] leading-relaxed text-ink-faint">{draft.kind === "api" ? "The base URL is set from the provider · open Advanced to change it for a proxy or gateway." : draft.kind === "ollama" ? "Point at localhost or a remote machine. Any OpenAI-compatible server works." : `Uses your local ${CONNECTION_KINDS[draft.kind].name} sign-in · no URL or key needed.`}</p>
						<div className="mt-0.5 flex gap-2"><Button variant="primary" size="md" disabled={(draft.kind === "ollama" && !draft.baseUrl) || (draft.kind === "api" && !draft.apiKey.trim())} onClick={save}>Save connection</Button><Button variant="secondary" size="md" onClick={() => setDraft(null)}>Cancel</Button></div>
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
							<div className="flex flex-col gap-2.25"><label className="flex flex-col gap-1.25"><span className="font-mono text-[9px] font-semibold uppercase tracking-[0.07em] text-ink-muted">Connection</span><select value={connection?.id ?? ""} onChange={(event) => updateRoute(task.id, event.target.value)} className={`${fieldClass} cursor-pointer`}><option value="" disabled>Select a connection…</option>{connections.map((item) => <option key={item.id} value={item.id}>{item.name} · {kindNameFor(item)}</option>)}</select></label>
							{connection && <label className="flex flex-col gap-1.25"><span className="font-mono text-[9px] font-semibold uppercase tracking-[0.07em] text-ink-muted">Model</span><select value={route.model ?? ""} onChange={(event) => setRoutes((current) => ({ ...current, [task.id]: { ...route, model: event.target.value } }))} className={`cursor-pointer font-mono ${fieldClass}`}>{modelsFor(connection).map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label>}</div>
							<div className="mt-2.25 flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.04em]"><Dot kind={status.kind} /><span className={tones[status.kind].text}>{status.text}</span></div>
						</div>;
					})}<p className="px-0.5 text-[11px] font-medium text-ink-muted">{singleConnection ? "All tasks use the same connection." : "Mixed setup · each task uses a different connection."}</p></div>
				</section>
			</div>}
		</div>
	);
}

export default ProviderConfigPage;

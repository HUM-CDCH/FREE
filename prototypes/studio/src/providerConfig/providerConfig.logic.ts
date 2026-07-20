import type { PillProps } from "../ui";
import {
	API_PROVIDERS,
	CONNECTION_KINDS,
	type Connection,
	type ConnectionKind,
	type Draft,
	type RouteState,
	type TaskConfig,
} from "./providerConfig.data";

export type StatusKind = "ok" | "warn" | "err";
export type StatusInfo = { kind: StatusKind; text: string; deleted?: boolean };
export type RouteEntry = {
	task: TaskConfig;
	route: RouteState;
	status: StatusInfo;
};

export const STATUS_TONE: Record<
	StatusKind,
	{ pill: PillProps["tone"]; dot: string; text: string; border: string }
> = {
	ok: {
		pill: "success",
		dot: "bg-green",
		text: "text-green",
		border: "border-line",
	},
	warn: {
		pill: "stale",
		dot: "bg-stale",
		text: "text-stale-ink",
		border: "border-stale",
	},
	err: {
		pill: "danger",
		dot: "bg-danger",
		text: "text-danger",
		border: "border-danger/40",
	},
};

export function modelsFor(connection: Connection) {
	if (connection.kind === "api" && connection.apiProvider) {
		return API_PROVIDERS[connection.apiProvider].models;
	}
	return CONNECTION_KINDS[connection.kind].models ?? [];
}

export function kindNameFor(connection: Connection) {
	if (connection.kind === "api" && connection.apiProvider) {
		return API_PROVIDERS[connection.apiProvider].name;
	}
	return CONNECTION_KINDS[connection.kind].name;
}

export function connectionStatus(connection: Connection): StatusInfo {
	const config = CONNECTION_KINDS[connection.kind];
	if (config.shape === "cli") {
		return connection.reachable
			? { kind: "ok", text: "Detected" }
			: { kind: "err", text: "Not found" };
	}
	if (config.shape === "server") {
		if (!connection.baseUrl) return { kind: "err", text: "No URL" };
		if (!connection.reachable) return { kind: "err", text: "Unreachable" };
		return { kind: "ok", text: "Connected" };
	}
	return connection.apiKey
		? { kind: "ok", text: "Connected" }
		: { kind: "warn", text: "Key required" };
}

export function connectionFormState(draft: Draft, showAdvanced: boolean) {
	const config = CONNECTION_KINDS[draft.kind];
	const isApi = config.shape === "apikey";
	const isServer = config.shape === "server";

	return {
		showUrl: isServer || (isApi && showAdvanced),
		showKey: isApi || (isServer && config.keyOptional),
		canSave:
			config.shape === "cli" ||
			(isServer
				? Boolean(draft.baseUrl)
				: Boolean(draft.apiProvider && draft.apiKey)),
		note:
			config.shape === "cli"
				? `Uses your local ${config.name} sign-in — no URL or key needed.`
				: isServer
					? "Point at localhost or a remote machine. Any OpenAI-compatible server works."
					: "The base URL is set from the provider — open Advanced to change it for a proxy or gateway.",
	};
}

export function routeStatus(
	route: RouteState,
	connections: Connection[],
): StatusInfo {
	if (!route.connectionId) {
		return { kind: "err", text: "Select a connection" };
	}
	const connection =
		connections.find((item) => item.id === route.connectionId) ?? null;
	if (!connection) {
		return {
			kind: "err",
			text: "Connection removed — pick another",
			deleted: true,
		};
	}
	const status = connectionStatus(connection);
	const modelAvailable = modelsFor(connection).some(
		(model) => model.id === route.model,
	);
	if (status.kind === "ok" && !modelAvailable) {
		return { kind: "warn", text: "Model unavailable" };
	}
	return {
		kind: status.kind,
		text: status.kind === "ok" ? "Ready" : status.text,
	};
}

export function routingSummary(routeEntries: RouteEntry[]) {
	const allValid = routeEntries.every((entry) => entry.status.kind === "ok");
	const anyError = routeEntries.some((entry) => entry.status.kind === "err");
	const connectedIds = new Set(
		routeEntries
			.map((entry) => entry.route.connectionId)
			.filter((id): id is string => Boolean(id)),
	);
	const singleConnection = connectedIds.size === 1;
	let overallStatus: StatusKind = "warn";
	if (allValid) {
		overallStatus = "ok";
	} else if (anyError) {
		overallStatus = "err";
	}
	let chipText = "Needs attention";
	if (allValid) {
		chipText = singleConnection ? "Single provider · ready" : "Mixed · ready";
	}
	let mixText = "Mixed setup — each task uses a different connection.";
	if (singleConnection) {
		mixText = "All tasks use the same connection.";
	} else if (connectedIds.size === 0) {
		mixText = "Mixed setup — no connections assigned.";
	}

	return { overallStatus, chipText, mixText };
}

export function defaultDraftFor(kind: ConnectionKind): Draft {
	const config = CONNECTION_KINDS[kind];
	if (kind === "api") {
		const provider = API_PROVIDERS.openai;
		return {
			kind,
			apiProvider: "openai",
			name: provider.name,
			baseUrl: provider.defaultUrl,
			apiKey: "",
		};
	}
	return {
		kind,
		name: config.name,
		baseUrl: config.defaultUrl ?? "",
		apiKey: "",
	};
}

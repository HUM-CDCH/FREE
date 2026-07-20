import { useState } from "react";
import {
	API_PROVIDERS,
	CONNECTION_KINDS,
	INITIAL_CONNECTIONS,
} from "../providerConfig.data";
import type {
	ApiProviderKey,
	Connection,
	ConnectionKind,
	Draft,
} from "../providerConfig.data";
import { defaultDraftFor } from "../providerConfig.logic";

function useConnections() {
	const [connections, setConnections] =
		useState<Connection[]>(INITIAL_CONNECTIONS);
	const [creating, setCreating] = useState(false);
	const [pickedKind, setPickedKind] = useState<ConnectionKind | null>(null);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [nextId, setNextId] = useState(3);

	function startCreate() {
		setCreating(true);
		setPickedKind(null);
		setDraft(null);
		setShowAdvanced(false);
	}

	function cancelCreate() {
		setCreating(false);
		setPickedKind(null);
		setDraft(null);
	}

	function pickKind(kind: ConnectionKind) {
		setPickedKind(kind);
		setShowAdvanced(false);
		setDraft(defaultDraftFor(kind));
	}

	function changeApiProvider(key: ApiProviderKey) {
		const provider = API_PROVIDERS[key];
		setDraft((current) =>
			current
				? {
						...current,
						apiProvider: key,
						name: provider.name,
						baseUrl: provider.defaultUrl,
					}
				: current,
		);
	}

	function changeDraftName(name: string) {
		setDraft((current) => (current ? { ...current, name } : current));
	}

	function changeDraftBaseUrl(baseUrl: string) {
		setDraft((current) => (current ? { ...current, baseUrl } : current));
	}

	function changeDraftApiKey(apiKey: string) {
		setDraft((current) => (current ? { ...current, apiKey } : current));
	}

	function saveConnection() {
		if (!draft) return;
		const connection: Connection = {
			id: `c${nextId}`,
			kind: draft.kind,
			apiProvider: draft.apiProvider,
			name: draft.name || CONNECTION_KINDS[draft.kind].name,
			baseUrl: draft.baseUrl,
			apiKey: draft.apiKey,
			reachable: true,
		};
		setConnections((current) => [...current, connection]);
		setNextId((current) => current + 1);
		cancelCreate();
	}

	function deleteConnection(id: string) {
		setConnections((current) =>
			current.filter((connection) => connection.id !== id),
		);
	}

	return {
		connections,
		creating,
		pickedKind,
		draft,
		showAdvanced,
		startCreate,
		cancelCreate,
		pickKind,
		changeApiProvider,
		changeDraftName,
		changeDraftBaseUrl,
		changeDraftApiKey,
		toggleAdvanced: () => setShowAdvanced((current) => !current),
		saveConnection,
		deleteConnection,
	};
}

export default useConnections;

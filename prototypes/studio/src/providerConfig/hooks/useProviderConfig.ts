import useConnections from "./useConnections";
import useTaskRouting from "./useTaskRouting";

function useProviderConfig() {
	const connectionState = useConnections();
	const routingState = useTaskRouting(connectionState.connections);

	function deleteConnection(id: string) {
		connectionState.deleteConnection(id);
		routingState.removeConnection(id);
	}

	return {
		header: { status: routingState.overallStatus, text: routingState.chipText },
		connectionsPanel: {
			connections: connectionState.connections,
			creating: connectionState.creating,
			pickedKind: connectionState.pickedKind,
			draft: connectionState.draft,
			showAdvanced: connectionState.showAdvanced,
			onStartCreate: connectionState.startCreate,
			onCancelCreate: connectionState.cancelCreate,
			onPickKind: connectionState.pickKind,
			onApiProviderChange: connectionState.changeApiProvider,
			onNameChange: connectionState.changeDraftName,
			onBaseUrlChange: connectionState.changeDraftBaseUrl,
			onApiKeyChange: connectionState.changeDraftApiKey,
			onToggleAdvanced: connectionState.toggleAdvanced,
			onSave: connectionState.saveConnection,
			onDelete: deleteConnection,
		},
		taskRoutingPanel: {
			routeEntries: routingState.routeEntries,
			connections: connectionState.connections,
			mixText: routingState.mixText,
			onConnectionChange: routingState.changeConnection,
			onModelChange: routingState.changeModel,
		},
	};
}

export default useProviderConfig;

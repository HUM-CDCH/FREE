import ConnectionsPanel from "./components/ConnectionsPanel";
import ProviderConfigHeader from "./components/ProviderConfigHeader";
import TaskRoutingPanel from "./components/TaskRoutingPanel";
import useProviderConfig from "./hooks/useProviderConfig";

function ProviderConfigPage() {
	const { header, connectionsPanel, taskRoutingPanel } = useProviderConfig();

	return (
		<div className="mx-auto max-w-4xl overflow-hidden rounded-2xl border border-line bg-surface-muted shadow-page">
			<ProviderConfigHeader {...header} />
			<div className="grid grid-cols-[1.08fr_1fr]">
				<ConnectionsPanel {...connectionsPanel} />
				<TaskRoutingPanel {...taskRoutingPanel} />
			</div>
		</div>
	);
}

export default ProviderConfigPage;

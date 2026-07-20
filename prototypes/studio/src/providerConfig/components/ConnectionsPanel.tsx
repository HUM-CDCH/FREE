import { Button, EmptyState, Overline } from "../../ui";
import type {
	ApiProviderKey,
	Connection,
	ConnectionKind,
	Draft,
} from "../providerConfig.data";
import ConnectionCard from "./ConnectionCard";
import ConnectionForm from "./ConnectionForm";
import ConnectionTypePicker from "./ConnectionTypePicker";

export type ConnectionsPanelProps = {
	connections: Connection[];
	creating: boolean;
	pickedKind: ConnectionKind | null;
	draft: Draft | null;
	showAdvanced: boolean;
	onStartCreate: () => void;
	onCancelCreate: () => void;
	onPickKind: (kind: ConnectionKind) => void;
	onApiProviderChange: (key: ApiProviderKey) => void;
	onNameChange: (value: string) => void;
	onBaseUrlChange: (value: string) => void;
	onApiKeyChange: (value: string) => void;
	onToggleAdvanced: () => void;
	onSave: () => void;
	onDelete: (id: string) => void;
};

function ConnectionsPanel({
	connections,
	creating,
	pickedKind,
	draft,
	showAdvanced,
	onStartCreate,
	onCancelCreate,
	onPickKind,
	onApiProviderChange,
	onNameChange,
	onBaseUrlChange,
	onApiKeyChange,
	onToggleAdvanced,
	onSave,
	onDelete,
}: ConnectionsPanelProps) {
	return (
		<div className="min-h-90 border-r border-line p-4.5">
			<div className="mb-3.25 flex items-center justify-between">
				<Overline>Your connections</Overline>
				{!creating && (
					<Button variant="primary" size="sm" onClick={onStartCreate}>
						+ New connection
					</Button>
				)}
			</div>

			{!creating && (
				<div className="flex flex-col gap-2.25">
					{connections.map((connection) => (
						<ConnectionCard
							key={connection.id}
							connection={connection}
							onDelete={onDelete}
						/>
					))}
					{connections.length === 0 && (
						<EmptyState
							title="No connections yet."
							description="Add one to route your tasks."
						/>
					)}
				</div>
			)}

			{creating && !pickedKind && (
				<ConnectionTypePicker onPick={onPickKind} onCancel={onCancelCreate} />
			)}

			{creating && pickedKind && draft && (
				<ConnectionForm
					draft={draft}
					showAdvanced={showAdvanced}
					onApiProviderChange={onApiProviderChange}
					onNameChange={onNameChange}
					onBaseUrlChange={onBaseUrlChange}
					onApiKeyChange={onApiKeyChange}
					onToggleAdvanced={onToggleAdvanced}
					onSave={onSave}
					onCancel={onCancelCreate}
				/>
			)}
		</div>
	);
}

export default ConnectionsPanel;

import { Button } from "../../ui";
import { API_PROVIDERS, CONNECTION_KINDS } from "../providerConfig.data";
import type { ApiProviderKey, Draft } from "../providerConfig.data";
import { connectionFormState } from "../providerConfig.logic";
import { inputClass, selectClass } from "../providerConfig.styles";
import FormField from "./FormField";

type ConnectionFormProps = {
	draft: Draft;
	showAdvanced: boolean;
	onApiProviderChange: (key: ApiProviderKey) => void;
	onNameChange: (value: string) => void;
	onBaseUrlChange: (value: string) => void;
	onApiKeyChange: (value: string) => void;
	onToggleAdvanced: () => void;
	onSave: () => void;
	onCancel: () => void;
};

function ConnectionForm({
	draft,
	showAdvanced,
	onApiProviderChange,
	onNameChange,
	onBaseUrlChange,
	onApiKeyChange,
	onToggleAdvanced,
	onSave,
	onCancel,
}: ConnectionFormProps) {
	const config = CONNECTION_KINDS[draft.kind];
	const isApi = draft.kind === "api";
	const { showUrl, showKey, canSave, note } = connectionFormState(
		draft,
		showAdvanced,
	);
	const connectionName =
		isApi && draft.apiProvider
			? API_PROVIDERS[draft.apiProvider].name
			: config.name;

	return (
		<div className="flex flex-col gap-3">
			<p className="text-[13px] font-semibold text-ink">
				New {connectionName} connection
			</p>

			{isApi && (
				<FormField label="Provider">
					<select
						value={draft.apiProvider}
						onChange={(event) =>
							onApiProviderChange(event.target.value as ApiProviderKey)
						}
						className={selectClass}
					>
						{(
							Object.entries(API_PROVIDERS) as [
								ApiProviderKey,
								(typeof API_PROVIDERS)[ApiProviderKey],
							][]
						).map(([key, provider]) => (
							<option key={key} value={key}>
								{provider.name}
							</option>
						))}
					</select>
				</FormField>
			)}

			<FormField label="Display name">
				<input
					value={draft.name}
					onChange={(event) => onNameChange(event.target.value)}
					placeholder="e.g. Lab GPU box"
					className={inputClass}
				/>
			</FormField>

			{showKey && (
				<FormField
					label={
						isApi ? "API key" : "API key (only if your server requires one)"
					}
				>
					<input
						type="password"
						value={draft.apiKey}
						onChange={(event) => onApiKeyChange(event.target.value)}
						placeholder="sk-…"
						className={`font-mono ${inputClass}`}
					/>
				</FormField>
			)}

			{showUrl && (
				<FormField label={config.endpointLabel ?? "Endpoint"}>
					<input
						value={draft.baseUrl}
						onChange={(event) => onBaseUrlChange(event.target.value)}
						placeholder="http://localhost:11434"
						className={`font-mono ${inputClass}`}
					/>
				</FormField>
			)}

			{isApi && (
				<button
					type="button"
					onClick={onToggleAdvanced}
					className="self-start cursor-pointer font-mono text-[10.5px] font-semibold text-accent outline-none"
				>
					{showAdvanced ? "Hide advanced" : "Advanced · custom base URL"}
				</button>
			)}

			<p className="text-[11px] leading-relaxed text-ink-faint">{note}</p>

			<div className="mt-0.5 flex gap-2">
				<Button
					variant="primary"
					size="md"
					disabled={!canSave}
					onClick={onSave}
				>
					Save connection
				</Button>
				<Button variant="secondary" size="md" onClick={onCancel}>
					Cancel
				</Button>
			</div>
		</div>
	);
}

export default ConnectionForm;

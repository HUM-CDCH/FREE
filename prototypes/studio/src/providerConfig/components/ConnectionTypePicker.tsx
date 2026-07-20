import { CONNECTION_KINDS, type ConnectionKind } from "../providerConfig.data";

type ConnectionTypePickerProps = {
	onPick: (kind: ConnectionKind) => void;
	onCancel: () => void;
};

function ConnectionTypePicker({ onPick, onCancel }: ConnectionTypePickerProps) {
	return (
		<div>
			<div className="mb-2.75 flex items-center justify-between">
				<span className="text-xs text-ink-muted">Choose a connection type</span>
				<button
					type="button"
					onClick={onCancel}
					className="cursor-pointer text-[11px] font-semibold text-ink-muted outline-none hover:text-ink"
				>
					Cancel
				</button>
			</div>
			<div className="grid grid-cols-2 gap-2">
				{(
					Object.entries(CONNECTION_KINDS) as [
						ConnectionKind,
						(typeof CONNECTION_KINDS)[ConnectionKind],
					][]
				).map(([kind, config]) => (
					<button
						key={kind}
						type="button"
						onClick={() => onPick(kind)}
						className="flex flex-col items-start gap-0.5 rounded-lg border border-line-strong bg-surface p-2.75 text-left outline-none transition-colors hover:border-accent/50 focus-visible:border-accent"
					>
						<span className="text-xs font-semibold text-ink">
							{config.name}
						</span>
						<span className="text-[10px] text-ink-faint">{config.tagline}</span>
					</button>
				))}
			</div>
		</div>
	);
}

export default ConnectionTypePicker;

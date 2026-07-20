import { Pill } from "../../ui";
import type { Connection } from "../providerConfig.data";
import { CONNECTION_KINDS } from "../providerConfig.data";
import {
	connectionStatus,
	kindNameFor,
	modelsFor,
	STATUS_TONE,
} from "../providerConfig.logic";
import StatusDot from "./StatusDot";

type ConnectionCardProps = {
	connection: Connection;
	onDelete: (id: string) => void;
};

function ConnectionCard({ connection, onDelete }: ConnectionCardProps) {
	const status = connectionStatus(connection);
	const tone = STATUS_TONE[status.kind];
	const config = CONNECTION_KINDS[connection.kind];

	return (
		<div className={`rounded-xl border bg-surface p-3 ${tone.border}`}>
			<div className="flex items-center justify-between gap-2">
				<span className="min-w-0 truncate text-[12.5px] font-semibold text-ink">
					{connection.name}
				</span>
				<div className="flex shrink-0 items-center gap-1.5">
					<Pill tone={tone.pill} className="gap-1">
						<StatusDot kind={status.kind} />
						{status.text}
					</Pill>
					<button
						type="button"
						title="Delete connection"
						onClick={() => onDelete(connection.id)}
						className="grid size-5.5 shrink-0 cursor-pointer place-items-center rounded-md border border-line text-sm leading-none text-ink-faint outline-none transition-colors hover:border-danger/40 hover:text-danger"
					>
						×
					</button>
				</div>
			</div>
			<p className="mt-1 truncate font-mono text-[11px] text-ink-faint">
				{config.shape === "cli"
					? "Local agent harness"
					: connection.baseUrl || "—"}
			</p>
			<p className="mt-0.5 text-[10.5px] text-ink-faint">
				{kindNameFor(connection)} · {modelsFor(connection).length} models
			</p>
		</div>
	);
}

export default ConnectionCard;

import type { Connection, TaskId } from "../providerConfig.data";
import {
	kindNameFor,
	modelsFor,
	STATUS_TONE,
	type RouteEntry,
} from "../providerConfig.logic";
import { selectClass } from "../providerConfig.styles";
import StatusDot from "./StatusDot";

type RouteCardProps = {
	entry: RouteEntry;
	connections: Connection[];
	onConnectionChange: (taskId: TaskId, connectionId: string) => void;
	onModelChange: (taskId: TaskId, model: string) => void;
};

function RouteCard({
	entry,
	connections,
	onConnectionChange,
	onModelChange,
}: RouteCardProps) {
	const { task, route, status } = entry;
	const connection =
		connections.find((item) => item.id === route.connectionId) ?? null;
	const models = connection ? modelsFor(connection) : [];
	const tone = STATUS_TONE[status.kind];

	return (
		<div className="rounded-xl border border-line bg-surface p-3.5">
			<p className="text-[12.5px] font-semibold text-ink">{task.label}</p>
			<p className="mb-2.75 text-[10.5px] text-ink-faint">{task.sub}</p>
			<div className="flex flex-col gap-2">
				<select
					value={route.connectionId ?? ""}
					onChange={(event) => onConnectionChange(task.id, event.target.value)}
					className={selectClass}
				>
					<option value="">Select a connection…</option>
					{connections.map((item) => (
						<option key={item.id} value={item.id}>
							{item.name} · {kindNameFor(item)}
						</option>
					))}
				</select>
				{!status.deleted && (
					<select
						value={route.model ?? ""}
						onChange={(event) => onModelChange(task.id, event.target.value)}
						className={`font-mono ${selectClass}`}
					>
						{models.map((model) => (
							<option key={model.id} value={model.id}>
								{model.label}
							</option>
						))}
					</select>
				)}
			</div>
			<div className="mt-2.25 flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.04em]">
				<StatusDot kind={status.kind} />
				<span className={tone.text}>{status.text}</span>
			</div>
		</div>
	);
}

export default RouteCard;

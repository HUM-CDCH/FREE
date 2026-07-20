import { Overline } from "../../ui";
import type { Connection, TaskId } from "../providerConfig.data";
import type { RouteEntry } from "../providerConfig.logic";
import RouteCard from "./RouteCard";

export type TaskRoutingPanelProps = {
	routeEntries: RouteEntry[];
	connections: Connection[];
	mixText: string;
	onConnectionChange: (taskId: TaskId, connectionId: string) => void;
	onModelChange: (taskId: TaskId, model: string) => void;
};

function TaskRoutingPanel({
	routeEntries,
	connections,
	mixText,
	onConnectionChange,
	onModelChange,
}: TaskRoutingPanelProps) {
	return (
		<div className="p-4.5">
			<Overline as="p" className="mb-3.25">
				Task routing
			</Overline>
			<div className="flex flex-col gap-3.25">
				{routeEntries.map((entry) => (
					<RouteCard
						key={entry.task.id}
						entry={entry}
						connections={connections}
						onConnectionChange={onConnectionChange}
						onModelChange={onModelChange}
					/>
				))}
				<p className="px-0.5 text-[11px] font-medium text-ink-muted">
					{mixText}
				</p>
			</div>
		</div>
	);
}

export default TaskRoutingPanel;

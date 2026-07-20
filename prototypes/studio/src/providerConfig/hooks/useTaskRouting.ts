import { useState } from "react";
import { INITIAL_ROUTES, ROUTABLE_TASKS } from "../providerConfig.data";
import type { Connection, RouteState, TaskId } from "../providerConfig.data";
import {
	modelsFor,
	routeStatus,
	type RouteEntry,
	type StatusKind,
} from "../providerConfig.logic";

function useTaskRouting(connections: Connection[]) {
	const [routes, setRoutes] =
		useState<Record<TaskId, RouteState>>(INITIAL_ROUTES);

	function removeConnection(id: string) {
		setRoutes((current) => {
			const next = { ...current };
			for (const task of ROUTABLE_TASKS) {
				if (next[task.id].connectionId === id) {
					next[task.id] = { connectionId: null, model: null };
				}
			}
			return next;
		});
	}

	function changeConnection(taskId: TaskId, connectionId: string) {
		const connection =
			connections.find((item) => item.id === connectionId) ?? null;
		const model = connection ? (modelsFor(connection)[0]?.id ?? null) : null;
		setRoutes((current) => ({ ...current, [taskId]: { connectionId, model } }));
	}

	function changeModel(taskId: TaskId, model: string) {
		setRoutes((current) => ({
			...current,
			[taskId]: { ...current[taskId], model },
		}));
	}

	const routeEntries: RouteEntry[] = ROUTABLE_TASKS.map((task) => ({
		task,
		route: routes[task.id],
		status: routeStatus(routes[task.id], connections),
	}));
	const allValid = routeEntries.every((entry) => entry.status.kind === "ok");
	const anyError = routeEntries.some((entry) => entry.status.kind === "err");
	const connectedIds = new Set(
		routeEntries
			.map((entry) => entry.route.connectionId)
			.filter((id): id is string => Boolean(id)),
	);
	const singleConnection = connectedIds.size === 1;
	const overallStatus: StatusKind = allValid ? "ok" : anyError ? "err" : "warn";
	const chipText = allValid
		? singleConnection
			? "Single provider · ready"
			: "Mixed · ready"
		: "Needs attention";
	const mixText = singleConnection
		? "All tasks use the same connection."
		: "Mixed setup — each task uses a different connection.";

	return {
		routeEntries,
		overallStatus,
		chipText,
		mixText,
		removeConnection,
		changeConnection,
		changeModel,
	};
}

export default useTaskRouting;

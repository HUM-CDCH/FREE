import { useState } from "react";
import { INITIAL_ROUTES, ROUTABLE_TASKS } from "../providerConfig.data";
import type { Connection, RouteState, TaskId } from "../providerConfig.data";
import {
	modelsFor,
	routeStatus,
	routingSummary,
	type RouteEntry,
} from "../providerConfig.logic";

function useTaskRouting(connections: Connection[]) {
	const [routes, setRoutes] =
		useState<Record<TaskId, RouteState>>(INITIAL_ROUTES);

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
	const summary = routingSummary(routeEntries);

	return {
		routeEntries,
		...summary,
		changeConnection,
		changeModel,
	};
}

export default useTaskRouting;

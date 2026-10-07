/** In-memory registry of Parsing Service task ids currently in flight for a
 * Project Context. A Source Document upload only becomes a persisted
 * SourceDocument row once parsing completes, so there is nothing in the
 * database to look up if a project is deleted mid-parse — this module-level
 * singleton is what lets project deletion find and cancel those tasks. */
const tasksByProject = new Map<string, Set<string>>()

export function trackParsingTask(
  projectContextId: string,
  taskId: string,
): () => void {
  let tasks = tasksByProject.get(projectContextId)
  if (!tasks) {
    tasks = new Set()
    tasksByProject.set(projectContextId, tasks)
  }
  tasks.add(taskId)
  return () => {
    tasks!.delete(taskId)
    if (tasks!.size === 0) tasksByProject.delete(projectContextId)
  }
}

export function takeActiveParsingTasks(projectContextId: string): string[] {
  const tasks = tasksByProject.get(projectContextId)
  tasksByProject.delete(projectContextId)
  return tasks ? [...tasks] : []
}

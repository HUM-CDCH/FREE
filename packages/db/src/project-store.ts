import { db } from './prisma/db.js'

type Database = Pick<typeof db, 'orm'>

export type ProjectContextSummary = {
  projectContextId: string
  name: string
  createdAt: Date
}

/** Read-only seam for the Project Context chooser; writes and reopening stay out of it. */
export type ProjectStore = {
  listProjectContexts(limit: number): Promise<ProjectContextSummary[]>
  getProjectContextWithDocuments(projectContextId: string): Promise<{
    projectContext: ProjectContextSummary
    sourceDocuments: Array<{
      sourceDocumentId: string
      name: string
      createdAt: Date
    }>
  } | null>
}

export function createProjectStore(database: Database = db): ProjectStore {
  return {
    async listProjectContexts(limit) {
      const rows = await database.orm.public.ProjectContext.select(
        'id',
        'name',
        'createdAt',
      )
        .orderBy([
          (project) => project.createdAt.desc(),
          (project) => project.id.desc(),
        ])
        .take(limit)
        .all()
      return rows.map(({ id, name, createdAt }) => ({
        projectContextId: id,
        name,
        createdAt,
      }))
    },
    async getProjectContextWithDocuments(projectContextId) {
      const row = await database.orm.public.ProjectContext.select(
        'id',
        'name',
        'createdAt',
      ).first({ id: projectContextId })
      if (!row) return null
      const sourceDocuments = await database.orm.public.SourceDocument.where({
        projectContextId,
      })
        .select('id', 'originalName', 'createdAt')
        .orderBy([
          (document) => document.createdAt.asc(),
          (document) => document.id.asc(),
        ])
        .all()
      return {
        projectContext: {
          projectContextId: row.id,
          name: row.name,
          createdAt: row.createdAt,
        },
        sourceDocuments: sourceDocuments.map(
          ({ id, originalName, createdAt }) => ({
            sourceDocumentId: id,
            name: originalName ?? 'Untitled source document',
            createdAt,
          }),
        ),
      }
    },
  }
}

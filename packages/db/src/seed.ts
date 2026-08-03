import 'dotenv/config'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from './prisma/db.js'

const examplesDirectory = fileURLToPath(new URL('../../../examples/', import.meta.url))

export const exampleProjects = [
  {
    projectContextId: '51000000-0000-4000-8000-000000000001',
    name: 'Ellekilde, TAK 1355',
    documents: [
      {
        sourceDocumentId: '51000000-0000-4000-8001-000000000001',
        filename: 'Beretning_Ellekilde_8_13.pdf',
      },
    ],
  },
  {
    projectContextId: '51000000-0000-4000-8000-000000000002',
    name: 'Test documents',
    documents: [
      {
        sourceDocumentId: '51000000-0000-4000-8001-000000000002',
        filename: '1790-06-17-1.pdf',
      },
      {
        sourceDocumentId: '51000000-0000-4000-8001-000000000003',
        filename:
          'Zhang et al. 2024 - Properties of skin collagen from southern catfish (Silurus meridionalis) fed with raw and cooked food.pdf',
      },
    ],
  },
] as const

type SeedDatabase = Pick<typeof db, 'orm'>

export async function seedExampleProjects(database: SeedDatabase = db) {
  let projectsCreated = 0
  let documentsCreated = 0

  for (const project of exampleProjects) {
    const existingProject = await database.orm.public.ProjectContext.first({
      id: project.projectContextId,
    })
    if (!existingProject) {
      await database.orm.public.ProjectContext.create({
        id: project.projectContextId,
        name: project.name,
      })
      projectsCreated += 1
    }

    for (const document of project.documents) {
      const existingDocument = await database.orm.public.SourceDocument.first({
        id: document.sourceDocumentId,
      })
      if (existingDocument) continue

      const pdf = await readFile(resolve(examplesDirectory, document.filename))
      await database.orm.public.SourceDocument.create({
        id: document.sourceDocumentId,
        projectContextId: project.projectContextId,
        contentSha256: createHash('sha256').update(pdf).digest('hex'),
        mediaType: 'application/pdf',
        originalName: basename(document.filename),
      })
      documentsCreated += 1
    }
  }

  return { projectsCreated, documentsCreated }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const result = await seedExampleProjects()
    console.log(
      `Seeded example PDFs: ${result.projectsCreated} projects and ${result.documentsCreated} Source Documents created.`,
    )
  } finally {
    await db.close()
  }
}

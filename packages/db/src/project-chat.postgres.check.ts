import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import { validateDisposableTestDatabaseTarget } from './database-url.js'

/**
 * A Project Context's chat: its order under concurrent appends, a repeated append, ownership and the Project Context
 * cascade are PostgreSQL behaviour, so only PostgreSQL can prove them. The check makes its own accounts, so it needs no
 * empty database, and deletes them when it ends.
 */
const databaseUrl = process.env.PROJECT_STORE_POSTGRES_URL

test('PostgreSQL keeps a Project Context chat in order, once, for its owner, and cascades it', async () => {
  if (!databaseUrl)
    throw new Error(
      'Set PROJECT_STORE_POSTGRES_URL to a disposable free_test_* database, for example: pnpm --filter db db:start && createdb free_test_project_chat.',
    )
  validateDisposableTestDatabaseTarget(databaseUrl)
  process.env.DATABASE_URL = databaseUrl

  const [{ db, pool }, { createResearcherProjectStore }] = await Promise.all([
    import('./prisma/db.js'),
    import('./project-store.js'),
  ])
  const accountIds: string[] = []
  after(async () => {
    try {
      for (const id of accountIds) await db.orm.public.ResearcherAccount.where({ id }).delete()
    } finally {
      await db.close()
      await pool.end()
    }
  })

  const account = async (displayName: string) => {
    const created = await db.orm.public.ResearcherAccount.create({ tenantId: randomUUID(), objectId: randomUUID(), displayName })
    accountIds.push(created.id)
    return createResearcherProjectStore(created.id, db)
  }
  const store = await account('Chat owner')
  const stranger = await account('Chat stranger')
  const { projectContextId } = await store.createProjectContext('Chat')
  const message = (text: string) => ({ projectChatEntryId: randomUUID(), entry: { kind: 'message', role: 'user', text } })

  const first = message('first')
  const appended = await store.appendProjectChatEntries(projectContextId, [first, message('second')])
  assert.deepEqual(appended?.map(({ position }) => position), [1, 2])
  // A repeated request adds nothing twice.
  assert.deepEqual(await store.appendProjectChatEntries(projectContextId, [first]), [])

  // Two tabs appending at once both land, each at its own position.
  await Promise.all(Array.from({ length: 6 }, (_, index) => store.appendProjectChatEntries(projectContextId, [message(`tab ${index}`)])))
  const all = await store.listProjectChatEntries(projectContextId, 100)
  assert.deepEqual(all?.map(({ position }) => position), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(new Set(all?.map(({ entry }) => (entry as { text: string }).text)).size, 8)

  // The latest entries, oldest first.
  assert.deepEqual((await store.listProjectChatEntries(projectContextId, 2))?.map(({ position }) => position), [7, 8])

  assert.equal(await store.deleteProjectChatEntry(projectContextId, first.projectChatEntryId), true)
  assert.equal(await store.deleteProjectChatEntry(projectContextId, first.projectChatEntryId), false)
  assert.equal((await store.listProjectChatEntries(projectContextId, 100))?.[0]?.position, 2)

  // Another account's chat is not there for it.
  assert.equal(await stranger.listProjectChatEntries(projectContextId, 100), null)
  assert.equal(await stranger.appendProjectChatEntries(projectContextId, [message('intruder')]), null)
  assert.equal(await stranger.deleteProjectChatEntry(projectContextId, all![1]!.projectChatEntryId), null)

  assert.notEqual(await store.deleteProjectContext(projectContextId), null)
  assert.deepEqual(await db.orm.public.ProjectChatEntry.where({ projectContextId }).select('id').all(), [])
})

import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
const root = process.env.FREE_RISK_ROOT!;
const requireDb = createRequire(root + '/packages/db/package.json');
const {Client} = requireDb('pg');
const {default: postgres} = await import(requireDb.resolve('@prisma-next/postgres/runtime'));
const contractJson = JSON.parse(readFileSync(root + '/packages/db/src/prisma/contract.json', 'utf8'));
const {validateDisposableTestDatabaseTarget} = await import(root + '/packages/db/src/database-url.ts');
validateDisposableTestDatabaseTarget(process.env.DATABASE_URL!);
const {db} = await import(root + '/packages/db/src/prisma/db.ts');
const {createResearcherProjectStore} = await import(root + '/packages/db/src/project-store.ts');
const {createInternalExtractionJobStore} = await import(root + '/packages/extraction/src/postgres-persistence.ts');
const account = await db.orm.public.ResearcherAccount.create({tenantId: randomUUID(), objectId: randomUUID(), displayName: 'Plan probe'});
const store = createResearcherProjectStore(account.id, db);
const clients = [new Client({connectionString: process.env.DATABASE_URL}), new Client({connectionString: process.env.DATABASE_URL})];
await Promise.all(clients.map(client => client.connect()));
const facades = clients.map(client => postgres({contractJson, pg: client}));
const report = (probe: string, result: unknown) => console.log(JSON.stringify({probe, result}));

try {
  // 1a: Run the real initializer, pausing only after both real SELECTs saw no schema.
  const project = await store.createProjectContext('Concurrent first generation');
  const gate = Promise.withResolvers<void>();
  let arrivals = 0;
  const originals = clients.map(client => client.query.bind(client));
  const timer = setTimeout(() => gate.reject(new Error('Both initializer reads did not arrive')), 5000);
  clients.forEach((client, index) => {
    client.query = async (...args: any[]) => {
      const result = await originals[index](...args);
      const sql = typeof args[0] === 'string' ? args[0] : args[0].text;
      if (/^select/i.test(sql.trim()) && /"extractionSchema"/.test(sql) && result.rows.length === 0) {
        if (++arrivals === 2) gate.resolve();
        await gate.promise;
      }
      return result;
    };
  });
  const definition = {recordDescription: 'One record.', schemaNodes: [{id: 'field', name: 'site', type: 'string'}]};
  const concurrent = await Promise.all(facades.map(facade => createResearcherProjectStore(account.id, facade).initializeSchemaRevision(project.projectContextId, definition)));
  clearTimeout(timer);
  clients.forEach((client, index) => { client.query = originals[index]; });
  const count = await clients[0].query('select count(*)::int as n from "extractionSchema" where "projectContextId"=$1', [project.projectContextId]);
  assert.equal(count.rows[0].n, 2);
  report('1a-first-generation-current', {statuses: concurrent.map(x => x.status), schemas: count.rows[0].n});

  // Candidate fix: one existing project-row lock, no browser coordination.
  const lockedProject = await store.createProjectContext('Locked first generation');
  const locked = facades.map((facade, index) => ({
    orm: facade.orm,
    transaction: (callback: any) => facade.transaction(async (tx: any) => {
      await clients[index].query('select id from "projectContext" where id=$1 for update', [lockedProject.projectContextId]);
      return callback(tx);
    }),
  }));
  const protectedResults = await Promise.all(locked.map(facade => createResearcherProjectStore(account.id, facade).initializeSchemaRevision(lockedProject.projectContextId, definition)));
  assert.deepEqual(protectedResults.map(x => x.status).sort(), ['conflict', 'created']);
  report('1a-first-generation-row-lock', {statuses: protectedResults.map(x => x.status).sort()});

  // 1b: Real editor + save coordinator, with a simple persistence observation port.
  const {createSchemaEditorController, durableSchemaPersistence} = await import(root + '/prototypes/studio/src/currentSchemaRevision.ts');
  const revision = (n: number, value: any) => ({...value, extractionSchemaId: 'schema', schemaRevisionId: `revision-${n}`, revisionNumber: n, origin: 'researcher-edit', createdAt: new Date().toISOString()});
  const writes: any[] = [];
  const persistence = durableSchemaPersistence({
    initial: revision(1, definition), debounceMs: 60_000,
    append: async (_id: string, expected: number, value: any) => { writes.push({expected, description: value.recordDescription}); return revision(expected + 1, value); },
    initialize: async () => { throw new Error('Unexpected initialization'); },
    listRevisions: async () => [], getRevision: async () => revision(1, definition),
  });
  const editor = createSchemaEditorController(persistence, {initialDraft: definition});
  const model = Promise.withResolvers<unknown>();
  const pending = editor.generate(() => model.promise);
  editor.setRecordDescription('Researcher edit while generation runs.');
  await editor.flush();
  model.resolve({_description: 'Late model replacement.', site: 'string'});
  await pending;
  assert.deepEqual(writes.map(x => x.expected), [1, 2]);
  assert.equal(editor.snapshot().draft?.recordDescription, 'Late model replacement.');
  report('1b-live-generation', {writes, finalRevision: editor.snapshot().currentRevisionNumber});
  editor.dispose(); persistence.dispose();

  // 3: Simulate only M2's removal, then call the unchanged real job reader.
  const worker = createInternalExtractionJobStore(db);
  assert.equal(await worker.readExtractionAttempt(randomUUID()), null);
  await clients[0].query('alter table "extractionJob" rename to "risk_probe_removed_job"');
  try {
    await assert.rejects(worker.readExtractionAttempt(randomUUID()), (error: any) => {
      report('3-m2-before-m4', {sqlState: error.sqlState ?? error.code});
      return (error.sqlState ?? error.code) === '42P01';
    });
  } finally {
    await clients[0].query('alter table "risk_probe_removed_job" rename to "extractionJob"');
  }
  assert.equal(await worker.readExtractionAttempt(randomUUID()), null);
} finally {
  await Promise.all(facades.map(facade => facade.close()));
  await Promise.all(clients.map(client => client.end()));
  await db.close();
}

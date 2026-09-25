// Protocol probes for planned code that does not exist yet. No DBOS runtime claim.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {cp, mkdir, readFile, rm, stat, utimes, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const root = process.env.FREE_RISK_ROOT!;
const scratch = process.env.FREE_RISK_SCRATCH!;
const requireDb = createRequire(root + '/packages/db/package.json');
const {Client} = requireDb('pg');
const {validateDisposableTestDatabaseTarget} = await import(root + '/packages/db/src/database-url.ts');
const urls = [process.env.DATABASE_URL!, process.env.FREE_RISK_RESTORE_URL!];
urls.forEach(validateDisposableTestDatabaseTarget);
const [reader, writer, restored] = [urls[0], urls[0], urls[1]].map(connectionString => new Client({connectionString}));
await Promise.all([reader, writer, restored].map(client => client.connect()));
const report = (probe: string, result: unknown) => console.log(JSON.stringify({probe, result}));

try {
  // 2: PostgreSQL snapshots + a real file, deliberately scheduling publication between reads.
  await writer.query("create table risk_parent(status text); insert into risk_parent values('PENDING'); create table risk_revision(run_id text)");
  const runFile = join(scratch, 'run-artifact.json');
  const publish = async () => {
    await writer.query("begin; insert into risk_revision values('run'); update risk_parent set status='SUCCESS'; commit");
  };
  await writeFile(runFile, '{}');
  const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await utimes(runFile, twoDaysAgo, twoDaysAgo);
  const oldEnough = Date.now() - (await stat(runFile)).mtimeMs > 24 * 60 * 60 * 1000;
  assert.equal(oldEnough, true); // Child conversion is settled; parent's publication was delayed.
  const oldReferences = (await reader.query('select * from risk_revision')).rowCount;
  await publish();
  const terminal = (await reader.query('select status from risk_parent')).rows[0].status === 'SUCCESS';
  if (oldEnough && !oldReferences && terminal) await rm(runFile);
  await assert.rejects(readFile(runFile), {code: 'ENOENT'});
  assert.equal((await reader.query('select * from risk_revision')).rowCount, 1);
  report('2-gc-references-first', {oldEnough, referencedRunDeleted: true});

  await writer.query("truncate risk_revision; update risk_parent set status='PENDING'");
  await writeFile(runFile, '{}');
  await utimes(runFile, twoDaysAgo, twoDaysAgo);
  const wasTerminal = (await reader.query('select status from risk_parent')).rows[0].status === 'SUCCESS';
  await publish();
  const currentReferences = (await reader.query('select * from risk_revision')).rowCount;
  if (oldEnough && wasTerminal && !currentReferences) await rm(runFile);
  assert.equal(await readFile(runFile, 'utf8'), '{}');
  report('2-gc-terminal-first', {referencedRunPreserved: true});
  await writer.query('truncate risk_revision');
  const settled = (await reader.query('select status from risk_parent')).rows[0].status === 'SUCCESS';
  const unreferenced = (await reader.query('select * from risk_revision')).rowCount === 0;
  if (oldEnough && settled && unreferenced) await rm(runFile);
  await assert.rejects(readFile(runFile), {code: 'ENOENT'});
  report('2-gc-unreferenced-control', {eligibleRunRemoved: true});

  // 4: Actual HTTP delivery; planned response-hook logic; shorten 60 s to 150 ms.
  let key = false;
  let providerCalls = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('X-FREE-Studio-Boot', 'new-boot');
    if (req.url === '/keys') { key = true; res.writeHead(204).end(); return; }
    const deadline = Date.now() + 150;
    while (!key && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    if (!key) { res.writeHead(409).end('model_key_required'); return; }
    providerCalls++;
    res.writeHead(200).end('generated');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const {authenticatedFetch} = await import(root + '/prototypes/studio/src/auth/authenticatedFetch.ts');
  const responseHook = async () => {
    const response = await authenticatedFetch(new URL(base + '/generate'), {method: 'POST'});
    if (response.headers.get('X-FREE-Studio-Boot') === 'new-boot') await fetch(base + '/keys', {method: 'PUT'});
    return response;
  };
  try {
    const failed = await responseHook();
    assert.equal(await failed.text(), 'model_key_required');
    assert.equal(providerCalls, 0);
    report('4-boot-header-only', {firstStatus: failed.status, providerCalls, keyArrivedAfterFailure: key});
    key = false;
    await fetch(base + '/keys', {method: 'PUT'});
    const success = await responseHook();
    assert.equal(await success.text(), 'generated');
    assert.equal(providerCalls, 1);
    report('4-key-before-action', {firstStatus: success.status, providerCalls});
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

  // 5: Real dump/restore of a synthetic queued-input reference, plus copied volume files.
  const live = join(scratch, 'live');
  const recovered = join(scratch, 'restored');
  const volumes = ['parsing-runs', 'studio-data', 'studio-config', 'studio-claude'];
  for (const volume of [...volumes, 'source-inbox']) await mkdir(join(live, volume), {recursive: true});
  const stagedPath = 'source-inbox/attempt.pdf';
  await writeFile(join(live, stagedPath), '%PDF-synthetic-probe');
  await writer.query('create table risk_ingestion(status text, staged_path text)');
  await writer.query("insert into risk_ingestion values('ENQUEUED', $1)", [stagedPath]);
  const container = process.env.FREE_RISK_CONTAINER!;
  const dump = execFileSync('docker', ['exec', container, 'pg_dump', '-U', 'postgres', '--table=public.risk_ingestion', new URL(urls[0]).pathname.slice(1)]);
  execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', new URL(urls[1]).pathname.slice(1)], {input: dump, stdio: ['pipe', 'pipe', 'pipe']});
  for (const volume of volumes) await cp(join(live, volume), join(recovered, volume), {recursive: true});
  const input = (await restored.query('select * from risk_ingestion')).rows[0];
  assert.equal(input.status, 'ENQUEUED');
  await assert.rejects(readFile(join(recovered, input.staged_path)), {code: 'ENOENT'});
  report('5-backup-current-list', {queuedReferenceRestored: true, stagedPdfMissing: true});
  await cp(join(live, 'source-inbox'), join(recovered, 'source-inbox'), {recursive: true});
  assert.deepEqual(await readFile(join(recovered, input.staged_path)), await readFile(join(live, stagedPath)));
  report('5-backup-with-inbox', {stagedPdfRestoredExactly: true});
} finally { await Promise.all([reader, writer, restored].map(client => client.end())); }

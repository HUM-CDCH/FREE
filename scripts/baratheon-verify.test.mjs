import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

test('focused Python verification accepts SSH configuration as a single argument for both transports', t => {
  const directory = mkdtempSync(join(tmpdir(), 'free-verify-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const log = join(directory, 'calls.jsonl'), config = join(directory, 'ssh config')
  writeFileSync(config, 'Host baratheon\n')
  for (const name of ['git', 'ssh', 'scp']) {
    writeFileSync(join(directory, name), `#!/usr/bin/env node
const fs = require('node:fs'); const args=process.argv.slice(2);
fs.appendFileSync(process.env.FREE_VERIFY_TEST_LOG,JSON.stringify({name:${JSON.stringify(name)},args})+'\\n');
if (${JSON.stringify(name)}==='git' && args[0]==='rev-parse') process.stdout.write('a'.repeat(40)+'\\n');
if (${JSON.stringify(name)}==='ssh') fs.writeFileSync(process.env.FREE_VERIFY_TEST_LOG+'.remote',fs.readFileSync(0));
`, { mode: 0o700 })
  }
  const result = spawnSync('bash', [fileURLToPath(new URL('./baratheon-verify.sh', import.meta.url)), 'HEAD', 'test:unit:python'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, BARATHEON_SSH_CONFIG: config,
      FREE_VERIFY_TEST_LOG: log },
  })
  assert.equal(result.status, 0, result.stderr)
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
  for (const name of ['ssh', 'scp']) assert.deepEqual(calls.find(call => call.name === name).args.slice(0, 2), ['-F', config])
  const remote = readFileSync(`${log}.remote`, 'utf8')
  assert.ok(remote.includes('uv sync --frozen --project prototypes/parsing_service'))
  assert.ok(remote.includes('setup python-dependencies'))
  assert.ok(remote.includes('test:unit:python'))
})

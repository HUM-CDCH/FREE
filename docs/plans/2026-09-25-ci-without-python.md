# CI Without Python Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GitHub's `verify` job installs no Python environment and runs the deterministic tiers that need none (typecheck, lint, Node unit tiers, safety, db and extraction PostgreSQL, browser E2E with the scripted model server), while every local command keeps its full scope.

**Architecture:** One job variable, `FREE_SKIP_PYTHON=1`, is read in two places: the parsing service's `install:python` hook (a small Node script that skips `uv sync --frozen`) and `scripts/test-ci.mjs` (which runs the new `test:all:node` aggregate instead of `test:all`, and stops requiring the parsing database). Root scripts gain `test:unit:node`, `test:postgres:node` and `test:all:node`; the existing `test:unit` and `test:postgres` reuse the node chains and append the Parsing Service tiers, so nothing is listed twice. The workflow drops the uv install and the parsing database.

**Tech Stack:** pnpm 10 scripts, Node 24 ESM scripts with `node:test`, GitHub Actions.

**Spec:** the user's decision of 2026-09-25 ("I would not run pytorch on CI at all, only smoke tests") and the approved design in the M1 SDD ledger (`.superpowers/sdd/2026-09-25-dbos-m1-dead-code/progress.md`, local); the M1 verification record (`docs/validation/2026-09-25-dbos-m1-verification.md`) shows the Python tiers running locally.

## Global Constraints

- **Branch and base:** `ci/no-python` from `feat/kei-exp-parser` (d44cf79). PR base is `feat/kei-exp-parser`.
- **The variable is exactly `FREE_SKIP_PYTHON`, and only the value `'1'` skips.** Any other value, or its absence, keeps today's behaviour everywhere.
- **`pnpm test:all`, `pnpm test:unit` and `pnpm test:postgres` keep their full scope** (the Parsing Service tiers and `test:service` included); only `test:ci` under the variable narrows.
- **Never run `pnpm install`, `pnpm add`, `uv sync` or `pip`** in this worktree, not even to test the postinstall hook: test the new script by running it directly. If a command starts installing, stop and report.
- **Disposable databases only** for the Postgres tiers: `EXTRACTION_TEST_DATABASE_URL=postgresql://postgres:m1-disposable-only@127.0.0.1:5432/free_test_extraction` and `PROJECT_STORE_POSTGRES_URL=postgresql://postgres:m1-disposable-only@127.0.0.1:5432/free_test_project_store` (both exist on the running `free-m1-pg` container; never stop or reconfigure it).
- **Commits:** one per task, conventional prefix, scoped `git add` of named files only, never `git add -A`; each message ends, after a blank line, with the committing agent's own attribution trailer as the harness gives it. Never delete a file; never `git rm`, `stash`, `reset`, `checkout -- <file>`, `clean` or `commit --amend`.

## Review Focus

1. **A developer's or Docker `pnpm install` without the variable must still run `uv sync --frozen` unchanged.** Task 1's test "installs unless FREE_SKIP_PYTHON is exactly 1" pins the predicate and the command line.
2. **CI must never narrow silently:** `test:all:node` is chosen only under the explicit variable; without it `test:ci` still runs `test:all`. Task 1's test "chooses the node aggregate only under the variable" pins it.
3. **A present but wrong `PARSING_TEST_DATABASE_URL` must still be rejected when skipping Python**, so a stale secret cannot point at a real database. Task 1's test "still validates a parsing URL that is present" pins it.
4. **The local full chains must still include the Parsing Service tiers** after the split. Task 1's test "the full chains end with the Parsing Service tiers" reads the root `package.json`.
5. **The workflow must carry the variable and no uv step**, or the install fails again on the runner. Task 2's test "the verify workflow skips Python" reads `.github/workflows/verify.yml`.

---

### Task 1: The skip variable in the install hook, the CI driver, and the script chains

**Files:**
- Create: `scripts/install-python.mjs`
- Modify: `prototypes/parsing_service/package.json:5` (`install:python`)
- Modify: `package.json:17-27` (root scripts)
- Modify: `scripts/test-ci.mjs` (`validateCiEnvironment`, new `skipsPython`, `ciTestScript`, `runCi`)
- Test: `scripts/test-ci.test.mjs`, `scripts/install-python.test.mjs` (new)

**Interfaces:**
- Produces: `skipsPython(environment): boolean` and `ciTestScript(environment): 'test:all:node' | 'test:all'` exported from `scripts/test-ci.mjs`; `validateCiEnvironment` returns `parsingUrl: string | null`. Root scripts `test:unit:node`, `test:postgres:node`, `test:all:node`. `shouldInstallPython(environment): boolean` and `installPythonCommand()` exported from `scripts/install-python.mjs`. Task 2 sets `FREE_SKIP_PYTHON: '1'` in the workflow and documents `test:all:node`.

- [ ] **Step 1: Write the failing tests for the CI driver**

Append to `scripts/test-ci.test.mjs` (extend the import to `{ CI_DATABASE_URLS, ciTestScript, skipsPython, validateCiEnvironment }` and add `import { readFileSync } from 'node:fs'`):

```js
describe('CI without Python', () => {
  it('chooses the node aggregate only under the variable', () => {
    assert.equal(ciTestScript(validEnvironment()), 'test:all')
    assert.equal(ciTestScript({ ...validEnvironment(), FREE_SKIP_PYTHON: '1' }), 'test:all:node')
    assert.equal(ciTestScript({ ...validEnvironment(), FREE_SKIP_PYTHON: 'true' }), 'test:all')
    assert.equal(skipsPython({ FREE_SKIP_PYTHON: '1' }), true)
    assert.equal(skipsPython({}), false)
  })

  it('accepts a missing parsing database only when skipping Python', () => {
    const skipping = { ...validEnvironment(), FREE_SKIP_PYTHON: '1' }
    delete skipping.PARSING_TEST_DATABASE_URL
    assert.deepEqual(validateCiEnvironment(skipping), {
      databaseUrl: CI_DATABASE_URLS.extraction,
      extractionUrl: CI_DATABASE_URLS.extraction,
      projectStoreUrl: CI_DATABASE_URLS.projectStore,
      parsingUrl: null,
    })
    const notSkipping = validEnvironment()
    delete notSkipping.PARSING_TEST_DATABASE_URL
    assert.throws(() => validateCiEnvironment(notSkipping), /PARSING_TEST_DATABASE_URL is required/)
  })

  it('still validates a parsing URL that is present when skipping Python', () => {
    const stale = { ...validEnvironment(), FREE_SKIP_PYTHON: '1' }
    stale.PARSING_TEST_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/free'
    assert.throws(
      () => validateCiEnvironment(stale),
      /PARSING_TEST_DATABASE_URL must be the fixed disposable CI database URL/,
    )
  })

  it('the full chains end with the Parsing Service tiers', () => {
    const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    assert.equal(scripts['test:unit'], 'pnpm test:unit:node && pnpm --filter parsing-service test')
    assert.equal(scripts['test:postgres'], 'pnpm test:postgres:node && pnpm --filter parsing-service test:postgres')
    assert.equal(
      scripts['test:all:node'],
      'pnpm typecheck && pnpm lint && pnpm test:unit:node && pnpm test:safety && pnpm test:postgres:node && pnpm test:e2e',
    )
    assert.equal(
      scripts['test:all'],
      'pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:safety && pnpm test:postgres && pnpm test:e2e && pnpm test:service',
    )
    assert.ok(!scripts['test:unit:node'].includes('parsing-service'))
    assert.ok(!scripts['test:postgres:node'].includes('parsing-service'))
  })
})
```

- [ ] **Step 2: Write the failing test for the install hook**

Create `scripts/install-python.test.mjs`:

```js
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { installPythonCommand, shouldInstallPython } from './install-python.mjs'

describe('install:python', () => {
  it('installs unless FREE_SKIP_PYTHON is exactly 1', () => {
    assert.equal(shouldInstallPython({}), true)
    assert.equal(shouldInstallPython({ FREE_SKIP_PYTHON: '' }), true)
    assert.equal(shouldInstallPython({ FREE_SKIP_PYTHON: 'true' }), true)
    assert.equal(shouldInstallPython({ FREE_SKIP_PYTHON: '1' }), false)
  })

  it('runs the frozen sync in the parsing service directory', () => {
    assert.deepEqual(installPythonCommand(), {
      command: 'uv',
      arguments: ['sync', '--frozen'],
      cwd: new URL('../prototypes/parsing_service/', import.meta.url).pathname,
    })
  })
})
```

- [ ] **Step 3: Run both test files to see them fail**

Run: `node --test scripts/test-ci.test.mjs scripts/install-python.test.mjs`
Expected: FAIL: `ciTestScript`/`skipsPython` are not exported; `install-python.mjs` does not exist; the `package.json` assertions fail on the current scripts.

- [ ] **Step 4: Write the install hook script**

Create `scripts/install-python.mjs`:

```js
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** `pnpm install` runs this as the parsing service's `install:python` hook. */
export function shouldInstallPython(environment = process.env) {
  return environment.FREE_SKIP_PYTHON !== '1'
}

export function installPythonCommand() {
  return {
    command: 'uv',
    arguments: ['sync', '--frozen'],
    cwd: fileURLToPath(new URL('../prototypes/parsing_service/', import.meta.url)),
  }
}

export async function installPython(environment = process.env) {
  if (!shouldInstallPython(environment)) {
    console.log('install:python skipped: FREE_SKIP_PYTHON=1 (no Python environment on this host).')
    return
  }
  const { command, arguments: args, cwd } = installPythonCommand()
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: environment, shell: false, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code ?? signal ?? 'an unknown status'}.`))
    })
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await installPython()
```

In `prototypes/parsing_service/package.json`, change line 5 to:

```json
    "install:python": "node ../../scripts/install-python.mjs",
```

- [ ] **Step 5: Split the root script chains**

In the root `package.json`, replace the `test:unit`, `test:postgres` and `test:all` lines and add the three node chains, so the block reads:

```json
    "test": "pnpm test:unit",
    "test:unit": "pnpm test:unit:node && pnpm --filter parsing-service test",
    "test:unit:node": "node --test scripts/free.test.mjs scripts/test-ci.test.mjs scripts/install-python.test.mjs && pnpm --filter studio-configuration test && pnpm --filter studio test && pnpm --filter db test && pnpm --filter extraction test && pnpm --filter extraction-result-export test",
    "test:safety": "node --test --test-concurrency=1 tests/safety.test.mjs",
    "test:postgres": "pnpm test:postgres:node && pnpm --filter parsing-service test:postgres",
    "test:postgres:node": "pnpm --filter db test:postgres && pnpm --filter extraction test:postgres",
    "test:e2e": "pnpm --filter studio test:e2e",
    "test:service": "pnpm --filter studio test:service",
    "test:live-model": "pnpm --filter studio test:live-model && pnpm --filter parsing-service test:live-model",
    "test:system": "node --test --test-concurrency=1 tests/contract.test.mjs",
    "test:all": "pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:safety && pnpm test:postgres && pnpm test:e2e && pnpm test:service",
    "test:all:node": "pnpm typecheck && pnpm lint && pnpm test:unit:node && pnpm test:safety && pnpm test:postgres:node && pnpm test:e2e",
    "test:ci": "node scripts/test-ci.mjs",
```

Keep every other script line as it is.

- [ ] **Step 6: Teach the CI driver the variable**

In `scripts/test-ci.mjs`:

```js
export function skipsPython(environment) {
  return environment.FREE_SKIP_PYTHON === '1'
}

export function ciTestScript(environment) {
  return skipsPython(environment) ? 'test:all:node' : 'test:all'
}
```

In `validateCiEnvironment`, replace the parsing lines:

```js
  const parsingUrl = skipsPython(environment)
    ? environment.PARSING_TEST_DATABASE_URL ?? null
    : required(environment, 'PARSING_TEST_DATABASE_URL')
  ...
  if (parsingUrl !== null)
    validateFixedTarget(
      'PARSING_TEST_DATABASE_URL',
      parsingUrl,
      'free_test_parsing',
      CI_DATABASE_URLS.parsing,
    )

  return { databaseUrl, extractionUrl, projectStoreUrl, parsingUrl }
```

(`required` already throws `PARSING_TEST_DATABASE_URL is required by pnpm test:ci.` when the variable is absent and Python is not skipped.) In `runCi`, replace `await runPnpm(['test:all'], environment)` with `await runPnpm([ciTestScript(environment)], environment)`.

- [ ] **Step 7: Run the tests to see them pass**

Run: `node --test scripts/free.test.mjs scripts/test-ci.test.mjs scripts/install-python.test.mjs`. Expected: PASS, output pristine.
Run: `FREE_SKIP_PYTHON=1 node scripts/install-python.mjs`. Expected: prints the skip line, exit 0, no `uv` process started.
Run: `pnpm test:unit:node`. Expected: PASS (scripts, studio-configuration, studio, db, extraction, extraction-result-export). Do not run `pnpm test:unit`: its last step is the Python tier, which this task does not change.
Run, with both database variables exported: `pnpm test:postgres:node`. Expected: PASS (db 3/3, extraction 28/28).

- [ ] **Step 8: Commit**

```bash
git add scripts/install-python.mjs scripts/install-python.test.mjs scripts/test-ci.mjs scripts/test-ci.test.mjs package.json prototypes/parsing_service/package.json
git commit -m "build(ci): let FREE_SKIP_PYTHON skip the Python install and tiers"
```

---

### Task 2: The workflow and the documentation

**Files:**
- Modify: `.github/workflows/verify.yml` (job `env`, the uv step, the database step)
- Modify: `README.md:116-126` (Verification table and paragraph)
- Test: `scripts/test-ci.test.mjs`

**Interfaces:**
- Consumes: `FREE_SKIP_PYTHON`, `test:all:node` and the relaxed `validateCiEnvironment` from Task 1.

- [ ] **Step 1: Write the failing workflow test**

Append to `scripts/test-ci.test.mjs`:

```js
describe('verify workflow', () => {
  it('skips Python and installs no uv', () => {
    const workflow = readFileSync(new URL('../.github/workflows/verify.yml', import.meta.url), 'utf8')
    assert.match(workflow, /^\s+FREE_SKIP_PYTHON: '1'$/m)
    assert.doesNotMatch(workflow, /setup-uv/)
    assert.doesNotMatch(workflow, /PARSING_TEST_DATABASE_URL/)
    assert.doesNotMatch(workflow, /free_test_parsing/)
    assert.match(workflow, /run: pnpm test:ci$/m)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test scripts/test-ci.test.mjs`. Expected: FAIL on the first assertion (no variable yet).

- [ ] **Step 3: Edit the workflow**

In `.github/workflows/verify.yml`:
- In the job `env` block (after `CI: 'true'`), add `FREE_SKIP_PYTHON: '1'` and delete the `PARSING_TEST_DATABASE_URL:` line.
- Delete the whole `- name: Install uv` step (`uses: astral-sh/setup-uv@v10.0.1` with its `version`, `enable-cache` and `cache-dependency-glob` lines).
- In `Create extraction and parsing integration databases`, delete the `createdb ... free_test_parsing` line and rename the step `Create the extraction integration database`.

The resulting `env` block:

```yaml
    env:
      CI: 'true'
      FREE_SKIP_PYTHON: '1'
      DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5432/free_test_extraction
      EXTRACTION_TEST_DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5432/free_test_extraction
      PROJECT_STORE_POSTGRES_URL: postgresql://postgres:postgres@127.0.0.1:5432/free_test_project_store
```

- [ ] **Step 4: Run the test to see it pass**

Run: `node --test scripts/test-ci.test.mjs`. Expected: PASS.
Run: `pnpm test:safety`. Expected: PASS (it renders Compose and checks the Dockerfile; the workflow is not its input, but it proves nothing else broke).

- [ ] **Step 5: Document the CI scope**

In `README.md`, replace the `pnpm test:ci` table row with:

```markdown
| `pnpm test:ci` | CI-only aggregate; verifies the fixed disposable CI targets, migrates them, and runs `test:all:node` when `FREE_SKIP_PYTHON=1` (GitHub's job), otherwise `test:all` |
```

Add after the `pnpm test:all` row:

```markdown
| `pnpm test:all:node` | The deterministic tiers that need no Python environment: typecheck, lint, Node unit (`test:unit:node`), safety, db and extraction PostgreSQL (`test:postgres:node`), and E2E |
```

Replace the paragraph starting `` `test:live-model` and `test:system` remain deliberately outside `` with:

```markdown
`test:live-model` and `test:system` remain deliberately outside `test:all`
and `test:ci`: they depend on a live model or mutate the default development
stack. GitHub's Linux `verify` job runs `test:ci` with `FREE_SKIP_PYTHON=1`:
it installs no Python environment (the CUDA PyTorch wheels do not fit the
hosted runner), so the Parsing Service tiers and `test:service` run locally
against a disposable database, as the dated records in `docs/validation/`
show. `FREE_SKIP_PYTHON=1` also makes `pnpm install` skip the parsing
service's `uv sync --frozen`; leave it unset on development and deployment
hosts.
```

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/verify.yml README.md scripts/test-ci.test.mjs
git commit -m "ci: run the deterministic tiers without a Python environment"
```

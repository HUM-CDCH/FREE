import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/** The serving boundary's invariants, checked at this package's source; an independent review covers the rest. */
const SOURCE = fileURLToPath(new URL('.', import.meta.url))
const read = (name: string) => readFileSync(`${SOURCE}${name}`, 'utf8')
const serving = readdirSync(SOURCE).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
/** Every module specifier: `… from '…'` (single- or multi-line), `import('…')` and bare `import '…'`. */
const importsOf = (name: string) =>
  [...read(name).matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm)]
    .map((match) => match[1] ?? match[2] ?? match[3]!)

test('serving code imports no experiment, validation report or Studio code', () => {
  for (const name of serving)
    for (const specifier of importsOf(name))
      assert.doesNotMatch(specifier, /experiments|docs\/validation|apps\//, `${name} imports ${specifier}`)
})

test('execution reads the admitted method only: nothing on the durable execution path touches the account configuration', () => {
  for (const name of ['workflows.ts', 'workflow-steps.ts', 'durable-repository.ts', 'durable-feedback.ts', 'kei-evidence.ts', 'kei-handoff.ts'])
    for (const account of ['lockModelConfiguration', 'ModelConfiguration', 'accountMethod', 'createModelConfigurationStore'])
      assert.ok(!read(name).includes(account), `${name} mentions ${account}`)
})

test('the method contract stays browser-safe and holds no extraction algorithm', () => {
  assert.deepEqual(importsOf('extraction-method.ts').sort(), ['./allowed-values.js', './errors.js', './schema.js', './types.js', 'zod'])
})

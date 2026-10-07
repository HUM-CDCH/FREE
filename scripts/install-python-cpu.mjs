import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('../prototypes/parsing_service/', import.meta.url))

/** The release lock supplies every version; CPU wheels replace CUDA wheels
 * and their NVIDIA-only dependencies for the fast hosted-runner tier. */
export function cpuRequirements(exported) {
  const lines = exported.split('\n').filter(line => !/^nvidia[-_]/i.test(line))
  for (const name of ['torch', 'torchaudio', 'torchvision'])
    if (!lines.some(line => line.startsWith(`${name}==`)))
      throw new Error(`The frozen export must pin ${name}.`)
  return lines.join('\n')
}

export function installCpuPython(environment = process.env, run = spawnSync) {
  const target = resolve(environment.UV_PROJECT_ENVIRONMENT ?? join(project, '.venv-cpu'))
  if (target === resolve(project, '.venv'))
    throw new Error('Use a separate UV_PROJECT_ENVIRONMENT for CPU checks.')
  const execute = (args, options = {}) => {
    const result = run('uv', args, { cwd: project, env: environment, encoding: 'utf8', ...options })
    if (result.error || result.status !== 0) throw new Error(`CPU Python setup failed: uv ${args[0]}.`)
    return result.stdout
  }
  const directory = mkdtempSync(join(tmpdir(), 'free-python-cpu-'))
  try {
    const requirements = join(directory, 'requirements.txt')
    const exported = execute(['export', '--frozen', '--no-hashes', '--no-annotate', '--no-header',
      '--no-emit-project', '--format', 'requirements.txt'])
    writeFileSync(requirements, cpuRequirements(exported))
    execute(['venv', '--python', '3.13', '--allow-existing', target], { stdio: 'inherit' })
    const python = join(target, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    execute(['pip', 'sync', '--python', python, '--torch-backend', 'cpu', requirements], { stdio: 'inherit' })
    execute(['pip', 'install', '--python', python, '--no-deps', '--editable', project], { stdio: 'inherit' })
    const digest = createHash('sha256').update(readFileSync(join(project, 'uv.lock'))).digest('hex')
    writeFileSync(join(target, '.free-lock-sha256'), `${digest}\n`)
    console.log(`CPU Python environment ready: ${target}`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) installCpuPython()

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** `pnpm install` runs this as the parsing service's `install:python` hook. */
export function shouldInstallPython(environment = process.env) {
  return environment.FREE_SKIP_PYTHON !== '1'
}

/**
 * On Windows `uv` may be a `.cmd`/`.bat` shim, which `spawn` without a shell
 * cannot resolve (libuv ignores PATHEXT), so run it through `cmd.exe`.
 */
export function installPythonCommand(platform = process.platform) {
  const cwd = fileURLToPath(new URL('../apps/parsing_service/', import.meta.url))
  if (platform === 'win32')
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      arguments: ['/d', '/s', '/c', 'uv sync --frozen'],
      cwd,
    }
  return { command: 'uv', arguments: ['sync', '--frozen'], cwd }
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

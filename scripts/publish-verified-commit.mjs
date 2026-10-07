import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export function verificationRecord(environment) {
  if (environment.GITHUB_EVENT_NAME !== 'push' || environment.GITHUB_REF !== 'refs/heads/dev'
    || environment.GITHUB_REPOSITORY !== 'HUM-CDCH/FREE')
    throw new Error('Verification tags are published only for the trusted dev push.')
  const sha = environment.GITHUB_SHA
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('A full commit SHA is required.')
  if (environment.VERIFY_NODE_RESULT !== 'success' || environment.VERIFY_PYTHON_RESULT !== 'success')
    throw new Error('Both verification jobs must pass before a release tag is published.')
  return { version: 1, repository: 'HUM-CDCH/FREE', commit: sha,
    checks: { verify: 'success', 'verify-python': 'success' } }
}

export function publishVerifiedCommit(environment = process.env, run = spawnSync) {
  const record = verificationRecord(environment), tag = `free-verified/${record.commit}`
  const git = (args, allowFailure = false) => {
    const result = run('git', args, { encoding: 'utf8', env: environment })
    if (!allowFailure && (result.error || result.status !== 0)) throw new Error(`Verification tag failed: git ${args[0]}.`)
    return result
  }
  if (git(['rev-parse', 'HEAD']).stdout.trim() !== record.commit) throw new Error('Checkout does not match the verified commit.')
  // A rerun is idempotent; never replace an existing attestation.
  if (git(['fetch', '--no-tags', 'origin', `refs/tags/${tag}:refs/tags/${tag}`], true).status === 0) {
    const saved = JSON.parse(git(['for-each-ref', '--format=%(contents)', `refs/tags/${tag}`]).stdout)
    if (JSON.stringify(saved) !== JSON.stringify(record)
      || git(['rev-parse', `${tag}^{commit}`]).stdout.trim() !== record.commit)
      throw new Error('The existing verification tag does not match.')
    return
  }
  git(['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'tag', '--annotate', tag, '--message', JSON.stringify(record), record.commit])
  git(['push', 'origin', `refs/tags/${tag}`])
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) publishVerifiedCommit()

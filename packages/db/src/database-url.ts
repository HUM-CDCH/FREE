const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Refuse to reset anything except FREE's conventional local development DB. */
export function localDevelopmentDatabase(value: string): URL {
  const url = new URL(value)
  if (!LOCAL_HOSTS.has(url.hostname) || url.pathname !== '/free')
    throw new Error(
      'db:reset only accepts the local development database named "free".',
    )
  return url
}

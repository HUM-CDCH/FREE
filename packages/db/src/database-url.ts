const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Accept only FREE's conventional local development database. */
export function localDevelopmentDatabase(value: string): URL {
  const url = new URL(value)
  if (!LOCAL_HOSTS.has(url.hostname) || url.pathname !== '/free')
    throw new Error(
      'Only the local development database named "free" is accepted.',
    )
  return url
}

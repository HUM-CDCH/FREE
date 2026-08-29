const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Accept only FREE's conventional local development database. */
export function localDevelopmentDatabase(
  value: string,
  allowDevContainerHost = false,
): URL {
  const url = new URL(value)
  const localHost =
    LOCAL_HOSTS.has(url.hostname) ||
    (allowDevContainerHost && url.hostname === 'db')
  if (!localHost || url.pathname !== '/free')
    throw new Error(
      'Only the local development database named "free" is accepted.',
    )
  return url
}

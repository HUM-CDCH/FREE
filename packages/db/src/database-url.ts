const LOOPBACK_HOSTS: Record<string, true> = {
  localhost: true,
  '127.0.0.1': true,
  '[::1]': true,
}

const TARGET_QUERY_PARAMETERS: Record<string, true> = {
  database: true,
  host: true,
  port: true,
  user: true,
}

interface DatabaseTargetPolicy {
  acceptsDatabase(database: string): boolean
  allowDevContainerHost: boolean
  errorMessage: string
}

function validateDatabaseTarget(
  value: string,
  policy: DatabaseTargetPolicy,
): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(policy.errorMessage)
  }
  const acceptedHost =
    LOOPBACK_HOSTS[url.hostname] === true ||
    (policy.allowDevContainerHost && url.hostname === 'db')
  const database = url.pathname.slice(1)
  let queryOverridesTarget = false
  for (const parameter of url.searchParams.keys())
    if (TARGET_QUERY_PARAMETERS[parameter] === true) {
      queryOverridesTarget = true
      break
    }

  if (
    url.protocol !== 'postgresql:' ||
    url.username !== 'postgres' ||
    !acceptedHost ||
    url.port !== '5432' ||
    !policy.acceptsDatabase(database) ||
    queryOverridesTarget
  )
    throw new Error(policy.errorMessage)

  return url
}

/**
 * Validate a target before dropping or recreating FREE's development database.
 * The `db` host is accepted only when the caller explicitly confirms that it
 * is running in the Dev Container.
 */
export function validateDestructiveDatabaseTarget(
  value: string,
  options: { allowDevContainerHost: boolean },
): URL {
  return validateDatabaseTarget(value, {
    acceptsDatabase: (database) => database === 'free',
    allowDevContainerHost: options.allowDevContainerHost,
    errorMessage:
      'Destructive database operations require PostgreSQL user "postgres", explicit port 5432, database "free", and a loopback host (or Dev Container host "db" with FREE_DEVCONTAINER=1).',
  })
}

/** Validate a disposable database target before running PostgreSQL checks. */
export function validateDisposableTestDatabaseTarget(value: string): URL {
  return validateDatabaseTarget(value, {
    acceptsDatabase: (database) => database.startsWith('free_test_'),
    allowDevContainerHost: false,
    errorMessage:
      'Disposable PostgreSQL tests require PostgreSQL user "postgres", explicit port 5432, a loopback host, and a database named "free_test_*".',
  })
}

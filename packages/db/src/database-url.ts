const LOOPBACK_HOSTS: Record<string, true> = {
  localhost: true,
  '127.0.0.1': true,
  '[::1]': true,
}

interface DatabaseTargetPolicy {
  acceptsDatabase(database: string): boolean
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
  const database = url.pathname.slice(1)

  if (
    url.protocol !== 'postgresql:' ||
    url.username !== 'postgres' ||
    LOOPBACK_HOSTS[url.hostname] !== true ||
    url.port !== '5432' ||
    !policy.acceptsDatabase(database) ||
    url.searchParams.size !== 0
  )
    throw new Error(policy.errorMessage)

  return url
}

/** Validate a target before dropping or recreating FREE's development database. */
export function validateDestructiveDatabaseTarget(value: string): URL {
  return validateDatabaseTarget(value, {
    acceptsDatabase: (database) => database === 'free',
    errorMessage:
      'Destructive database operations require PostgreSQL user "postgres", explicit port 5432, database "free", and a loopback host.',
  })
}

/** Validate a disposable database target before running PostgreSQL checks. */
export function validateDisposableTestDatabaseTarget(value: string): URL {
  return validateDatabaseTarget(value, {
    acceptsDatabase: (database) => database.startsWith('free_test_'),
    errorMessage:
      'Disposable PostgreSQL tests require PostgreSQL user "postgres", explicit port 5432, a loopback host, and a database named "free_test_*".',
  })
}

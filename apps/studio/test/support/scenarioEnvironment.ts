/** Keep missing-variable errors specific to the workflow scenario that needs them. */
export function requiredScenarioValue(
  env: NodeJS.ProcessEnv,
  scenario: string,
) {
  return (name: string): string => {
    const value = env[name]
    if (!value) throw new Error(`The ${scenario} scenario needs ${name}.`)
    return value
  }
}

/** These disposable scenarios run Studio and its queue client with the same fixture login. */
export function scenarioDbosOptions(required: (name: string) => string) {
  const databaseUrl = required('DATABASE_URL')
  return {
    databaseUrl,
    keiDatabaseUrl: databaseUrl,
    schema: required('FREE_TEST_DBOS_SCHEMA'),
    keiSchema: required('FREE_TEST_KEI_SCHEMA'),
    executorId: required('FREE_TEST_EXECUTOR'),
  }
}

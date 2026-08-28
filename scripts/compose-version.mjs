export const MINIMUM_COMPOSE_VERSION = '2.33.1'

function versionParts(value) {
  const match = String(value).trim().match(/^(?:Docker Compose version )?v?(\d+)\.(\d+)\.(\d+)/)
  return match ? match.slice(1, 4).map(Number) : null
}

export function validateComposeVersion(value) {
  const installed = versionParts(value)
  const minimum = versionParts(MINIMUM_COMPOSE_VERSION)
  if (!installed)
    throw new Error(
      `Docker Compose ${MINIMUM_COMPOSE_VERSION} or later is required; the installed version could not be determined from "${String(value).trim()}".`,
    )
  for (let index = 0; index < installed.length; index += 1) {
    if (installed[index] > minimum[index]) return
    if (installed[index] < minimum[index])
      throw new Error(
        `Docker Compose ${MINIMUM_COMPOSE_VERSION} or later is required; found ${installed.join('.')}.`,
      )
  }
}

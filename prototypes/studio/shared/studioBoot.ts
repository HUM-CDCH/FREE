/**
 * The response header naming the Studio process that answered, and with it the lifetime of that process's in-memory
 * key cache: a page that sees the ID change knows the keys it sent are gone and sends them again. A leaf module, so
 * the signed-out page's development module graph (through `authenticatedFetch`) gains no dependencies.
 */
export const STUDIO_BOOT_HEADER = 'X-FREE-Studio-Boot'

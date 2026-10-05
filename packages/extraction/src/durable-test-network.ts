/** Use a task-owned namespace when the host's guarded PostgreSQL port is occupied. */
export function durableTestNetwork() {
  const network=process.env.DURABLE_TEST_DOCKER_NETWORK??'host'
  if(network!=='host'&&!/^container:free-durable-test-[a-z0-9-]+$/.test(network))
    throw new Error('Durable worker fixtures require host or a named free-durable-test-* container namespace.')
  return network
}

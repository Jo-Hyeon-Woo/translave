// Only fake OAuth's app-owned loopback callback may use real fetch.
// Provider tests inject their own fakes; accidental default fetch must fail closed.
const realFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/auth/callback')
    return Promise.reject(new Error('Unit tests prohibit external network access'))
  return realFetch(input, init)
}

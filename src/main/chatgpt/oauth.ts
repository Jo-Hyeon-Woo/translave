import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { createLocalJWKSet, jwtVerify } from 'jose'
import type { JSONWebKeySet } from 'jose'
import { ChatGPTError, checkResponse } from './errors'
export const ISSUER = 'https://auth.openai.com'
export const RESOURCE = 'https://api.openai.com/v1'
export const SCOPES =
  'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
export type Fetch = typeof fetch
export interface Discovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  revocation_endpoint?: string
}
export async function discovery(fetcher: Fetch, signal?: AbortSignal): Promise<Discovery> {
  const r = await fetcher(ISSUER + '/.well-known/openid-configuration', {
    signal,
    redirect: 'error',
  })
  await checkResponse(r)
  const d = (await r.json()) as Discovery
  if (d.issuer !== ISSUER) throw new ChatGPTError('auth')
  for (const key of [
    'authorization_endpoint',
    'token_endpoint',
    'jwks_uri',
    'revocation_endpoint',
  ] as const) {
    if (key === 'revocation_endpoint' && !d[key]) continue
    const u = new URL(d[key]!)
    if (u.origin !== ISSUER || u.username || u.password || u.hash) throw new ChatGPTError('auth')
  }
  return d
}
export async function verifyIdentity(
  fetcher: Fetch,
  d: Discovery,
  token: string,
  clientId: string,
  nonce?: string,
  subject?: string,
  allowMissingNonce = false,
) {
  try {
    const response = await fetcher(d.jwks_uri, {
      signal: AbortSignal.timeout(20000),
      redirect: 'error',
    })
    await checkResponse(response)
    const keys = createLocalJWKSet((await response.json()) as JSONWebKeySet)
    const { payload } = await jwtVerify(token, keys, {
      issuer: ISSUER,
      audience: clientId,
      requiredClaims: ['sub', 'exp', 'iat'],
      clockTolerance: 5,
      maxTokenAge: '2h',
      algorithms: ['RS256', 'ES256'],
    })
    if (
      !payload.sub ||
      (nonce !== undefined &&
        payload.nonce !== nonce &&
        !(allowMissingNonce && payload.nonce === undefined)) ||
      (subject && payload.sub !== subject)
    )
      throw new ChatGPTError('auth')
    if (
      (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) ||
      (payload.azp !== undefined && payload.azp !== clientId)
    )
      throw new ChatGPTError('auth')
    return {
      subject: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
    }
  } catch {
    throw new ChatGPTError('auth')
  }
}
export function randomSecret() {
  return randomBytes(32).toString('base64url')
}
export function pkceChallenge(verifier: string) {
  return createHash('sha256').update(verifier).digest('base64url')
}
function same(a: string, b: string) {
  const aa = Buffer.from(a),
    bb = Buffer.from(b)
  return aa.length === bb.length && timingSafeEqual(aa, bb)
}
export interface Callback {
  code: string
  clientId: string
}
export async function listenCallback(
  state: string,
  clientId: string | undefined,
  signal: AbortSignal,
) {
  let resolve!: (value: Callback) => void, reject!: (e: unknown) => void
  const result = new Promise<Callback>((a, b) => {
    resolve = a
    reject = b
  })
  // Attach early, before browser launch/listener errors can reject the result.
  void result.catch(() => {})
  let consumed = false
  const server = createServer((request, response) => {
    const finish = (status: number, message: string) => {
      response.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'",
        'Referrer-Policy': 'no-referrer',
      })
      response.end(message)
    }
    if (
      request.method !== 'GET' ||
      request.headers.host !== new URL(redirectUri).host ||
      consumed
    ) {
      finish(400, 'Invalid callback')
      return
    }
    const url = new URL(request.url || '/', redirectUri)
    if (url.origin !== new URL(redirectUri).origin || url.pathname !== '/auth/callback') {
      finish(404, 'Not found')
      return
    }
    const keys = ['state', 'code', 'error', 'client_id']
    if (
      keys.some((k) => url.searchParams.getAll(k).length > 1) ||
      !same(url.searchParams.get('state') || '', state)
    ) {
      finish(400, 'Sign-in could not be verified. Return to Translave.')
      reject(new ChatGPTError('auth'))
      return
    }
    consumed = true
    const error = url.searchParams.get('error')
    if (error) {
      finish(200, 'Sign-in canceled. Return to Translave.')
      reject(new ChatGPTError(error === 'access_denied' ? 'canceled' : 'auth'))
      return
    }
    const issued = url.searchParams.get('client_id') || clientId
    const code = url.searchParams.get('code')
    if (
      !code ||
      code.length > 8192 ||
      !issued ||
      issued === 'dynamic_agent_client' ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(issued) ||
      (clientId && issued !== clientId)
    ) {
      finish(400, 'Invalid sign-in response. Return to Translave.')
      reject(new ChatGPTError('auth'))
      return
    }
    finish(200, 'Sign-in received. You may close this tab and return to Translave.')
    resolve({ code, clientId: issued })
  })
  let redirectUri = ''
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', rejectListen)
      resolveListen()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new ChatGPTError('auth')
  }
  redirectUri = `http://127.0.0.1:${address.port}/auth/callback`
  const abort = () => {
    reject(signal.reason)
    server.closeAllConnections()
    server.close()
  }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  return {
    redirectUri,
    result,
    close: () => {
      signal.removeEventListener('abort', abort)
      server.closeAllConnections()
      server.close()
    },
  }
}

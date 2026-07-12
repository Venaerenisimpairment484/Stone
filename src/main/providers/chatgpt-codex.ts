import type { Account, AccountCodexQuotaSnapshot } from '@shared/types'
import type { ProviderFailure } from './types'
import { parseRetryAfter } from './failure'
import { extractCodexQuotaFromUsagePayload } from './quota'
import { deserializeChatGptCredential, serializeChatGptCredential, type ChatGptCredentialBundle } from '../auth'

export const CHATGPT_CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
export const CODEX_CLIENT_VERSION = '0.144.1'
export const CHATGPT_CODEX_MODELS_URL = `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`
export const CHATGPT_CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const CODEX_USER_AGENT = `codex_cli_rs/${CODEX_CLIENT_VERSION} (Windows 11; x86_64)`
const CODEX_PASSTHROUGH_HEADERS = Object.freeze([
  'accept-language',
  'conversation_id',
  'session_id',
  'x-codex-turn-state',
  'x-codex-turn-metadata'
])

type ChatGptSourceHeaders = Headers | Readonly<Record<string, string | string[] | undefined>>

export interface ChatGptCredentialAccess {
  bundle: ChatGptCredentialBundle
  serialized: string
}

export async function resolveChatGptCredential(
  encryptedValue: string,
  persistRotated: (serialized: string) => Promise<void>,
  fetchImplementation: typeof fetch = fetch,
  now = Date.now()
): Promise<ChatGptCredentialAccess> {
  const current = deserializeChatGptCredential(encryptedValue)
  if (!current) throw new Error('ChatGPT account credential is invalid.')
  if (current.expiresAt - now > 5 * 60 * 1000) return { bundle: current, serialized: encryptedValue }
  if (!current.refreshToken) throw new Error('ChatGPT account access token expired and has no refresh token.')
  const refreshed = await refreshChatGptCredential(current, fetchImplementation)
  const serialized = serializeChatGptCredential(refreshed)
  await persistRotated(serialized)
  return { bundle: refreshed, serialized }
}

export async function refreshChatGptCredential(
  current: ChatGptCredentialBundle,
  fetchImplementation: typeof fetch = fetch
): Promise<ChatGptCredentialBundle> {
  if (!current.refreshToken) throw new Error('ChatGPT account has no refresh token.')
  let response: Response
  try {
    response = await fetchImplementation('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': `codex-cli/${CODEX_CLIENT_VERSION}` },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: current.refreshToken,
        client_id: CODEX_OAUTH_CLIENT_ID,
        scope: 'openid profile email'
      })
    })
  } catch (error) {
    if (isAbortOrTimeout(error)) throw new Error('ChatGPT token refresh timed out.')
    throw new Error('ChatGPT token refresh endpoint could not be reached.')
  }
  if (!response.ok) throw new Error(response.status === 400 || response.status === 401 ? 'ChatGPT refresh token was rejected.' : 'ChatGPT token refresh failed.')
  const payload = await response.json() as Record<string, unknown>
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token.trim() : ''
  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 0
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('ChatGPT token refresh returned an invalid response.')
  return {
    ...current,
    accessToken,
    expiresAt: Date.now() + expiresIn * 1000,
    refreshToken: typeof payload.refresh_token === 'string' && payload.refresh_token.trim() ? payload.refresh_token.trim() : current.refreshToken,
    idToken: typeof payload.id_token === 'string' && payload.id_token.trim() ? payload.id_token.trim() : current.idToken
  }
}

export function applyChatGptCodexHeaders(
  headers: Headers,
  bundle: ChatGptCredentialBundle,
  sourceHeaders?: ChatGptSourceHeaders
): void {
  for (const name of CODEX_PASSTHROUGH_HEADERS) {
    const value = readSourceHeader(sourceHeaders, name)
    if (value) headers.set(name, value)
  }
  applyChatGptCodexIdentityHeaders(headers, bundle)
  headers.set('accept', 'text/event-stream')
  headers.set('content-type', 'application/json')
  headers.set('openai-beta', 'responses=experimental')
}

function applyChatGptCodexIdentityHeaders(headers: Headers, bundle: ChatGptCredentialBundle): void {
  headers.set('authorization', `Bearer ${bundle.accessToken}`)
  headers.set('chatgpt-account-id', bundle.accountId)
  headers.set('originator', 'codex_cli_rs')
  headers.set('user-agent', CODEX_USER_AGENT)
  headers.set('version', CODEX_CLIENT_VERSION)
}

function readSourceHeader(source: ChatGptSourceHeaders | undefined, name: string): string | undefined {
  if (!source) return undefined
  if (source instanceof Headers) return source.get(name)?.trim() || undefined
  const match = Object.entries(source).find(([key]) => key.toLowerCase() === name)?.[1]
  const value = Array.isArray(match) ? match.join(', ') : match
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function withChatGptCodexBody(body: Record<string, unknown>): Record<string, unknown> {
  return {
    ...body,
    instructions: typeof body.instructions === 'string' && body.instructions.trim()
      ? body.instructions
      : 'You are Codex, a coding assistant.',
    store: false,
    stream: true
  }
}

export async function probeChatGptAccount(
  account: Account,
  bundle: ChatGptCredentialBundle,
  fetchImplementation: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<{ ok: boolean; latencyMs: number; statusCode?: number; failure?: ProviderFailure }> {
  const started = Date.now()
  const headers = new Headers()
  applyChatGptCodexHeaders(headers, bundle)
  try {
    const response = await fetchImplementation(CHATGPT_CODEX_RESPONSES_URL, {
      method: 'POST', headers, signal,
      body: JSON.stringify(withChatGptCodexBody({
        model: account.modelAllowlist[0] ?? 'gpt-5.4',
        instructions: 'You are a coding assistant.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with OK.' }] }]
      }))
    })
    await response.body?.cancel().catch(() => undefined)
    return response.ok
      ? { ok: true, latencyMs: Date.now() - started, statusCode: response.status }
      : { ok: false, latencyMs: Date.now() - started, statusCode: response.status, failure: classifyChatGptCodexFailure(response.status, response.headers) }
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, failure: { category: 'network', message: error instanceof Error ? 'ChatGPT Codex endpoint could not be reached.' : 'ChatGPT Codex request failed.', retryable: true, accountAction: 'cooldown' } }
  }
}

export async function queryChatGptCodexModels(
  bundle: ChatGptCredentialBundle,
  fetchImplementation: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<string[]> {
  const headers = new Headers({ accept: 'application/json' })
  applyChatGptCodexIdentityHeaders(headers, bundle)
  let response: Response
  try {
    response = await fetchImplementation(CHATGPT_CODEX_MODELS_URL, {
      method: 'GET',
      headers,
      signal
    })
  } catch (error) {
    if (isAbortOrTimeout(error)) throw new Error('ChatGPT Codex model request timed out.')
    throw new Error('ChatGPT Codex model endpoint could not be reached.')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 401) throw new Error('ChatGPT session access token was rejected.')
    if (response.status === 403) throw new Error('ChatGPT account is not permitted to read Codex models.')
    throw new Error(`ChatGPT Codex model endpoint returned HTTP ${response.status}.`)
  }
  const text = await readLimitedResponseText(
    response,
    1024 * 1024,
    'ChatGPT Codex model response is too large.'
  )
  let payload: unknown
  try {
    payload = JSON.parse(text) as unknown
  } catch {
    throw new Error('ChatGPT Codex model endpoint returned invalid JSON.')
  }
  const models = parseChatGptCodexModels(payload)
  if (models.length === 0) throw new Error('ChatGPT Codex model endpoint returned an empty model list.')
  return models
}

function parseChatGptCodexModels(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as Record<string, unknown>).models)) {
    return []
  }
  const models: string[] = []
  const seen = new Set<string>()
  for (const candidate of (payload as { models: unknown[] }).models) {
    if (!candidate || typeof candidate !== 'object') continue
    const record = candidate as Record<string, unknown>
    if (record.visibility === 'hide') continue
    const value = typeof record.slug === 'string'
      ? record.slug.trim()
      : typeof record.id === 'string'
        ? record.id.trim()
        : ''
    if (!value || seen.has(value)) continue
    seen.add(value)
    models.push(value)
  }
  return models
}

export async function queryChatGptCodexQuota(
  bundle: ChatGptCredentialBundle,
  fetchImplementation: typeof fetch = fetch,
  signal?: AbortSignal,
  now = Date.now()
): Promise<{ quota: AccountCodexQuotaSnapshot; latencyMs: number }> {
  const startedAt = Date.now()
  let response: Response
  try {
    response = await fetchImplementation(CHATGPT_CODEX_USAGE_URL, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${bundle.accessToken}`,
        'chatgpt-account-id': bundle.accountId,
        'openai-beta': 'codex-1',
        'oai-language': 'zh-CN',
        originator: 'Codex Desktop',
        accept: 'application/json',
        'sec-fetch-site': 'none',
        'sec-fetch-mode': 'no-cors',
        'sec-fetch-dest': 'empty',
        priority: 'u=4, i'
      },
      signal
    })
  } catch (error) {
    if (isAbortOrTimeout(error)) throw new Error('ChatGPT Codex usage request timed out.')
    throw new Error('ChatGPT Codex usage endpoint could not be reached.')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 401) throw new Error('ChatGPT session access token was rejected.')
    if (response.status === 403) throw new Error('ChatGPT account is not permitted to read Codex usage.')
    throw new Error(`ChatGPT Codex usage endpoint returned HTTP ${response.status}.`)
  }
  const text = await readLimitedResponseText(
    response,
    512 * 1024,
    'ChatGPT Codex usage response is too large.'
  )
  let payload: unknown
  try {
    payload = JSON.parse(text) as unknown
  } catch {
    throw new Error('ChatGPT Codex usage endpoint returned invalid JSON.')
  }
  const quota = extractCodexQuotaFromUsagePayload(payload, now)
  if (!quota) throw new Error('ChatGPT Codex usage endpoint returned no quota windows.')
  return { quota, latencyMs: Math.max(0, Date.now() - startedAt) }
}

async function readLimitedResponseText(
  response: Response,
  maximumBytes: number,
  oversizedMessage: string
): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Buffer[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximumBytes) {
        await reader.cancel()
        throw new Error(oversizedMessage)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}

function isAbortOrTimeout(error: unknown): boolean {
  return error instanceof Error && /abort|timeout/i.test(`${error.name} ${error.message}`)
}

export function classifyChatGptCodexFailure(statusCode: number, headers?: HeadersInit, now = Date.now()): ProviderFailure {
  if (statusCode === 401) return { category: 'authentication', message: 'ChatGPT session access token was rejected.', retryable: true, accountAction: 'disable', statusCode }
  if (statusCode === 403) return { category: 'permission', message: 'ChatGPT account is not permitted to use the Codex endpoint.', retryable: true, accountAction: 'disable', statusCode }
  if (statusCode === 429) {
    const retryAfterMs = parseRetryAfter(headers, now) ?? 30_000
    return { category: 'rate_limit', message: 'ChatGPT account rate limit reached.', retryable: true, accountAction: 'cooldown', statusCode, retryAfterMs, retryAt: now + retryAfterMs }
  }
  return { category: statusCode >= 500 ? 'upstream' : 'invalid_request', message: 'ChatGPT Codex endpoint rejected the request.', retryable: statusCode >= 500, accountAction: statusCode >= 500 ? 'cooldown' : 'none', statusCode }
}

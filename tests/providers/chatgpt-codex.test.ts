import { describe, expect, it, vi } from 'vitest'
import {
  applyChatGptCodexHeaders,
  applyChatGptCodexSearchHeaders,
  CHATGPT_CODEX_MODELS_URL,
  CHATGPT_CODEX_RESPONSES_URL,
  CHATGPT_CODEX_SEARCH_URL,
  CHATGPT_CODEX_USAGE_URL,
  CODEX_CLIENT_VERSION,
  classifyChatGptCodexFailure,
  isChatGptCodexResponsesLiteBody,
  probeChatGptAccount,
  queryChatGptCodexModels,
  queryChatGptCodexQuota,
  refreshChatGptCredential,
  withChatGptCodexBody
} from '../../src/main/providers'
import type { Account } from '../../src/shared/types'

const bundle = { accessToken: 'access-private', refreshToken: 'refresh-private', accountId: 'acct-team', expiresAt: Date.now() + 3600_000 }
const quotaNow = Date.parse('2026-07-12T00:00:00.000Z')

describe('ChatGPT Codex provider path', () => {
  it('keeps every Codex client identity surface on the supported version', async () => {
    const headers = new Headers()
    applyChatGptCodexHeaders(headers, bundle)
    const refreshFetch = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'new-access',
      expires_in: 3600
    }), { status: 200 }))

    await refreshChatGptCredential(bundle, refreshFetch as typeof fetch)

    expect(CODEX_CLIENT_VERSION).toBe('0.144.3')
    expect(new URL(CHATGPT_CODEX_MODELS_URL).searchParams.get('client_version')).toBe(CODEX_CLIENT_VERSION)
    expect(headers.get('user-agent')).toBe(`codex_cli_rs/${CODEX_CLIENT_VERSION} (Windows 11; x86_64)`)
    expect(headers.get('version')).toBe(CODEX_CLIENT_VERSION)
    expect(new Headers(refreshFetch.mock.calls[0][1]?.headers).get('user-agent'))
      .toBe(`codex-cli/${CODEX_CLIENT_VERSION}`)
  })

  it('sets the Codex endpoint contract and forces ephemeral streaming', () => {
    const headers = new Headers()
    applyChatGptCodexHeaders(headers, bundle, {
      authorization: 'Bearer local-route-token',
      'x-api-key': 'local-route-token',
      session_id: 'session-safe',
      'x-codex-turn-state': 'turn-state'
    })
    expect(CHATGPT_CODEX_RESPONSES_URL).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(headers.get('authorization')).toBe('Bearer access-private')
    expect(headers.get('chatgpt-account-id')).toBe('acct-team')
    expect(headers.get('originator')).toBe('codex_cli_rs')
    expect(headers.get('session_id')).toBe('session-safe')
    expect(headers.get('x-codex-turn-state')).toBe('turn-state')
    expect(headers.get('authorization')).not.toContain('local-route-token')
    expect(headers.has('x-api-key')).toBe(false)
    expect(withChatGptCodexBody({ model: 'gpt-5' })).toMatchObject({ store: false, stream: true })
  })

  it('uses the standalone Codex Search contract with JSON headers and current client metadata', () => {
    const headers = new Headers()
    applyChatGptCodexSearchHeaders(headers, bundle, {
      authorization: 'Bearer local-route-token',
      'session-id': 'session-safe',
      'thread-id': 'thread-safe',
      'x-client-request-id': 'request-safe',
      version: '0.145.2'
    })

    expect(CHATGPT_CODEX_SEARCH_URL).toBe('https://chatgpt.com/backend-api/codex/alpha/search')
    expect(Object.fromEntries(headers)).toMatchObject({
      accept: 'application/json',
      authorization: 'Bearer access-private',
      'chatgpt-account-id': 'acct-team',
      'content-type': 'application/json',
      originator: 'codex_cli_rs',
      'session-id': 'session-safe',
      'thread-id': 'thread-safe',
      'x-client-request-id': 'request-safe',
      version: '0.145.2'
    })
    expect(headers.get('user-agent')).toBe('codex_cli_rs/0.145.2 (Windows 11; x86_64)')
    expect(headers.has('openai-beta')).toBe(false)
    expect(headers.get('authorization')).not.toContain('local-route-token')
  })

  it('derives the Codex version from User-Agent and preserves the Responses Lite envelope', () => {
    const headers = new Headers()
    applyChatGptCodexHeaders(headers, bundle, {
      'user-agent': 'codex_cli_rs/0.146.0 (Linux; x86_64)'
    })
    expect(headers.get('version')).toBe('0.146.0')

    const liteBody = {
      model: 'gpt-5.6',
      instructions: 'top-level instructions must be omitted',
      tools: [{ type: 'web_search' }],
      input: [{ type: 'additional_tools', role: 'developer', tools: [] }]
    }
    expect(isChatGptCodexResponsesLiteBody(liteBody)).toBe(true)
    expect(withChatGptCodexBody(liteBody)).toEqual({
      model: 'gpt-5.6',
      input: liteBody.input,
      store: false,
      stream: true
    })
  })

  it('probes with a POST Responses request instead of Platform models', async () => {
    const fetchMock = vi.fn(async () => new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const result = await probeChatGptAccount({ modelAllowlist: [] } as unknown as Account, bundle, fetchMock as typeof fetch)
    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toBe(CHATGPT_CODEX_RESPONSES_URL)
    const init = fetchMock.mock.calls[0][1]!
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toMatchObject({ store: false, stream: true })
  })

  it('discovers visible Codex models with scoped OAuth headers', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      models: [
        { slug: 'gpt-5.4', visibility: 'list' },
        { slug: 'gpt-hidden', visibility: 'hide' },
        { id: 'gpt-id-fallback' },
        { slug: 'gpt-5.4' },
        { slug: '  ' }
      ]
    }), { status: 200 }))

    const models = await queryChatGptCodexModels(bundle, fetchMock as typeof fetch)

    expect(models).toEqual(['gpt-5.4', 'gpt-id-fallback'])
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toBe(CHATGPT_CODEX_MODELS_URL)
    const init = fetchMock.mock.calls[0][1]!
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined()
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBe('Bearer access-private')
    expect(headers.get('chatgpt-account-id')).toBe('acct-team')
    expect(headers.get('accept')).toBe('application/json')
    expect(JSON.stringify(init)).not.toContain('refresh-private')
  })

  it('refreshes OAuth tokens without logging or returning the old secret', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }), { status: 200 }))
    const refreshed = await refreshChatGptCredential(bundle, fetchMock as typeof fetch)
    expect(refreshed).toMatchObject({ accessToken: 'new-access', refreshToken: 'new-refresh', accountId: 'acct-team' })
    const request = fetchMock.mock.calls[0][1]!
    expect(String(request.body)).toContain('refresh_token=refresh-private')
    expect(String(request.body)).toContain('scope=openid+profile+email')
    expect(String(request.body)).not.toContain('offline_access')
    expect(JSON.stringify(refreshed)).not.toContain('refresh-private')
  })

  it('replaces OAuth transport exceptions with fixed errors', async () => {
    const transportError = new Error(`Proxy http://user:${bundle.accessToken}@127.0.0.1 failed`)
    const fetchMock = vi.fn(async () => { throw transportError })

    await expect(refreshChatGptCredential(bundle, fetchMock as typeof fetch))
      .rejects.toThrow('ChatGPT token refresh endpoint could not be reached.')
    await expect(queryChatGptCodexQuota(bundle, fetchMock as typeof fetch))
      .rejects.toThrow('ChatGPT Codex usage endpoint could not be reached.')

    for (const result of await Promise.all([
      refreshChatGptCredential(bundle, fetchMock as typeof fetch).catch((error: unknown) => String(error)),
      queryChatGptCodexQuota(bundle, fetchMock as typeof fetch).catch((error: unknown) => String(error))
    ])) {
      expect(result).not.toContain(bundle.accessToken)
      expect(result).not.toContain(bundle.accountId)
    }
  })

  it('classifies Codex OAuth failures without API-key wording', () => {
    expect(classifyChatGptCodexFailure(401)).toMatchObject({ category: 'authentication', accountAction: 'disable', retryable: true })
    expect(classifyChatGptCodexFailure(402)).toMatchObject({ category: 'quota', accountAction: 'disable', retryable: true })
    expect(classifyChatGptCodexFailure(403).message).toContain('ChatGPT account')
    expect(classifyChatGptCodexFailure(429, { 'retry-after': '2' }, 1_000)).toMatchObject({
      category: 'rate_limit', accountAction: 'cooldown', retryAfterMs: 2_000, retryAt: 3_000
    })
  })

  it('queries WHAM usage with scoped OAuth headers and returns detached quota only', async () => {
    const signal = new AbortController().signal
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 17,
          limit_window_seconds: 18_000,
          reset_after_seconds: 60
        },
        secondary_window: {
          used_percent: 52,
          limit_window_seconds: 604_800,
          reset_after_seconds: 600
        }
      },
      access_token: 'response-secret',
      account_id: 'response-account-private'
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    const result = await queryChatGptCodexQuota(bundle, fetchMock as typeof fetch, signal, quotaNow)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toBe(CHATGPT_CODEX_USAGE_URL)
    const init = fetchMock.mock.calls[0][1]!
    expect(init.method).toBe('GET')
    expect(init.signal).toBe(signal)
    const headers = new Headers(init.headers)
    expect(Object.fromEntries(headers.entries())).toMatchObject({
      accept: 'application/json',
      authorization: 'Bearer access-private',
      'chatgpt-account-id': 'acct-team',
      'oai-language': 'zh-CN',
      'openai-beta': 'codex-1',
      originator: 'Codex Desktop',
      priority: 'u=4, i',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'no-cors',
      'sec-fetch-site': 'none'
    })
    expect(JSON.stringify(init)).not.toContain('refresh-private')
    expect(result).toMatchObject({
      quota: {
        fiveHour: { usedPercent: 17, windowSeconds: 18_000, resetAt: quotaNow + 60_000 },
        sevenDay: { usedPercent: 52, windowSeconds: 604_800, resetAt: quotaNow + 600_000 },
        allowed: true,
        limitReached: false,
        observedAt: quotaNow,
        source: 'usage-endpoint'
      },
      latencyMs: expect.any(Number)
    })
    expect(JSON.stringify(result)).not.toContain('access-private')
    expect(JSON.stringify(result)).not.toContain('acct-team')
    expect(JSON.stringify(result)).not.toContain('response-secret')
    expect(JSON.stringify(result)).not.toContain('response-account-private')
  })

  it.each([
    [401, 'ChatGPT session access token was rejected.'],
    [403, 'ChatGPT account is not permitted to read Codex usage.'],
    [429, 'ChatGPT Codex usage endpoint returned HTTP 429.'],
    [503, 'ChatGPT Codex usage endpoint returned HTTP 503.']
  ])('reports a bounded error for WHAM HTTP %i without leaking its body or credentials', async (status, expectedMessage) => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: `Bearer ${bundle.accessToken}`, account_id: bundle.accountId }),
      { status }
    ))

    const error = await queryChatGptCodexQuota(bundle, fetchMock as typeof fetch, undefined, quotaNow)
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(expectedMessage)
    expect((error as Error).message).not.toContain(bundle.accessToken)
    expect((error as Error).message).not.toContain(bundle.refreshToken)
    expect((error as Error).message).not.toContain(bundle.accountId)
  })

  it('rejects invalid, empty, and oversized WHAM responses with bounded errors', async () => {
    const cases = [
      {
        body: `{"credential":"${bundle.accessToken}"`,
        message: 'ChatGPT Codex usage endpoint returned invalid JSON.'
      },
      {
        body: JSON.stringify({ credential: bundle.accessToken, rate_limit: null }),
        message: 'ChatGPT Codex usage endpoint returned no quota windows.'
      },
      {
        body: JSON.stringify({ padding: bundle.accessToken.repeat(60_000) }),
        message: 'ChatGPT Codex usage response is too large.'
      }
    ]

    for (const testCase of cases) {
      const fetchMock = vi.fn(async () => new Response(testCase.body, { status: 200 }))
      const error = await queryChatGptCodexQuota(bundle, fetchMock as typeof fetch, undefined, quotaNow)
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe(testCase.message)
      expect((error as Error).message).not.toContain(bundle.accessToken)
      expect((error as Error).message).not.toContain(bundle.refreshToken)
      expect((error as Error).message).not.toContain(bundle.accountId)
    }
  })
})

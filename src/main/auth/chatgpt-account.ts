import { createHash } from 'node:crypto'

export interface ChatGptCredentialBundle {
  accessToken: string
  refreshToken?: string
  idToken?: string
  accountId: string
  email?: string
  expiresAt: number
}

export interface ParsedChatGptAccounts {
  accounts: ChatGptCredentialBundle[]
  warnings: string[]
}

export function parseChatGptAccountImport(content: string, now = Date.now()): ParsedChatGptAccounts {
  const trimmed = content.trim()
  if (!trimmed) throw new Error('ChatGPT account import is empty.')
  const values = parseValues(trimmed)
  const accounts: ChatGptCredentialBundle[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const account = parseAccount(value)
    if (account.expiresAt <= now - 30_000) throw new Error('ChatGPT account access token has expired.')
    const key = account.accountId || fingerprint(account.accessToken)
    if (seen.has(key)) continue
    seen.add(key)
    accounts.push(account)
    if (!account.refreshToken) warnings.push(`${account.email ?? maskAccountId(account.accountId)}: no refresh token; the account stops when its access token expires.`)
  }
  if (!accounts.length) throw new Error('No ChatGPT/Codex accounts were found in the import.')
  return { accounts, warnings }
}

export function serializeChatGptCredential(bundle: ChatGptCredentialBundle): string {
  return JSON.stringify(bundle)
}

export function deserializeChatGptCredential(value: string): ChatGptCredentialBundle | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<ChatGptCredentialBundle>
    if (!validString(parsed.accessToken) || !validString(parsed.accountId) || !validTimestamp(parsed.expiresAt)) return undefined
    return {
      accessToken: parsed.accessToken.trim(), accountId: parsed.accountId.trim(), expiresAt: parsed.expiresAt,
      ...(validString(parsed.refreshToken) ? { refreshToken: parsed.refreshToken.trim() } : {}),
      ...(validString(parsed.idToken) ? { idToken: parsed.idToken.trim() } : {}),
      ...(validString(parsed.email) ? { email: parsed.email.trim() } : {})
    }
  } catch {
    return undefined
  }
}

function parseValues(content: string): unknown[] {
  try {
    const parsed = JSON.parse(content) as unknown
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      try { return JSON.parse(line) as unknown } catch { return line }
    })
  }
}

function parseAccount(value: unknown): ChatGptCredentialBundle {
  const object = objectValue(value)
  const accessToken = firstString(object, ['access_token'], ['accessToken'], ['tokens', 'access_token'])
    ?? (typeof value === 'string' ? value.trim() : '')
  if (!accessToken) throw new Error('ChatGPT account is missing access_token.')
  const claims = jwtClaims(accessToken)
  const auth = objectValue(claims?.['https://api.openai.com/auth'])
  const accountId = firstString(object, ['account_id'], ['accountId'], ['account', 'id'], ['chatgpt_account_id'])
    ?? stringValue(auth?.chatgpt_account_id)
  if (!accountId) throw new Error('ChatGPT account is missing account_id.')
  const expiresAt = firstTimestamp(object, ['expired'], ['expires_at'], ['expiresAt'], ['expires'])
    ?? (numberValue(claims?.exp) ? numberValue(claims?.exp)! * 1000 : undefined)
  if (!expiresAt) throw new Error('ChatGPT account expiration could not be determined.')
  const refreshToken = firstString(object, ['refresh_token'], ['refreshToken'], ['tokens', 'refresh_token'])
  const idToken = firstString(object, ['id_token'], ['idToken'], ['tokens', 'id_token'])
  const email = firstString(object, ['email'], ['user', 'email']) ?? stringValue(claims?.email)
  return {
    accessToken, accountId, expiresAt,
    ...(refreshToken ? { refreshToken } : {}),
    ...(idToken ? { idToken } : {}),
    ...(email ? { email } : {})
  }
}

function jwtClaims(token: string): Record<string, unknown> | undefined {
  const segment = token.split('.')[1]
  if (!segment) return undefined
  try { return objectValue(JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))) } catch { return undefined }
}

function firstString(object: Record<string, unknown> | undefined, ...paths: string[][]): string | undefined {
  for (const path of paths) {
    let value: unknown = object
    for (const key of path) value = objectValue(value)?.[key]
    const candidate = stringValue(value)
    if (candidate) return candidate
  }
  return undefined
}

function firstTimestamp(object: Record<string, unknown> | undefined, ...paths: string[][]): number | undefined {
  for (const path of paths) {
    let value: unknown = object
    for (const key of path) value = objectValue(value)?.[key]
    const numeric = numberValue(value)
    if (numeric !== undefined) return numeric > 1_000_000_000_000 ? numeric : numeric * 1000
    const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function validString(value: unknown): value is string { return typeof value === 'string' && Boolean(value.trim()) }
function validTimestamp(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0 }
function fingerprint(value: string): string { return createHash('sha256').update(value).digest('hex') }
function maskAccountId(value: string): string { return value.length <= 4 ? '****' : `****${value.slice(-4)}` }

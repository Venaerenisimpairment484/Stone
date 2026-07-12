import { describe, expect, it } from 'vitest'
import { deserializeChatGptCredential, parseChatGptAccountImport, serializeChatGptCredential } from '../../src/main/auth'

function token(exp: number, accountId = 'acct_claim') {
  return ['header', Buffer.from(JSON.stringify({
    exp,
    email: 'claim@example.com',
    'https://api.openai.com/auth': { chatgpt_account_id: accountId }
  })).toString('base64url'), 'signature'].join('.')
}

describe('ChatGPT account import', () => {
  it('parses the accents export shape without exposing tokens in metadata', () => {
    const expiresAt = Date.now() + 60 * 60 * 1000
    const parsed = parseChatGptAccountImport(JSON.stringify({
      access_token: token(Math.floor(expiresAt / 1000)),
      account_id: 'acct_team_1234',
      email: 'team@example.com',
      expired: new Date(expiresAt).toISOString(),
      refresh_token: ''
    }))
    expect(parsed.accounts[0]).toMatchObject({ accountId: 'acct_team_1234', email: 'team@example.com', expiresAt })
    expect(parsed.warnings).toHaveLength(1)
    expect(JSON.stringify(parsed.warnings)).not.toContain(parsed.accounts[0].accessToken)
  })

  it('extracts account identity and expiry from JWT claims', () => {
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + 3600
    const parsed = parseChatGptAccountImport(token(expiresAtSeconds, 'acct_jwt'))
    expect(parsed.accounts[0]).toMatchObject({ accountId: 'acct_jwt', expiresAt: expiresAtSeconds * 1000 })
    expect(JSON.stringify(parsed.warnings)).not.toContain('acct_jwt')
    expect(parsed.warnings[0]).toContain('claim@example.com')
  })

  it('rejects expired sessions and round-trips valid encrypted payloads', () => {
    expect(() => parseChatGptAccountImport(JSON.stringify({
      access_token: token(1), account_id: 'acct_expired', expired: '2000-01-01T00:00:00Z'
    }))).toThrow(/expired/)
    const bundle = { accessToken: 'secret-access', refreshToken: 'secret-refresh', accountId: 'acct', expiresAt: Date.now() + 1000 }
    expect(deserializeChatGptCredential(serializeChatGptCredential(bundle))).toEqual(bundle)
  })
})

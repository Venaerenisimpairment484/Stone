import { mutateDotenv } from './dotenv-format'
import { mutateJsonObject, objectField, type TextMutation } from './json-format'
import { planCodexToml } from './toml-format'
import type {
  ClientConfigFilePath,
  ClientConfigPlan,
  ClientConnectionTarget,
  ExistingClientConfig,
  PlannedFileMutation,
  ResolvedClientConfigPaths,
  SupportedClient,
} from './types'
import { ClientConfigValidationError } from './types'

function normalizedTarget(target: ClientConnectionTarget): ClientConnectionTarget {
  if (!target.token.trim()) throw new ClientConfigValidationError('A non-empty local access token is required')
  let url: URL
  try {
    url = new URL(target.gatewayBaseUrl)
  } catch {
    throw new ClientConfigValidationError('Gateway base URL is invalid')
  }
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new ClientConfigValidationError('Gateway base URL must be an HTTP(S) origin without credentials, query, or fragment')
  }
  const baseUrl = url.toString().replace(/\/$/, '')
  return { gatewayBaseUrl: baseUrl, token: target.token }
}

function mutation(
  file: ClientConfigFilePath,
  existing: string | undefined,
  result: TextMutation,
  managedFields: string[],
): PlannedFileMutation {
  return {
    ...file,
    content: result.content,
    changed: result.changed,
    existed: existing !== undefined,
    managedFields,
  }
}

export function planClaudeConfig(
  paths: ResolvedClientConfigPaths['claude'],
  existing: ExistingClientConfig,
  target: ClientConnectionTarget,
): ClientConfigPlan {
  const desired = normalizedTarget(target)
  const source = existing['claude-settings']
  const settings = mutateJsonObject(source, 'claude-settings', (root) => {
    const environment = objectField(root, 'env', 'claude-settings')
    environment.ANTHROPIC_BASE_URL = desired.gatewayBaseUrl
    environment.ANTHROPIC_AUTH_TOKEN = desired.token
  })
  return {
    client: 'claude',
    files: [mutation(paths.settings, source, settings, [
      'env.ANTHROPIC_BASE_URL',
      'env.ANTHROPIC_AUTH_TOKEN',
    ])],
  }
}

export function planCodexConfig(
  paths: ResolvedClientConfigPaths['codex'],
  existing: ExistingClientConfig,
  target: ClientConnectionTarget,
): ClientConfigPlan {
  const desired = normalizedTarget(target)
  const configSource = existing['codex-config']
  const authSource = existing['codex-auth']
  const config = planCodexToml(configSource, `${desired.gatewayBaseUrl}/v1`)
  const auth = mutateJsonObject(authSource, 'codex-auth', (root) => {
    root.auth_mode = 'apikey'
    root.OPENAI_API_KEY = desired.token
  })
  return {
    client: 'codex',
    files: [
      mutation(paths.config, configSource, config, [
        'model_provider',
        'cli_auth_credentials_store',
        'model_providers.stone',
      ]),
      mutation(paths.auth, authSource, auth, ['auth_mode', 'OPENAI_API_KEY']),
    ],
  }
}

export function planGeminiConfig(
  paths: ResolvedClientConfigPaths['gemini'],
  existing: ExistingClientConfig,
  target: ClientConnectionTarget,
): ClientConfigPlan {
  const desired = normalizedTarget(target)
  const settingsSource = existing['gemini-settings']
  const envSource = existing['gemini-env']
  const settings = mutateJsonObject(settingsSource, 'gemini-settings', (root) => {
    const security = objectField(root, 'security', 'gemini-settings')
    const auth = objectField(security, 'auth', 'gemini-settings')
    auth.selectedType = 'gemini-api-key'
  })
  const env = mutateDotenv(envSource, {
    GEMINI_API_KEY: desired.token,
    GEMINI_API_KEY_AUTH_MECHANISM: 'bearer',
    GOOGLE_GEMINI_BASE_URL: desired.gatewayBaseUrl,
  })
  return {
    client: 'gemini',
    files: [
      mutation(paths.settings, settingsSource, settings, ['security.auth.selectedType']),
      mutation(paths.env, envSource, env, [
        'GEMINI_API_KEY',
        'GEMINI_API_KEY_AUTH_MECHANISM',
        'GOOGLE_GEMINI_BASE_URL',
      ]),
    ],
  }
}

export function planClientConfig(
  client: SupportedClient,
  paths: ResolvedClientConfigPaths,
  existing: ExistingClientConfig,
  target: ClientConnectionTarget,
): ClientConfigPlan {
  if (client === 'claude') return planClaudeConfig(paths.claude, existing, target)
  if (client === 'codex') return planCodexConfig(paths.codex, existing, target)
  return planGeminiConfig(paths.gemini, existing, target)
}

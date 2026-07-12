export { ClientConfigService } from './service'
export { resolveClientConfigPaths, clientFiles, allClientFiles } from './paths'
export { planClientConfig, planClaudeConfig, planCodexConfig, planGeminiConfig } from './planners'
export { parseJsonObject } from './json-format'
export { mutateDotenv } from './dotenv-format'
export { planCodexToml } from './toml-format'
export type {
  ApplyClientConfigResult,
  BackupRecord,
  ClientConfigApplyOptions,
  ClientConfigFilePath,
  ClientConfigFileRole,
  ClientConfigPathOptions,
  ClientConfigPathOverrides,
  ClientConfigPlan,
  ClientConfigServiceOptions,
  ClientConnectionTarget,
  DetectedClientConfig,
  ExistingClientConfig,
  PlannedFileMutation,
  ResolvedClientConfigPaths,
  RestoreBackupResult,
  SupportedClient,
} from './types'
export { ClientConfigParseError, ClientConfigValidationError } from './types'

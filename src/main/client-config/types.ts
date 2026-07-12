import type {
  ClientConfigEditorField,
  ClientConfigEditorFile,
  ClientConfigFieldPatch,
  ClientConfigFileDraft,
  ClientConfigFileFormat,
  ClientConfigFileRole as SharedClientConfigFileRole,
  RouteClient,
} from '@shared/types'

export type SupportedClient = RouteClient
export type ClientConfigFileRole = SharedClientConfigFileRole
export type ConfigFileFormat = ClientConfigFileFormat

export interface ClientConfigPathOverrides {
  claudeDirectory?: string
  codexDirectory?: string
  geminiDirectory?: string
}

export interface ClientConfigPathOptions {
  homeDir: string
  platform: NodeJS.Platform
  overrides?: ClientConfigPathOverrides
}

export interface ClientConfigFilePath {
  client: SupportedClient
  role: ClientConfigFileRole
  format: ConfigFileFormat
  path: string
  containsCredential: boolean
}

export interface ResolvedClientConfigPaths {
  claude: {
    directory: string
    settings: ClientConfigFilePath
    mcp?: ClientConfigFilePath
  }
  codex: {
    directory: string
    config: ClientConfigFilePath
    auth: ClientConfigFilePath
  }
  gemini: {
    directory: string
    settings: ClientConfigFilePath
    env: ClientConfigFilePath
  }
}

export interface ClientConnectionTarget {
  gatewayBaseUrl: string
  token: string
}

export type ExistingClientConfig = Partial<Record<ClientConfigFileRole, string>>

export interface PlannedFileMutation extends ClientConfigFilePath {
  content: string
  changed: boolean
  existed: boolean
  managedFields: string[]
}

export interface ClientConfigPlan {
  client: SupportedClient
  files: PlannedFileMutation[]
}

export interface DetectedConfigFile extends ClientConfigFilePath {
  exists: boolean
  size?: number
  modifiedAt?: number
}

export interface DetectedClientConfig {
  client: SupportedClient
  directory: string
  directoryExists: boolean
  configured: boolean
  files: DetectedConfigFile[]
}

export interface BackupRecord {
  client: SupportedClient
  role: ClientConfigFileRole
  targetPath: string
  backupPath: string
  createdAt: number
  size: number
}

export interface ApplyClientConfigResult {
  client: SupportedClient
  changedFiles: string[]
  backups: BackupRecord[]
  removedBackups: string[]
  retentionWarning?: string
}

export interface ClientConfigApplyOptions {
  backupRetention?: number
}

export interface ClientConfigEditorSnapshot {
  client: SupportedClient
  fields: ClientConfigEditorField[]
  files: ClientConfigEditorFile[]
}

export interface ClientConfigEditorChanges {
  patches: ClientConfigFieldPatch[]
  files: ClientConfigFileDraft[]
}

export interface RestoreBackupResult {
  client: SupportedClient
  role: ClientConfigFileRole
  restoredFile: string
  sourceBackup: string
  safetyBackup?: BackupRecord
}

export interface ClientConfigServiceOptions extends ClientConfigPathOptions {
  now?: () => Date
  randomId?: () => string
}

export class ClientConfigParseError extends Error {
  readonly role: ClientConfigFileRole

  constructor(role: ClientConfigFileRole, detail: string) {
    super(`Cannot parse ${role}: ${detail}`)
    this.name = 'ClientConfigParseError'
    this.role = role
  }
}

export class ClientConfigValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClientConfigValidationError'
  }
}

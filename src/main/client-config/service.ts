import { readdir, readFile, rm } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { allClientFiles, clientDirectory, clientFiles, resolveClientConfigPaths } from './paths'
import { planClientConfig } from './planners'
import { applyClientConfigFieldPatches, clientConfigEditorFields } from './catalog'
import { createClientConfigEditorFile, restoreClientConfigEditorContent, revisionOf } from './editor'
import { atomicWriteFile, copyExclusive, pathStat, readTextIfPresent } from './filesystem'
import type {
  ApplyClientConfigResult,
  BackupRecord,
  ClientConfigApplyOptions,
  ClientConfigEditorChanges,
  ClientConfigEditorSnapshot,
  ClientConfigFilePath,
  ClientConfigPlan,
  ClientConfigPathOverrides,
  ClientConfigServiceOptions,
  ClientConnectionTarget,
  DetectedClientConfig,
  ExistingClientConfig,
  ResolvedClientConfigPaths,
  RestoreBackupResult,
  SupportedClient,
} from './types'
import { ClientConfigValidationError } from './types'

const backupMarker = '.stone-backup.'
const timestampPattern = /^(\d{8}T\d{9}Z)(?:\.(\d+))?$/

function timestampForFile(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, '')
}

function dateFromTimestamp(value: string): number | undefined {
  const match = timestampPattern.exec(value)
  if (!match) return undefined
  const timestamp = match[1]
  const iso = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T${timestamp.slice(9, 11)}:${timestamp.slice(11, 13)}:${timestamp.slice(13, 15)}.${timestamp.slice(15, 18)}Z`
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? undefined : parsed
}

function defaultRandomId() {
  return crypto.randomUUID().slice(0, 12)
}

export class ClientConfigService {
  readonly paths: ResolvedClientConfigPaths
  private readonly now: () => Date
  private readonly randomId: () => string
  private readonly platform: NodeJS.Platform
  private readonly options: ClientConfigServiceOptions

  constructor(options: ClientConfigServiceOptions) {
    this.options = options
    this.paths = resolveClientConfigPaths(options)
    this.now = options.now ?? (() => new Date())
    this.randomId = options.randomId ?? defaultRandomId
    this.platform = options.platform
  }

  withOverrides(overrides: ClientConfigPathOverrides): ClientConfigService {
    return new ClientConfigService({
      ...this.options,
      overrides: { ...this.options.overrides, ...overrides },
    })
  }

  async detect(client?: SupportedClient): Promise<DetectedClientConfig[]> {
    const clients: SupportedClient[] = client ? [client] : ['claude', 'codex', 'gemini']
    return Promise.all(clients.map(async (candidate) => {
      const directory = clientDirectory(this.paths, candidate)
      const directoryInfo = await pathStat(directory)
      const files = await Promise.all(clientFiles(this.paths, candidate).map(async (file) => {
        const info = await pathStat(file.path)
        return {
          ...file,
          exists: info?.isFile() ?? false,
          size: info?.isFile() ? info.size : undefined,
          modifiedAt: info?.isFile() ? info.mtimeMs : undefined,
        }
      }))
      return {
        client: candidate,
        directory,
        directoryExists: directoryInfo?.isDirectory() ?? false,
        configured: files.some((file) => file.exists),
        files,
      }
    }))
  }

  async plan(client: SupportedClient, target: ClientConnectionTarget) {
    const existing = await this.readExisting(client)
    return planClientConfig(client, this.paths, existing, target)
  }

  async editor(client: SupportedClient): Promise<ClientConfigEditorSnapshot> {
    const existing = await this.readExisting(client)
    return {
      client,
      fields: clientConfigEditorFields(client, existing),
      files: clientFiles(this.paths, client).map((file) => (
        createClientConfigEditorFile(file, existing[file.role])
      )),
    }
  }

  async applyEditor(
    client: SupportedClient,
    target: ClientConnectionTarget,
    changes: ClientConfigEditorChanges,
    options: ClientConfigApplyOptions = {},
  ): Promise<ApplyClientConfigResult> {
    if (changes.files.length > 5) throw new ClientConfigValidationError('Too many client configuration files were submitted')
    const files = clientFiles(this.paths, client)
    const fileByRole = new Map(files.map((file) => [file.role, file]))
    const existing = await this.readExisting(client)
    const edited: ExistingClientConfig = { ...existing }
    const submitted = new Set<ClientConfigFilePath['role']>()
    for (const draft of changes.files) {
      if (submitted.has(draft.role)) throw new ClientConfigValidationError('A client configuration file was submitted more than once')
      submitted.add(draft.role)
      const file = fileByRole.get(draft.role)
      if (!file) throw new ClientConfigValidationError('A client configuration file does not belong to the selected client')
      const source = existing[file.role]
      if (draft.revision !== revisionOf(source)) {
        throw new ClientConfigValidationError('Client configuration changed outside Stone. Reload it before saving.')
      }
      edited[file.role] = restoreClientConfigEditorContent(file, draft.content, source)
    }
    const patched = applyClientConfigFieldPatches(client, edited, changes.patches)
    const connectionPlan = planClientConfig(client, this.paths, patched, target)
    const plannedRoles = new Set(connectionPlan.files.map((file) => file.role))
    const plan: ClientConfigPlan = {
      client,
      files: [
        ...connectionPlan.files.map((file) => ({
          ...file,
          changed: file.content !== existing[file.role],
          existed: existing[file.role] !== undefined,
        })),
        ...files.filter((file) => !plannedRoles.has(file.role) && patched[file.role] !== existing[file.role]).map((file) => ({
          ...file,
          content: patched[file.role] ?? '',
          changed: true,
          existed: existing[file.role] !== undefined,
          managedFields: ['complete document'],
        })),
      ],
    }
    return this.applyPlan(client, plan, options)
  }

  async apply(
    client: SupportedClient,
    target: ClientConnectionTarget,
    options: ClientConfigApplyOptions = {},
  ): Promise<ApplyClientConfigResult> {
    const plan = await this.plan(client, target)
    return this.applyPlan(client, plan, options)
  }

  private async applyPlan(
    client: SupportedClient,
    plan: ClientConfigPlan,
    options: ClientConfigApplyOptions,
  ): Promise<ApplyClientConfigResult> {
    const changes = plan.files.filter((file) => file.changed)
    const backups: BackupRecord[] = []
    for (const change of changes) {
      const backup = await this.backupFile(change)
      if (backup) backups.push(backup)
    }

    const written: ClientConfigFilePath[] = []
    try {
      for (const change of changes) {
        await atomicWriteFile(change.path, change.content, this.randomId, change.containsCredential)
        written.push(change)
      }
    } catch (error) {
      await this.rollback(written, backups)
      throw error
    }

    let removedBackups: string[] = []
    let retentionWarning: string | undefined
    if (options.backupRetention !== undefined) {
      try {
        removedBackups = await this.pruneBackups(client, options.backupRetention)
      } catch {
        retentionWarning = 'Client configuration was applied, but old backups could not be pruned.'
      }
    }

    return {
      client,
      changedFiles: changes.map((file) => file.path),
      backups,
      removedBackups,
      ...(retentionWarning ? { retentionWarning } : {}),
    }
  }

  private async readExisting(client: SupportedClient): Promise<ExistingClientConfig> {
    const existing: ExistingClientConfig = {}
    await Promise.all(clientFiles(this.paths, client).map(async (file) => {
      const content = await readTextIfPresent(file.path)
      if (content !== undefined) existing[file.role] = content
    }))
    return existing
  }

  async pruneBackups(client: SupportedClient, retention: number): Promise<string[]> {
    if (!Number.isInteger(retention) || retention < 1 || retention > 100) {
      throw new ClientConfigValidationError('Backup retention must be between 1 and 100 per file')
    }
    const backups = await this.listBackups(client)
    const retainedByRole = new Map<ClientConfigFilePath['role'], number>()
    const removed: string[] = []
    for (const backup of backups) {
      const retained = retainedByRole.get(backup.role) ?? 0
      if (retained < retention) {
        retainedByRole.set(backup.role, retained + 1)
        continue
      }
      await rm(backup.backupPath)
      removed.push(backup.backupPath)
    }
    return removed
  }

  async listBackups(client?: SupportedClient): Promise<BackupRecord[]> {
    const eligibleFiles = client ? clientFiles(this.paths, client) : allClientFiles(this.paths)
    const records = (await Promise.all(eligibleFiles.map((file) => this.backupsForFile(file)))).flat()
    return records.sort((left, right) =>
      right.createdAt - left.createdAt
      || backupSequence(right.backupPath) - backupSequence(left.backupPath)
      || right.backupPath.localeCompare(left.backupPath))
  }

  async restore(backupPath: string, client?: SupportedClient): Promise<RestoreBackupResult> {
    const normalized = this.normalizedPath(backupPath)
    const record = (await this.listBackups(client)).find((candidate) =>
      this.normalizedPath(candidate.backupPath) === normalized)
    if (!record) throw new Error('Backup is not managed by this client configuration service')

    const eligibleFiles = client ? clientFiles(this.paths, client) : allClientFiles(this.paths)
    const file = eligibleFiles.find((candidate) =>
      candidate.client === record.client && candidate.role === record.role)
    if (!file) throw new Error('Backup target is no longer configured')
    const safetyBackup = await this.backupFile(file)
    const content = await readFile(record.backupPath)
    await atomicWriteFile(record.targetPath, content, this.randomId, file.containsCredential)
    return {
      client: record.client,
      role: record.role,
      restoredFile: record.targetPath,
      sourceBackup: record.backupPath,
      safetyBackup,
    }
  }

  private normalizedPath(path: string): string {
    const normalized = resolve(path)
    return this.platform === 'win32' ? normalized.toLowerCase() : normalized
  }

  private async backupFile(file: ClientConfigFilePath): Promise<BackupRecord | undefined> {
    const info = await pathStat(file.path)
    if (!info?.isFile()) return undefined
    const stamp = timestampForFile(this.now())
    let suffix = 0
    while (suffix < 1000) {
      const collisionSuffix = suffix === 0 ? '' : `.${suffix}`
      const backupPath = `${file.path}${backupMarker}${stamp}${collisionSuffix}`
      try {
        await copyExclusive(file.path, backupPath)
        const backupInfo = await pathStat(backupPath)
        return {
          client: file.client,
          role: file.role,
          targetPath: file.path,
          backupPath,
          createdAt: this.now().getTime(),
          size: backupInfo?.size ?? info.size,
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        suffix += 1
      }
    }
    throw new Error(`Unable to create a unique backup for ${basename(file.path)}`)
  }

  private async backupsForFile(file: ClientConfigFilePath): Promise<BackupRecord[]> {
    let entries
    try {
      entries = await readdir(dirname(file.path), { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const prefix = `${basename(file.path)}${backupMarker}`
    const records: BackupRecord[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix)) continue
      const createdAt = dateFromTimestamp(entry.name.slice(prefix.length))
      if (createdAt === undefined) continue
      const backupPath = resolve(dirname(file.path), entry.name)
      const info = await pathStat(backupPath)
      if (!info) continue
      records.push({
        client: file.client,
        role: file.role,
        targetPath: file.path,
        backupPath,
        createdAt,
        size: info.size,
      })
    }
    return records
  }

  private async rollback(written: ClientConfigFilePath[], backups: BackupRecord[]): Promise<void> {
    for (const file of [...written].reverse()) {
      const backup = backups.find((candidate) => candidate.role === file.role)
      if (backup) {
        const content = await readFile(backup.backupPath)
        await atomicWriteFile(file.path, content, this.randomId, file.containsCredential).catch(() => undefined)
      } else {
        await rm(file.path, { force: true }).catch(() => undefined)
      }
    }
  }
}

function backupSequence(path: string): number {
  const match = /\.stone-backup\.\d{8}T\d{9}Z(?:\.(\d+))?$/.exec(path)
  return match?.[1] ? Number(match[1]) : 0
}

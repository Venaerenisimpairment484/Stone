import type {
  ClientConfigEditorField,
  ClientConfigFieldControl,
  ClientConfigFieldOption,
  ClientConfigFieldPatch,
  ClientConfigFieldValue,
} from '@shared/types'
import { mutateJsonObject, objectField, parseJsonObject, type JsonObject } from './json-format'
import { parseCodexToml, patchCodexTomlTopLevel } from './toml-format'
import type { ClientConfigFileRole, ExistingClientConfig, SupportedClient } from './types'
import { ClientConfigValidationError } from './types'

interface FieldDefinition {
  id: string
  client: SupportedClient
  role: ClientConfigFileRole
  path: string[]
  section: string
  label: string
  control: ClientConfigFieldControl
  options?: ClientConfigFieldOption[]
  placeholder?: string
}

const option = (value: string, label: string): ClientConfigFieldOption => ({ value, label })

const fields: readonly FieldDefinition[] = Object.freeze([
  { id: 'claude.model', client: 'claude', role: 'claude-settings', path: ['model'], section: '模型', label: '默认模型', control: 'text', placeholder: '使用客户端默认模型' },
  { id: 'claude.effort', client: 'claude', role: 'claude-settings', path: ['effortLevel'], section: '模型', label: '推理强度', control: 'select', options: [option('low', '低'), option('medium', '中'), option('high', '高'), option('xhigh', '最高')] },
  { id: 'claude.permissionMode', client: 'claude', role: 'claude-settings', path: ['permissions', 'defaultMode'], section: '权限', label: '默认权限模式', control: 'select', options: [option('default', '默认'), option('acceptEdits', '自动接受编辑'), option('plan', '计划模式'), option('dontAsk', '不询问'), option('bypassPermissions', '跳过权限'), option('auto', '自动')] },
  { id: 'claude.permissionsAllow', client: 'claude', role: 'claude-settings', path: ['permissions', 'allow'], section: '权限', label: '允许规则', control: 'string-list' },
  { id: 'claude.permissionsAsk', client: 'claude', role: 'claude-settings', path: ['permissions', 'ask'], section: '权限', label: '询问规则', control: 'string-list' },
  { id: 'claude.permissionsDeny', client: 'claude', role: 'claude-settings', path: ['permissions', 'deny'], section: '权限', label: '拒绝规则', control: 'string-list' },

  { id: 'codex.model', client: 'codex', role: 'codex-config', path: ['model'], section: '模型', label: '默认模型', control: 'text', placeholder: '使用客户端默认模型' },
  { id: 'codex.reasoningEffort', client: 'codex', role: 'codex-config', path: ['model_reasoning_effort'], section: '模型', label: '推理强度', control: 'select', options: [option('none', '无'), option('minimal', '最小'), option('low', '低'), option('medium', '中'), option('high', '高'), option('xhigh', '最高')] },
  { id: 'codex.approvalPolicy', client: 'codex', role: 'codex-config', path: ['approval_policy'], section: '权限', label: '审批策略', control: 'select', options: [option('untrusted', '仅可信命令免确认'), option('on-request', '按需确认'), option('never', '从不确认')] },
  { id: 'codex.sandboxMode', client: 'codex', role: 'codex-config', path: ['sandbox_mode'], section: '权限', label: '沙箱模式', control: 'select', options: [option('read-only', '只读'), option('workspace-write', '工作区可写'), option('danger-full-access', '完全访问')] },
  { id: 'codex.webSearch', client: 'codex', role: 'codex-config', path: ['web_search'], section: '工具', label: '网页搜索', control: 'select', options: [option('disabled', '关闭'), option('cached', '缓存索引'), option('indexed', '受控联网'), option('live', '实时联网')] },
  { id: 'codex.personality', client: 'codex', role: 'codex-config', path: ['personality'], section: '体验', label: '交流风格', control: 'select', options: [option('none', '无偏好'), option('friendly', '友好'), option('pragmatic', '务实')] },

  { id: 'gemini.model', client: 'gemini', role: 'gemini-settings', path: ['model', 'name'], section: '模型', label: '默认模型', control: 'text', placeholder: '使用客户端默认模型' },
  { id: 'gemini.approvalMode', client: 'gemini', role: 'gemini-settings', path: ['general', 'defaultApprovalMode'], section: '权限', label: '默认审批模式', control: 'select', options: [option('default', '默认'), option('auto_edit', '自动编辑'), option('plan', '计划模式')] },
  { id: 'gemini.allowedTools', client: 'gemini', role: 'gemini-settings', path: ['tools', 'allowed'], section: '工具', label: '允许工具', control: 'string-list' },
  { id: 'gemini.excludedTools', client: 'gemini', role: 'gemini-settings', path: ['tools', 'exclude'], section: '工具', label: '排除工具', control: 'string-list' },
  { id: 'gemini.theme', client: 'gemini', role: 'gemini-settings', path: ['ui', 'theme'], section: '体验', label: '界面主题', control: 'text', placeholder: '使用客户端默认主题' },
  { id: 'gemini.writeTodos', client: 'gemini', role: 'gemini-settings', path: ['useWriteTodos'], section: '体验', label: '任务清单工具', control: 'toggle' },
])

export function clientConfigEditorFields(
  client: SupportedClient,
  existing: ExistingClientConfig,
): ClientConfigEditorField[] {
  const documents = new Map<ClientConfigFileRole, JsonObject>()
  return definitionsFor(client).map((definition) => {
    let root = documents.get(definition.role)
    if (!root) {
      const source = existing[definition.role]
      root = definition.role === 'codex-config'
        ? parseCodexToml(source ?? '')
        : parseJsonObject(source, definition.role)
      documents.set(definition.role, root)
    }
    return {
      id: definition.id,
      section: definition.section,
      label: definition.label,
      control: definition.control,
      value: normalizedValue(valueAt(root, definition.path), definition.control),
      ...(definition.options ? { options: definition.options } : {}),
      ...(definition.placeholder ? { placeholder: definition.placeholder } : {}),
    }
  })
}

export function applyClientConfigFieldPatches(
  client: SupportedClient,
  existing: ExistingClientConfig,
  patches: ClientConfigFieldPatch[],
): ExistingClientConfig {
  if (patches.length > 50) throw new ClientConfigValidationError('Too many client configuration fields were submitted')
  const definitions = new Map(definitionsFor(client).map((definition) => [definition.id, definition]))
  const seen = new Set<string>()
  const result = { ...existing }
  const grouped = new Map<ClientConfigFileRole, Array<{ definition: FieldDefinition; value: ClientConfigFieldValue }>>()
  for (const patch of patches) {
    if (seen.has(patch.id)) throw new ClientConfigValidationError('A client configuration field was submitted more than once')
    seen.add(patch.id)
    const definition = definitions.get(patch.id)
    if (!definition) throw new ClientConfigValidationError('Unknown client configuration field')
    const value = validateValue(definition, patch.value)
    const values = grouped.get(definition.role) ?? []
    values.push({ definition, value })
    grouped.set(definition.role, values)
  }

  for (const [role, values] of grouped) {
    if (role === 'codex-config') {
      const tomlPatches: Record<string, string | boolean | number | string[] | null> = {}
      for (const { definition, value } of values) tomlPatches[definition.path[0]] = value
      result[role] = patchCodexTomlTopLevel(result[role], tomlPatches).content
      continue
    }
    result[role] = mutateJsonObject(result[role], role, (root) => {
      for (const { definition, value } of values) setJsonPath(root, definition.path, value, role)
    }).content
  }
  return result
}

function definitionsFor(client: SupportedClient): FieldDefinition[] {
  return fields.filter((field) => field.client === client)
}

function valueAt(root: JsonObject, path: string[]): unknown {
  let current: unknown = root
  for (const part of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as JsonObject)[part]
  }
  return current
}

function normalizedValue(value: unknown, control: ClientConfigFieldControl): ClientConfigFieldValue {
  if (control === 'toggle') return typeof value === 'boolean' ? value : null
  if (control === 'string-list') {
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null
  }
  return typeof value === 'string' ? value : null
}

function validateValue(definition: FieldDefinition, value: ClientConfigFieldValue): ClientConfigFieldValue {
  if (value === null) return null
  if (definition.control === 'toggle') {
    if (typeof value !== 'boolean') throw new ClientConfigValidationError('A toggle client setting must be true or false')
    return value
  }
  if (definition.control === 'string-list') {
    if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== 'string' || item.length > 500)) {
      throw new ClientConfigValidationError('A client setting list is invalid')
    }
    return value.map((item) => item.trim()).filter(Boolean)
  }
  if (typeof value !== 'string' || value.length > 500) throw new ClientConfigValidationError('A client setting value is invalid')
  if (definition.control === 'select' && !definition.options?.some((candidate) => candidate.value === value)) {
    throw new ClientConfigValidationError('A client setting option is invalid')
  }
  return value
}

function setJsonPath(
  root: JsonObject,
  path: string[],
  value: ClientConfigFieldValue,
  role: ClientConfigFileRole,
): void {
  let parent = root
  for (const part of path.slice(0, -1)) parent = objectField(parent, part, role)
  const key = path.at(-1)
  if (!key) throw new ClientConfigValidationError('A client setting path is invalid')
  if (value === null) delete parent[key]
  else parent[key] = value
}

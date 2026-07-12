import { describe, expect, it } from 'vitest'
import {
  applyClientConfigFieldPatches,
  clientConfigEditorFields,
} from '../../src/main/client-config/catalog'
import { parseCodexToml } from '../../src/main/client-config/toml-format'
import { ClientConfigParseError, ClientConfigValidationError } from '../../src/main/client-config/types'

function valuesFor(client: 'claude' | 'codex' | 'gemini', existing: Record<string, string>) {
  return Object.fromEntries(clientConfigEditorFields(client, existing).map((field) => [field.id, field.value]))
}

describe('client configuration field catalog', () => {
  it('extracts and patches Claude fields while preserving unknown JSON and removing null fields', () => {
    const existing = {
      'claude-settings': JSON.stringify({
        model: 'claude-existing',
        effortLevel: 'medium',
        permissions: {
          defaultMode: 'plan',
          allow: ['Read'],
          ask: ['Bash'],
          deny: ['Write'],
          futureOption: { keep: true },
        },
        unknownTopLevel: { keep: 'yes' },
      }, null, 2) + '\n',
    }

    expect(valuesFor('claude', existing)).toEqual({
      'claude.model': 'claude-existing',
      'claude.effort': 'medium',
      'claude.permissionMode': 'plan',
      'claude.permissionsAllow': ['Read'],
      'claude.permissionsAsk': ['Bash'],
      'claude.permissionsDeny': ['Write'],
    })

    const patched = applyClientConfigFieldPatches('claude', existing, [
      { id: 'claude.model', value: 'claude-updated' },
      { id: 'claude.permissionsAllow', value: [' Read ', '', 'Bash'] },
      { id: 'claude.permissionsAsk', value: null },
    ])
    const result = JSON.parse(patched['claude-settings']!)

    expect(result.model).toBe('claude-updated')
    expect(result.permissions.allow).toEqual(['Read', 'Bash'])
    expect(result.permissions).not.toHaveProperty('ask')
    expect(result.permissions.futureOption).toEqual({ keep: true })
    expect(result.unknownTopLevel).toEqual({ keep: 'yes' })
  })

  it('extracts and patches Codex fields while preserving unknown TOML and removing null fields', () => {
    const existing = {
      'codex-config': [
        'model = "gpt-existing"',
        'model_reasoning_effort = "high"',
        'approval_policy = "on-request"',
        'sandbox_mode = "workspace-write"',
        'web_search = "live"',
        'personality = "friendly"',
        'future_option = "keep" # unknown top-level field',
        '',
        '[features]',
        'parallel = true # unknown section',
        '',
      ].join('\n'),
    }

    expect(valuesFor('codex', existing)).toEqual({
      'codex.model': 'gpt-existing',
      'codex.reasoningEffort': 'high',
      'codex.approvalPolicy': 'on-request',
      'codex.sandboxMode': 'workspace-write',
      'codex.webSearch': 'live',
      'codex.personality': 'friendly',
    })

    const patched = applyClientConfigFieldPatches('codex', existing, [
      { id: 'codex.model', value: 'gpt-updated' },
      { id: 'codex.approvalPolicy', value: 'never' },
      { id: 'codex.reasoningEffort', value: null },
    ])
    const content = patched['codex-config']!
    const result = parseCodexToml(content)

    expect(result.model).toBe('gpt-updated')
    expect(result.approval_policy).toBe('never')
    expect(result).not.toHaveProperty('model_reasoning_effort')
    expect(result.future_option).toBe('keep')
    expect(result.features).toEqual({ parallel: true })
    expect(content).toContain('future_option = "keep" # unknown top-level field')
    expect(content).toContain('parallel = true # unknown section')
  })

  it('extracts and patches Gemini fields while preserving unknown JSON and removing null fields', () => {
    const existing = {
      'gemini-settings': JSON.stringify({
        model: { name: 'gemini-existing', futureOption: 'keep-model-option' },
        general: { defaultApprovalMode: 'plan', futureOption: true },
        tools: { allowed: ['read_file'], exclude: ['shell'], futureOption: ['keep'] },
        ui: { theme: 'Dracula', density: 'compact' },
        useWriteTodos: true,
        unknownTopLevel: { keep: 42 },
      }, null, 2) + '\n',
    }

    expect(valuesFor('gemini', existing)).toEqual({
      'gemini.model': 'gemini-existing',
      'gemini.approvalMode': 'plan',
      'gemini.allowedTools': ['read_file'],
      'gemini.excludedTools': ['shell'],
      'gemini.theme': 'Dracula',
      'gemini.writeTodos': true,
    })

    const patched = applyClientConfigFieldPatches('gemini', existing, [
      { id: 'gemini.model', value: 'gemini-updated' },
      { id: 'gemini.allowedTools', value: [' read_file ', 'write_file'] },
      { id: 'gemini.excludedTools', value: null },
      { id: 'gemini.writeTodos', value: false },
    ])
    const result = JSON.parse(patched['gemini-settings']!)

    expect(result.model).toEqual({ name: 'gemini-updated', futureOption: 'keep-model-option' })
    expect(result.tools.allowed).toEqual(['read_file', 'write_file'])
    expect(result.tools).not.toHaveProperty('exclude')
    expect(result.tools.futureOption).toEqual(['keep'])
    expect(result.useWriteTodos).toBe(false)
    expect(result.unknownTopLevel).toEqual({ keep: 42 })
  })

  it('rejects unknown, duplicate, malformed, and structurally unsafe field patches', () => {
    expect(() => applyClientConfigFieldPatches('claude', {}, [
      { id: 'claude.unknown', value: 'value' },
    ])).toThrow(ClientConfigValidationError)

    expect(() => applyClientConfigFieldPatches('claude', {}, [
      { id: 'claude.model', value: 'first' },
      { id: 'claude.model', value: 'second' },
    ])).toThrow('more than once')

    expect(() => applyClientConfigFieldPatches('codex', {}, [
      { id: 'codex.sandboxMode', value: 'unconfined' },
    ])).toThrow('option is invalid')

    expect(() => applyClientConfigFieldPatches('gemini', {}, [
      { id: 'gemini.writeTodos', value: 'yes' },
    ])).toThrow('must be true or false')

    expect(() => applyClientConfigFieldPatches('claude', {}, [
      { id: 'claude.permissionsAllow', value: ['Read', 42] as never },
    ])).toThrow('list is invalid')

    expect(() => applyClientConfigFieldPatches('gemini', {
      'gemini-settings': '{"model":"owned-by-newer-client"}\n',
    }, [
      { id: 'gemini.model', value: 'gemini-updated' },
    ])).toThrow(ClientConfigParseError)
  })
})

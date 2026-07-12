import type { ProviderPreset } from '@shared/types'

export const providerPresets: readonly ProviderPreset[] = Object.freeze([
  { id: 'openai', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', protocol: 'openai-responses', models: ['gpt-5.4', 'gpt-5.3-codex', 'gpt-5-mini'] },
  { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', protocol: 'anthropic-messages', models: ['claude-sonnet-4-5', 'claude-opus-4-1'] },
  { id: 'gemini', name: 'Google Gemini', kind: 'google', baseUrl: 'https://generativelanguage.googleapis.com', protocol: 'gemini', models: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', protocol: 'openai-chat', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'moonshot', name: 'Moonshot AI', kind: 'openai-compatible', baseUrl: 'https://api.moonshot.cn/v1', protocol: 'openai-chat', models: ['kimi-k2.5'] },
  { id: 'siliconflow', name: 'SiliconFlow', kind: 'openai-compatible', baseUrl: 'https://api.siliconflow.cn/v1', protocol: 'openai-chat', models: [] },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai-chat', models: [] }
])

export function getProviderPreset(id: string): ProviderPreset | undefined {
  return providerPresets.find((preset) => preset.id === id)
}

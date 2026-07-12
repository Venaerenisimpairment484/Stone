import type { AccountModelTestResult } from '@shared/types'

export type ModelTestState =
  | { status: 'testing' }
  | { status: 'success'; latencyMs: number; statusCode?: number; responsePreview?: string }
  | { status: 'failure'; message: string; latencyMs?: number; statusCode?: number }

export function modelTestCompleted(result: AccountModelTestResult): ModelTestState {
  if (result.ok) {
    return {
      status: 'success',
      latencyMs: result.latencyMs,
      statusCode: result.statusCode,
      responsePreview: result.responsePreview,
    }
  }
  return {
    status: 'failure',
    message: result.responsePreview || '模型未返回有效响应',
    latencyMs: result.latencyMs,
    statusCode: result.statusCode,
  }
}

export function modelTestFailed(cause: unknown): ModelTestState {
  return {
    status: 'failure',
    message: cause instanceof Error ? cause.message : '模型测试失败',
  }
}

export function modelTestTitle(model: string, state?: ModelTestState): string {
  if (!state) return `测试模型 ${model}`
  if (state.status === 'testing') return `正在测试 ${model}`
  if (state.status === 'success') {
    const status = state.statusCode ? ` · HTTP ${state.statusCode}` : ''
    const preview = state.responsePreview ? ` · ${state.responsePreview}` : ''
    return `${model} 可用 · ${state.latencyMs} ms${status}${preview}`
  }
  const latency = state.latencyMs === undefined ? '' : ` · ${state.latencyMs} ms`
  const status = state.statusCode ? ` · HTTP ${state.statusCode}` : ''
  return `${model} 不可用${latency}${status} · ${state.message}`
}

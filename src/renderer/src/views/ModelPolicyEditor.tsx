import { useMemo, useState } from 'react'
import { AlertTriangle, Check, CheckCircle2, LoaderCircle, Play, RefreshCw, Search, XCircle } from 'lucide-react'
import type { AccountModelTestResult, ModelPolicy } from '@shared/types'
import { Badge, relativeTime } from '../ui'
import { normalizeModelNames } from '../model-policy'
import { modelTestCompleted, modelTestFailed, modelTestTitle, type ModelTestState } from '../model-test-state'

export interface ModelPolicyOption {
  model: string
  supportCount?: number
  totalAccounts?: number
}

export function ModelPolicyEditor({
  title,
  description,
  policy,
  selectedModels,
  options,
  onPolicyChange,
  onSelectedModelsChange,
  onRefresh,
  onTestModel,
  testDisabledReason,
  refreshing = false,
  refreshDisabledReason,
  refreshedAt,
  catalogNotice,
  emptyMessage = '尚无可用模型。',
  emptySelectionMessage = '当前明确不开放任何模型。',
}: {
  title: string
  description: string
  policy: ModelPolicy
  selectedModels: string[]
  options: ModelPolicyOption[]
  onPolicyChange: (policy: ModelPolicy) => void
  onSelectedModelsChange: (models: string[]) => void
  onRefresh?: () => void
  onTestModel?: (model: string) => Promise<AccountModelTestResult>
  testDisabledReason?: string
  refreshing?: boolean
  refreshDisabledReason?: string
  refreshedAt?: number
  catalogNotice?: string
  emptyMessage?: string
  emptySelectionMessage?: string
}) {
  const [query, setQuery] = useState('')
  const [manualModel, setManualModel] = useState('')
  const [testStates, setTestStates] = useState<Record<string, ModelTestState>>({})
  const selected = useMemo(() => new Set(selectedModels), [selectedModels])
  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    if (!normalizedQuery) return options
    return options.filter((option) => option.model.toLocaleLowerCase().includes(normalizedQuery))
  }, [options, query])

  const toggleModel = (model: string) => {
    if (policy !== 'selected') return
    onSelectedModelsChange(selected.has(model)
      ? selectedModels.filter((candidate) => candidate !== model)
      : normalizeModelNames([...selectedModels, model]))
  }

  const testModel = async (model: string) => {
    const normalizedModel = model.trim()
    if (!onTestModel || !normalizedModel || testStates[normalizedModel]?.status === 'testing') return
    setTestStates((current) => ({ ...current, [normalizedModel]: { status: 'testing' } }))
    try {
      const result = await onTestModel(normalizedModel)
      setTestStates((current) => ({ ...current, [normalizedModel]: modelTestCompleted(result) }))
    } catch (cause) {
      setTestStates((current) => ({ ...current, [normalizedModel]: modelTestFailed(cause) }))
    }
  }

  const manualTestState = testStates[manualModel.trim()]

  return (
    <section className="model-policy">
      <div className="model-policy__heading">
        <div>
          <strong>{title}</strong>
          <span>{description}</span>
        </div>
        {onRefresh && (
          <button
            className="button button--secondary model-policy__refresh"
            type="button"
            disabled={refreshing || Boolean(refreshDisabledReason)}
            title={refreshDisabledReason ?? '使用此账号刷新可用模型'}
            onClick={onRefresh}
          >
            {refreshing ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
            {refreshing ? '正在拉取' : '刷新可用模型'}
          </button>
        )}
      </div>

      <div className="model-policy__meta">
        <Badge tone={policy === 'all' ? 'info' : 'neutral'}>{policy === 'all' ? '全部开放' : `指定开放 ${selectedModels.length}`}</Badge>
        <span>{options.length} 个候选模型</span>
        {refreshedAt !== undefined && <span>更新于 {relativeTime(refreshedAt)}</span>}
        {refreshDisabledReason && <span>{refreshDisabledReason}</span>}
      </div>

      {catalogNotice && <div className="model-policy__notice"><AlertTriangle size={15} /><span>{catalogNotice}</span></div>}

      <div className="model-policy__modes" role="radiogroup" aria-label={`${title}策略`}>
        <button
          type="button"
          role="radio"
          aria-checked={policy === 'all'}
          className={policy === 'all' ? 'active' : ''}
          onClick={() => onPolicyChange('all')}
        >
          <span className="radio-mark">{policy === 'all' && <Check size={13} />}</span>
          <span><strong>全部开放</strong><small>目录更新后自动包含新增模型</small></span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={policy === 'selected'}
          className={policy === 'selected' ? 'active' : ''}
          onClick={() => onPolicyChange('selected')}
        >
          <span className="radio-mark">{policy === 'selected' && <Check size={13} />}</span>
          <span><strong>指定开放</strong><small>只开放下方明确勾选的模型</small></span>
        </button>
      </div>

      {options.length > 0 && (
        <div className="model-policy__toolbar">
          <label className="model-policy__search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型" /></label>
          {policy === 'selected' && <><button className="text-button" type="button" onClick={() => onSelectedModelsChange(options.map((option) => option.model))}>全选</button><button className="text-button" type="button" onClick={() => onSelectedModelsChange([])}>清空</button></>}
        </div>
      )}

      {onTestModel && (
        <div className="model-policy__manual-test">
          <label>
            <span>测试其他模型</span>
            <input
              className="mono"
              value={manualModel}
              onChange={(event) => setManualModel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                void testModel(manualModel)
              }}
              placeholder="例如 gpt-5.6-sol"
            />
          </label>
          <button
            className="button button--secondary"
            type="button"
            title={testDisabledReason ?? (manualModel.trim() ? modelTestTitle(manualModel.trim(), manualTestState) : '输入完整的模型标识')}
            disabled={!manualModel.trim() || Boolean(testDisabledReason) || manualTestState?.status === 'testing'}
            onClick={() => void testModel(manualModel)}
          >
            {manualTestState?.status === 'testing' ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}
            测试
          </button>
          {manualTestState && manualTestState.status !== 'testing' && (
            <span
              className={`model-policy__manual-result is-${manualTestState.status}`}
              title={modelTestTitle(manualModel.trim(), manualTestState)}
            >
              {manualTestState.status === 'success'
                ? <><CheckCircle2 size={14} />可用 · {manualTestState.latencyMs} ms</>
                : <><XCircle size={14} />不可用 · {manualTestState.message}</>}
            </span>
          )}
        </div>
      )}

      <div className="model-picker">
        {filtered.map((option) => {
          const checked = policy === 'all' || selected.has(option.model)
          const hasCoverage = option.supportCount !== undefined && option.totalAccounts !== undefined
          const fullCoverage = hasCoverage && option.supportCount === option.totalAccounts
          const testState = testStates[option.model]
          return (
            <div className={`${checked ? 'selected' : ''} model-picker__row`} key={option.model}>
              <button
                type="button"
                className={`model-picker__select ${policy === 'all' ? 'read-only' : ''}`}
                aria-pressed={checked}
                onClick={() => toggleModel(option.model)}
              >
                <span className="checkbox-mark">{checked && <Check size={13} />}</span>
                <code title={option.model}>{option.model}</code>
                {hasCoverage && <Badge tone={fullCoverage ? 'success' : 'warning'}>支持 {option.supportCount}/{option.totalAccounts}</Badge>}
              </button>
              {onTestModel && (
                <div className={`model-picker__test-result${testState ? ` is-${testState.status}` : ''}`}>
                  {testState?.status === 'success' && <span>{testState.latencyMs} ms</span>}
                  {testState?.status === 'failure' && <span>不可用</span>}
                  <button
                    className="icon-button model-picker__test"
                    type="button"
                    title={testDisabledReason ?? modelTestTitle(option.model, testState)}
                    aria-label={testDisabledReason ?? modelTestTitle(option.model, testState)}
                    disabled={Boolean(testDisabledReason) || testState?.status === 'testing'}
                    onClick={() => void testModel(option.model)}
                  >
                    {testState?.status === 'testing'
                      ? <LoaderCircle size={15} className="spin" />
                      : testState?.status === 'success'
                        ? <CheckCircle2 size={15} />
                        : testState?.status === 'failure'
                          ? <XCircle size={15} />
                          : <Play size={15} />}
                  </button>
                </div>
              )}
            </div>
          )
        })}
        {!filtered.length && <div className="model-picker__empty">{options.length ? '没有匹配的模型。' : emptyMessage}</div>}
      </div>

      {policy === 'selected' && selectedModels.length === 0 && <div className="model-policy__empty-selection">{emptySelectionMessage}</div>}
    </section>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Clock3, LoaderCircle, RefreshCw } from 'lucide-react'
import type { AppSnapshot, CodexQuotaHistoryPoint, CodexQuotaWindow, GatewayApi } from '@shared/types'
import type { ActionRunner } from '../App'
import { Badge, Modal } from '../ui'

type PublicAccount = AppSnapshot['accounts'][number]

export function CodexQuotaModal({
  account,
  api,
  runAction,
  busyKeys,
  onClose,
}: {
  account: PublicAccount | null
  api: GatewayApi
  runAction: ActionRunner
  busyKeys: Set<string>
  onClose: () => void
}) {
  const [history, setHistory] = useState<CodexQuotaHistoryPoint[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const autoRefreshAttempt = useRef<string | undefined>(undefined)

  const loadHistory = useCallback(async (accountId: string) => {
    setLoading(true)
    setError('')
    try {
      const end = Date.now()
      setHistory(await api.getAccountCodexQuotaHistory(accountId, end - 14 * 24 * 60 * 60 * 1000, end))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '额度历史读取失败')
    } finally {
      setLoading(false)
    }
  }, [api])

  const accountId = account?.id
  const quotaObservedAt = account?.codexQuota?.observedAt
  useEffect(() => {
    if (accountId) void loadHistory(accountId)
    else setHistory([])
  }, [accountId, loadHistory, quotaObservedAt])

  const refresh = useCallback(async () => {
    if (!accountId) return
    const success = await runAction(`refresh-quota-${accountId}`, () => api.refreshAccountCodexQuota(accountId))
    if (success) await loadHistory(accountId)
  }, [accountId, api, loadHistory, runAction])

  useEffect(() => {
    if (!accountId) {
      autoRefreshAttempt.current = undefined
      return
    }
    const currentIsFresh = quotaObservedAt !== undefined && Date.now() - quotaObservedAt <= 10 * 60 * 1000
    if (currentIsFresh || autoRefreshAttempt.current === accountId) return
    autoRefreshAttempt.current = accountId
    void refresh()
  }, [accountId, quotaObservedAt, refresh])

  const quota = account?.codexQuota
  const stale = quota ? Date.now() - quota.observedAt > 10 * 60 * 1000 : false
  return (
    <Modal
      open={Boolean(account)}
      title={`${account?.name ?? ''} · Codex 额度`}
      description="5 小时共享窗口与周窗口的实际上游快照"
      width="large"
      onClose={onClose}
      footer={<><span className="quota-modal__source">{quota ? `${quota.source === 'usage-endpoint' ? '主动查询' : '响应头'} · ${new Date(quota.observedAt).toLocaleString()}` : '尚无快照'}</span><button className="button button--secondary" type="button" disabled={!account || busyKeys.has(`refresh-quota-${account?.id}`)} onClick={() => void refresh()}>{busyKeys.has(`refresh-quota-${account?.id}`) ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}刷新额度</button></>}
    >
      <div className="quota-modal">
        <div className="quota-summary-grid">
          <QuotaSummary label="5 小时额度" window={quota?.fiveHour} stale={stale} />
          <QuotaSummary label="周额度" window={quota?.sevenDay} stale={stale} />
        </div>
        {quota?.limitReached && <div className="warning-banner"><Clock3 size={17} /><div><strong>上游已标记额度耗尽</strong><span>Stone 会按实际 429 重置时间冷却账号</span></div></div>}
        <QuotaTrend
          label="5 小时额度 · 最近 24 小时"
          points={history.filter((point) => point.observedAt >= Date.now() - 24 * 60 * 60 * 1000)}
          value={(point) => point.fiveHourUsedPercent}
        />
        <QuotaTrend label="周额度 · 最近 14 天" points={history} value={(point) => point.sevenDayUsedPercent} weekly />
        {loading && <div className="quota-history-state"><LoaderCircle size={17} className="spin" />正在读取本地采样…</div>}
        {error && <div className="quota-history-state quota-history-state--error">{error}</div>}
      </div>
    </Modal>
  )
}

export function CodexQuotaCompact({ quota, onClick }: { quota: PublicAccount['codexQuota']; onClick?: () => void }) {
  if (!quota) return <button className="quota-compact quota-compact--empty" type="button" onClick={onClick}>尚未采集</button>
  return <button className="quota-compact" type="button" title="查看额度趋势" onClick={onClick}>
    <CompactWindow label="5h" window={quota.fiveHour} />
    <CompactWindow label="周" window={quota.sevenDay} />
  </button>
}

function CompactWindow({ label, window }: { label: string; window?: CodexQuotaWindow }) {
  const percent = window?.usedPercent
  return <span className="quota-compact__row"><span>{label}</span><span className="quota-compact__track"><i style={{ width: `${clampPercent(percent)}%` }} /></span><strong>{percent === undefined ? '—' : `${formatPercent(percent)}%`}</strong></span>
}

function QuotaSummary({ label, window, stale }: { label: string; window?: CodexQuotaWindow; stale: boolean }) {
  return <section className="quota-summary">
    <header><span>{label}</span><Badge tone={!window ? 'neutral' : stale ? 'warning' : window.usedPercent >= 90 ? 'danger' : 'success'}>{!window ? '未知' : stale ? '待刷新' : '实时'}</Badge></header>
    <div className="quota-summary__value"><strong>{window ? formatPercent(window.usedPercent) : '—'}</strong><span>% 已使用</span></div>
    <div className="quota-summary__track"><span style={{ width: `${clampPercent(window?.usedPercent)}%` }} /></div>
    <footer><span>{window?.windowSeconds ? formatWindow(window.windowSeconds) : '窗口时长未知'}</span><span>{resetLabel(window?.resetAt)}</span></footer>
  </section>
}

function QuotaTrend({
  label,
  points,
  value,
  weekly = false,
}: {
  label: string
  points: CodexQuotaHistoryPoint[]
  value: (point: CodexQuotaHistoryPoint) => number | undefined
  weekly?: boolean
}) {
  const samples = useMemo(() => downsample(points.filter((point) => value(point) !== undefined), 72), [points, value])
  return <section className={`quota-trend ${weekly ? 'quota-trend--weekly' : ''}`}>
    <header><div><strong>{label}</strong><span>{samples.length ? `${samples.length} 个本地采样` : '从启用后开始记录'}</span></div><span className="quota-trend__legend">0–100%</span></header>
    {samples.length ? <div className="quota-trend__plot" aria-label={label}>{samples.map((point) => {
      const percent = value(point) ?? 0
      return <span key={`${point.observedAt}-${percent}`} title={`${new Date(point.observedAt).toLocaleString()} · ${formatPercent(percent)}%`}><i style={{ height: `${Math.max(2, clampPercent(percent))}%` }} /></span>
    })}<div className="quota-trend__line quota-trend__line--50" /><div className="quota-trend__line quota-trend__line--100" /></div> : <div className="quota-trend__empty">暂无历史采样</div>}
  </section>
}

function downsample(points: CodexQuotaHistoryPoint[], maximum: number): CodexQuotaHistoryPoint[] {
  if (points.length <= maximum) return points
  const step = (points.length - 1) / (maximum - 1)
  return Array.from({ length: maximum }, (_, index) => points[Math.round(index * step)])
}

function clampPercent(value: number | undefined): number {
  return value === undefined ? 0 : Math.max(0, Math.min(100, value))
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function formatWindow(seconds: number): string {
  if (seconds <= 6 * 60 * 60) return `${Math.round(seconds / 3600)} 小时窗口`
  return `${Math.round(seconds / 86_400)} 天窗口`
}

function resetLabel(resetAt: number | undefined): string {
  if (!resetAt) return '重置时间未知'
  const remaining = resetAt - Date.now()
  if (remaining <= 0) return '窗口已到期'
  const hours = Math.floor(remaining / 3_600_000)
  if (hours >= 24) return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时后重置`
  const minutes = Math.max(1, Math.ceil(remaining / 60_000))
  return hours > 0 ? `${hours} 小时 ${minutes % 60} 分后重置` : `${minutes} 分钟后重置`
}

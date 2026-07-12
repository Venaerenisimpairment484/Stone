import {
  Activity,
  ArrowRight,
  CheckCircle2,
  Clock3,
  Network,
  Radio,
  Server,
  ShieldCheck,
  BellRing,
  Waypoints,
} from 'lucide-react'
import type { AppSnapshot, RouteClient } from '@shared/types'
import type { PageId } from '../App'
import {
  AccountStatusBadge,
  Badge,
  durationLabel,
  formatCompactNumber,
  PageHeader,
  relativeTime,
  RequestStatusBadge,
} from '../ui'

const clientNames: Record<RouteClient, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
}

function uptimeLabel(startedAt?: number) {
  if (!startedAt) return '—'
  const minutes = Math.max(1, Math.floor((Date.now() - startedAt) / 60000))
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return `${hours} 小时 ${remainder} 分钟`
}

function requestActivity(logs: AppSnapshot['requestLogs']): number[] {
  const buckets = Array.from({ length: 12 }, () => 0)
  const now = Date.now()
  for (const log of logs) {
    const age = now - log.timestamp
    if (age < 0 || age >= 60 * 60 * 1000) continue
    const newestFirst = Math.floor(age / (5 * 60 * 1000))
    buckets[11 - newestFirst] += 1
  }
  const maximum = Math.max(...buckets)
  return maximum === 0 ? buckets : buckets.map((count) => count === 0 ? 0 : Math.max(10, Math.round((count / maximum) * 100)))
}

export function OverviewView({ snapshot, navigate }: { snapshot: AppSnapshot; navigate: (page: PageId) => void }) {
  const enabledRoutes = snapshot.routes.filter((route) => route.enabled)
  const availableAccounts = snapshot.accounts.filter((account) => account.status === 'active')
  const recentLogs = snapshot.requestLogs.slice(0, 6)
  const totalTokens = snapshot.requestLogs.reduce((total, log) => total + (log.inputTokens ?? 0) + (log.outputTokens ?? 0), 0)
  const chartBars = requestActivity(snapshot.requestLogs)
  const daily = snapshot.observability.last24Hours

  return (
    <div className="page-stack">
      <PageHeader title="总览" description="本地网关与上游线路的实时状态" />

      <section className="metrics-grid" aria-label="网关指标">
        <article className="metric-card">
          <div className="metric-card__icon metric-card__icon--green"><Activity size={19} /></div>
          <div className="metric-card__label">24 小时请求</div>
          <strong>{formatCompactNumber(daily.requestCount)}</strong>
          <span>{snapshot.gatewayStatus.activeRequests} 个正在处理</span>
        </article>
        <article className="metric-card">
          <div className="metric-card__icon metric-card__icon--blue"><CheckCircle2 size={19} /></div>
          <div className="metric-card__label">24 小时成功率</div>
          <strong>{(daily.successRate * 100).toFixed(1)}%</strong>
          <span>{formatCompactNumber(daily.successCount)} 个成功请求</span>
        </article>
        <article className="metric-card">
          <div className="metric-card__icon metric-card__icon--amber"><Network size={19} /></div>
          <div className="metric-card__label">可用账号</div>
          <strong>{availableAccounts.length}<small> / {snapshot.accounts.length}</small></strong>
          <span>{snapshot.pools.length} 个号池参与调度</span>
        </article>
        <article className="metric-card">
          <div className="metric-card__icon metric-card__icon--violet"><Clock3 size={19} /></div>
          <div className="metric-card__label">24 小时平均延迟</div>
          <strong className="metric-card__uptime">{daily.averageLatencyMs ? durationLabel(daily.averageLatencyMs) : '—'}</strong>
          <span>{daily.failoverCount} 次账号切换 · 运行 {uptimeLabel(snapshot.gatewayStatus.startedAt)}</span>
        </article>
      </section>

      <div className="overview-grid">
        <section className="panel traffic-panel">
          <header className="panel__header">
            <div>
              <h2>请求活动</h2>
              <p>最近 60 分钟</p>
            </div>
            <div className="traffic-total">
              <span>日志内 Token</span>
              <strong>{formatCompactNumber(totalTokens)}</strong>
            </div>
          </header>
          <div className="traffic-chart" aria-label="最近 60 分钟请求趋势">
            {chartBars.map((height, index) => (
              <div className="traffic-chart__column" key={index}>
                <span style={{ height: `${height}%` }} />
              </div>
            ))}
          </div>
          <div className="traffic-chart__axis"><span>60 分钟前</span><span>现在</span></div>
        </section>

        <section className="panel route-summary">
          <header className="panel__header">
            <div>
              <h2>客户端路由</h2>
              <p>{enabledRoutes.length} / {snapshot.routes.length} 条已启用</p>
            </div>
            <button className="text-button" type="button" onClick={() => navigate('routes')}>管理路由 <ArrowRight size={15} /></button>
          </header>
          <div className="route-summary__list">
            {snapshot.routes.map((route) => {
              const pool = snapshot.pools.find((item) => item.id === route.poolId)
              return (
                <div className="route-summary__row" key={route.id}>
                  <div className={`client-glyph client-glyph--${route.client}`}>{route.client.slice(0, 1).toUpperCase()}</div>
                  <div className="route-summary__name">
                    <strong>{clientNames[route.client]}</strong>
                    <span>{pool?.name ?? '未选择号池'}</span>
                  </div>
                  <Badge tone={route.enabled ? 'success' : 'neutral'}>{route.enabled ? '已启用' : '已停用'}</Badge>
                </div>
              )
            })}
          </div>
        </section>
      </div>

      <section className="panel observability-panel">
        <header className="panel__header"><div><h2>24 小时运行趋势</h2><p>请求量、错误与延迟按小时聚合</p></div><Badge tone="neutral">{formatCompactNumber(daily.inputTokens + daily.outputTokens)} Tokens</Badge></header>
        <div className="observability-chart" aria-label="24 小时运行趋势">
          {snapshot.observability.hourly.map((point) => {
            const maximum = Math.max(1, ...snapshot.observability.hourly.map((item) => item.requestCount))
            const height = Math.max(point.requestCount ? 8 : 0, point.requestCount / maximum * 100)
            const errorHeight = point.requestCount ? point.errorCount / point.requestCount * height : 0
            return <div className="observability-chart__bar" key={point.timestamp} title={`${new Date(point.timestamp).getHours()}:00 · ${point.requestCount} 请求 · ${point.averageLatencyMs}ms`}><span style={{ height: `${height}%` }}><i style={{ height: `${errorHeight}%` }} /></span></div>
          })}
        </div>
        <div className="observability-legend"><span><i className="legend-success" />请求</span><span><i className="legend-error" />错误</span><span>7 天：{snapshot.observability.last7Days.requestCount} 请求 · {(snapshot.observability.last7Days.successRate * 100).toFixed(1)}% 成功</span></div>
      </section>

      <section className="panel health-events-panel">
        <header className="panel__header"><div><h2>健康事件</h2><p>账号失效、冷却、额度耗尽与恢复</p></div><BellRing size={18} /></header>
        {snapshot.healthEvents.length ? <div className="health-event-list">{snapshot.healthEvents.slice(0, 8).map((event) => <div key={event.id} className={`health-event health-event--${event.severity}`}><span className="status-dot" /><div><strong>{event.accountName} · {event.providerName}</strong><span>{event.message}</span></div><small>{relativeTime(event.timestamp)}</small></div>)}</div> : <div className="empty-inline"><ShieldCheck size={18} /><span>暂无健康告警，所有账号运行正常</span></div>}
      </section>

      <section className="panel account-health">
        <header className="panel__header">
          <div>
            <h2>账号健康</h2>
            <p>上游可用性与并发占用</p>
          </div>
          <button className="text-button" type="button" onClick={() => navigate('providers')}>查看全部 <ArrowRight size={15} /></button>
        </header>
        {snapshot.accounts.length ? <div className="health-strip">
          {snapshot.accounts.slice(0, 5).map((account) => {
            const provider = snapshot.providers.find((item) => item.id === account.providerId)
            const usage = Math.min(100, (account.inFlight / account.maxConcurrency) * 100)
            return (
              <div className="health-strip__item" key={account.id}>
                <div className="health-strip__top">
                  <span className="provider-avatar" style={{ '--provider-color': provider?.color ?? '#61736f' } as React.CSSProperties}>
                    {provider?.name.slice(0, 1) ?? '?'}
                  </span>
                  <div><strong>{account.name}</strong><span>{provider?.name}</span></div>
                  <AccountStatusBadge status={account.status} circuitState={account.circuitState} />
                </div>
                <div className="usage-line"><span style={{ width: `${usage}%` }} /></div>
                <div className="health-strip__meta">
                  <span>{account.inFlight} / {account.maxConcurrency} 并发</span>
                  <span>{account.latencyMs ? durationLabel(account.latencyMs) : '未检测'}</span>
                </div>
              </div>
            )
          })}
        </div> : <div className="empty-inline"><Server size={17} /><span>尚未添加上游账号</span></div>}
      </section>

      <section className="panel recent-requests">
        <header className="panel__header">
          <div>
            <h2>最近请求</h2>
            <p>跨客户端请求记录</p>
          </div>
          <button className="text-button" type="button" onClick={() => navigate('requests')}>查看请求日志 <ArrowRight size={15} /></button>
        </header>
        {recentLogs.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>客户端</th><th>模型</th><th>上游</th><th>状态</th><th>延迟</th><th>时间</th></tr></thead>
              <tbody>
                {recentLogs.map((log) => (
                  <tr key={log.id}>
                    <td><div className="cell-with-icon"><span className={`client-dot client-dot--${log.client}`} /><span>{clientNames[log.client]}</span></div></td>
                    <td><span className="mono table-model">{log.model}</span></td>
                    <td><div className="table-primary"><strong>{log.providerName}</strong><span>{log.accountName}</span></div></td>
                    <td><RequestStatusBadge status={log.status} /></td>
                    <td>{durationLabel(log.latencyMs)}</td>
                    <td>{relativeTime(log.timestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-inline"><Radio size={18} /><span>暂无请求记录</span></div>
        )}
      </section>

      <section className="quick-links" aria-label="快捷入口">
        <button type="button" onClick={() => navigate('providers')}><Server size={17} /><span>添加上游账号</span><ArrowRight size={15} /></button>
        <button type="button" onClick={() => navigate('pools')}><Waypoints size={17} /><span>调整调度策略</span><ArrowRight size={15} /></button>
        <button type="button" onClick={() => navigate('settings')}><ShieldCheck size={17} /><span>网关与安全设置</span><ArrowRight size={15} /></button>
      </section>
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  HardDrive,
  LoaderCircle,
  LockKeyhole,
  Network,
  Save,
  ShieldCheck,
  Timer,
  Archive,
  RotateCcw,
  FileDown,
  BellRing,
} from 'lucide-react'
import type { AppSnapshot, BackupRecordSummary, GatewayApi, GatewaySettings } from '@shared/types'
import type { ActionRunner } from '../App'
import { Badge, FieldError, gatewayBaseUrl, PageHeader, Toggle } from '../ui'
import { StoneMark } from '../StoneMark'

function SettingRow({ title, description, control }: { title: string; description: string; control: React.ReactNode }) {
  return <div className="setting-row"><div><strong>{title}</strong><span>{description}</span></div>{control}</div>
}

export function SettingsView({
  snapshot,
  api,
  runAction,
  busyKeys,
}: {
  snapshot: AppSnapshot
  api: GatewayApi
  runAction: ActionRunner
  busyKeys: Set<string>
}) {
  const [draft, setDraft] = useState<GatewaySettings>(snapshot.gateway)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  const [backups, setBackups] = useState<BackupRecordSummary[]>([])
  const [operationNotice, setOperationNotice] = useState('')

  useEffect(() => setDraft(snapshot.gateway), [snapshot.gateway])
  useEffect(() => { void api.listStateBackups().then(setBackups).catch(() => undefined) }, [api])

  const changed = useMemo(() => JSON.stringify(draft) !== JSON.stringify(snapshot.gateway), [draft, snapshot.gateway])
  const addressChanged = draft.host !== snapshot.gateway.host || draft.port !== snapshot.gateway.port
  const currentEndpoint = gatewayBaseUrl(snapshot.gatewayStatus.host, snapshot.gatewayStatus.port)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const nextErrors: Record<string, string> = {}
    if (!['127.0.0.1', '::1', 'localhost'].includes(draft.host.trim())) nextErrors.host = '本地网关仅允许监听回环地址'
    if (!Number.isInteger(draft.port) || draft.port < 1024 || draft.port > 65535) nextErrors.port = '端口范围为 1024–65535'
    if (draft.requestTimeoutSeconds < 5 || draft.requestTimeoutSeconds > 600) nextErrors.timeout = '超时范围为 5–600 秒'
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return
    const success = await runAction('save-settings', () => api.updateGateway({ ...draft, host: draft.host.trim() }))
    if (success) {
      await api.updateDesktopRuntimeSettings({ launchAtLogin: Boolean(draft.launchAtLogin) })
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1600)
    }
  }

  const createBackup = async () => {
    const result = await api.createStateBackup()
    setBackups(await api.listStateBackups())
    setOperationNotice(result.backup ? `备份已创建：${result.backup.path}` : '备份已创建')
  }

  const restoreBackup = async (backup: BackupRecordSummary) => {
    if (!window.confirm('恢复会替换当前本地数据并需要重启 Stone，是否继续？')) return
    const result = await api.restoreStateBackup(backup.path)
    setOperationNotice(result.restartRequired ? '数据已恢复，请退出并重新启动 Stone。' : '数据已恢复。')
  }

  const exportDiagnostics = async () => {
    const report = await api.exportDiagnostics()
    await navigator.clipboard?.writeText(report)
    setOperationNotice('脱敏诊断报告已复制到剪贴板。')
  }

  return (
    <form className="page-stack" onSubmit={(event) => void submit(event)}>
      <PageHeader
        title="设置"
        description="本地网关、安全存储与日志策略"
        actions={<button className="button button--primary" type="submit" disabled={!changed || busyKeys.has('save-settings')}>{busyKeys.has('save-settings') ? <LoaderCircle size={16} className="spin" /> : saved ? <CheckCircle2 size={16} /> : <Save size={16} />}{saved ? '已保存' : '保存设置'}</button>}
      />

      {addressChanged && snapshot.gatewayStatus.running && <div className="warning-banner"><AlertTriangle size={17} /><div><strong>保存时将自动重启网关</strong><span>当前请求仍使用 {currentEndpoint}</span></div></div>}

      <section className="settings-section">
        <header><div className="settings-section__icon"><Network size={18} /></div><div><h2>本地网关</h2><p>监听地址与请求生命周期</p></div></header>
        <div className="settings-section__content">
          <div className="form-grid settings-fields">
            <label className="field"><span>监听地址</span><select value={draft.host} onChange={(event) => setDraft({ ...draft, host: event.target.value })}><option value="127.0.0.1">127.0.0.1 (IPv4)</option><option value="::1">::1 (IPv6)</option><option value="localhost">localhost</option></select><FieldError>{errors.host}</FieldError></label>
            <label className="field"><span>端口</span><input className="mono" type="number" min={1024} max={65535} value={draft.port} onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) })} /><FieldError>{errors.port}</FieldError></label>
            <label className="field"><span>请求超时</span><div className="input-suffix"><input type="number" min={5} max={600} value={draft.requestTimeoutSeconds} onChange={(event) => setDraft({ ...draft, requestTimeoutSeconds: Number(event.target.value) })} /><span>秒</span></div><FieldError>{errors.timeout}</FieldError></label>
            <div className="field"><span>当前端点</span><code className="settings-endpoint">{currentEndpoint}</code></div>
          </div>
          <SettingRow title="应用启动时运行网关" description="Stone 启动后自动监听本地端口" control={<Toggle checked={draft.autoStart} onChange={(value) => setDraft({ ...draft, autoStart: value })} label="应用启动时运行网关" />} />
          <SettingRow title="登录系统时启动 Stone" description="由操作系统管理桌面应用自启动" control={<Toggle checked={Boolean(draft.launchAtLogin)} onChange={(value) => setDraft({ ...draft, launchAtLogin: value })} label="登录系统时启动 Stone" />} />
          <SettingRow title="桌面健康通知" description="账号停用、冷却、额度耗尽或恢复时通知" control={<Toggle checked={draft.desktopNotifications !== false} onChange={(value) => setDraft({ ...draft, desktopNotifications: value })} label="桌面健康通知" />} />
        </div>
      </section>

      <section className="settings-section">
        <header><div className="settings-section__icon settings-section__icon--secure"><Archive size={18} /></div><div><h2>备份与恢复</h2><p>本地 SQLite 在线备份、校验与自动轮换</p></div></header>
        <div className="settings-section__content">
          <SettingRow title="自动备份" description="Stone 启动时创建校验过的本地快照" control={<Toggle checked={draft.automaticBackups !== false} onChange={(value) => setDraft({ ...draft, automaticBackups: value })} label="自动备份" />} />
          <label className="field backup-retention"><span>最多保留备份</span><div className="input-suffix"><input type="number" min={1} max={100} value={draft.backupRetention ?? 10} onChange={(event) => setDraft({ ...draft, backupRetention: Number(event.target.value) })} /><span>份</span></div></label>
          <div className="settings-actions"><button className="button button--secondary" type="button" onClick={() => void createBackup()}><Archive size={16} />立即备份</button><button className="button button--secondary" type="button" onClick={() => void exportDiagnostics()}><FileDown size={16} />复制诊断报告</button><button className="button button--secondary" type="button" onClick={() => void api.clearHealthEvents()}><BellRing size={16} />清除健康事件</button></div>
          {operationNotice && <div className="client-config-notice">{operationNotice}</div>}
          <div className="state-backup-list">{backups.slice(0, 6).map((backup) => <div key={backup.path}><span><strong>{new Date(backup.createdAt).toLocaleString()}</strong><small>{Math.ceil(backup.size / 1024)} KB · {backup.automatic ? '自动' : '手动'} · {backup.integrity === 'valid' ? '校验通过' : '损坏'}</small></span><button className="icon-button" type="button" disabled={backup.integrity !== 'valid'} title="恢复此备份" onClick={() => void restoreBackup(backup)}><RotateCcw size={15} /></button></div>)}{!backups.length && <span className="muted">暂无状态备份</span>}</div>
        </div>
      </section>

      <section className="settings-section">
        <header><div className="settings-section__icon settings-section__icon--secure"><ShieldCheck size={18} /></div><div><h2>安全与凭据</h2><p>上游密钥的本机存储状态</p></div></header>
        <div className="settings-section__content">
          <div className={`vault-status ${snapshot.vaultAvailable ? 'vault-status--available' : 'vault-status--unavailable'}`}>
            <div><LockKeyhole size={21} /><div><strong>{snapshot.vaultAvailable ? '凭据保险库可用' : '凭据保险库不可用'}</strong><span>{snapshot.vaultBackend}</span></div></div>
            <Badge tone={snapshot.vaultAvailable ? 'success' : 'danger'}>{snapshot.vaultAvailable ? '受保护' : '需要处理'}</Badge>
          </div>
          <div className="security-facts">
            <div><HardDrive size={16} /><span>元数据</span><strong>本地 SQLite</strong></div>
            <div><Database size={16} /><span>供应商凭据</span><strong>{snapshot.vaultBackend}</strong></div>
            <div><ShieldCheck size={16} /><span>网关监听</span><strong>仅回环地址</strong></div>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <header><div className="settings-section__icon settings-section__icon--logs"><Timer size={18} /></div><div><h2>请求日志</h2><p>本地诊断数据的记录范围</p></div></header>
        <div className="settings-section__content">
          <SettingRow title="日志内容" description="记录路由、状态、延迟与 Token 计数，不保存提示词或模型输出" control={<Badge tone="success">仅元数据</Badge>} />
          <div className="log-summary"><span>当前日志</span><strong>{snapshot.requestLogs.length} 条记录</strong><Badge tone="success">仅元数据</Badge></div>
        </div>
      </section>

      <section className="about-line"><StoneMark small /><div><strong>Stone Desktop</strong><span>{__APP_VERSION__} · Local-first AI Gateway</span></div><Badge tone="neutral">v0.7 模型策略</Badge></section>
    </form>
  )
}

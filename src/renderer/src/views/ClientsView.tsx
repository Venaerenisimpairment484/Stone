import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  Braces,
  CheckCircle2,
  FileCode2,
  FolderCog,
  History,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  ShieldCheck,
  Trash2,
  Download,
  Upload,
} from 'lucide-react'
import type {
  AppSnapshot,
  ClientConfigBackup,
  ClientConfigEditorState,
  ClientConfigFieldValue,
  ClientConfigPreview,
  ClientConfigStatus,
  ClientConfigProfile,
  GatewayApi,
  RouteClient,
} from '@shared/types'
import { clientNativeProtocols } from '@shared/types'
import { Badge, ConfirmDialog, EmptyState, formatDateTime, Modal, PageHeader, Toggle } from '../ui'

const clientMeta: Record<RouteClient, { name: string; mark: string; color: string }> = {
  claude: { name: 'Claude Code', mark: 'C', color: '#d97757' },
  codex: { name: 'Codex', mark: 'X', color: '#1f2925' },
  gemini: { name: 'Gemini CLI', mark: 'G', color: '#3d6fa8' },
}

const roleLabels = {
  'claude-settings': 'Claude 设置',
  'claude-mcp': 'Claude MCP',
  'codex-config': 'Codex 配置',
  'codex-auth': 'Codex 认证',
  'gemini-settings': 'Gemini 设置',
  'gemini-env': 'Gemini 环境变量',
}

export function ClientsView({ snapshot, api }: { snapshot: AppSnapshot; api: GatewayApi }) {
  const [statuses, setStatuses] = useState<ClientConfigStatus[]>([])
  const [backups, setBackups] = useState<Partial<Record<RouteClient, ClientConfigBackup[]>>>({})
  const [preview, setPreview] = useState<ClientConfigPreview | null>(null)
  const [restoreTarget, setRestoreTarget] = useState<ClientConfigBackup | null>(null)
  const [expandedBackups, setExpandedBackups] = useState<RouteClient | null>(null)
  const [busy, setBusy] = useState<string | null>('load')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [profile, setProfile] = useState<ClientConfigProfile | null>(null)
  const [profileBundle, setProfileBundle] = useState('')
  const [editor, setEditor] = useState<ClientConfigEditorState | null>(null)
  const [editorMode, setEditorMode] = useState<'common' | 'files'>('common')
  const [activeEditorRole, setActiveEditorRole] = useState<ClientConfigEditorState['files'][number]['role'] | null>(null)
  const [fieldDrafts, setFieldDrafts] = useState<Record<string, ClientConfigFieldValue>>({})
  const [fileDrafts, setFileDrafts] = useState<Record<string, string>>({})
  const [activeProfiles, setActiveProfiles] = useState<Record<RouteClient, string>>({
    claude: 'default-claude',
    codex: 'default-codex',
    gemini: 'default-gemini',
  })

  const load = useCallback(async () => {
    setBusy('load')
    setError(null)
    try {
      setStatuses(await api.getClientConfigs())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法检测客户端配置')
    } finally {
      setBusy(null)
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  const run = async <T,>(key: string, operation: () => Promise<T>): Promise<T | undefined> => {
    setBusy(key)
    setError(null)
    setNotice(null)
    try {
      return await operation()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '客户端配置操作失败')
      return undefined
    } finally {
      setBusy(null)
    }
  }

  const openPreview = async (client: RouteClient) => {
    const result = await run(`preview-${client}`, () => api.previewClientConfig(client, activeProfiles[client]))
    if (result) setPreview(result)
  }

  const openEditor = async (client: RouteClient) => {
    const result = await run(`editor-${client}`, () => api.getClientConfigEditor(client, activeProfiles[client]))
    if (!result) return
    setEditor(result)
    setEditorMode('common')
    setFieldDrafts(Object.fromEntries(result.fields.map((field) => [field.id, field.value])))
    setFileDrafts(Object.fromEntries(result.files.flatMap((file) => file.content === undefined ? [] : [[file.role, file.content]])))
    setActiveEditorRole(result.files.find((file) => file.editable)?.role ?? result.files[0]?.role ?? null)
  }

  const closeEditor = () => {
    setEditor(null)
    setError(null)
    setFieldDrafts({})
    setFileDrafts({})
    setActiveEditorRole(null)
  }

  const saveEditor = async () => {
    if (!editor) return
    const patches = editor.fields
      .filter((field) => !sameConfigValue(field.value, fieldDrafts[field.id] ?? null))
      .map((field) => ({ id: field.id, value: fieldDrafts[field.id] ?? null }))
    const files = editor.files
      .filter((file) => file.editable && file.content !== undefined && fileDrafts[file.role] !== file.content)
      .map((file) => ({ role: file.role, revision: file.revision, content: fileDrafts[file.role] ?? '' }))
    const result = await run(`save-editor-${editor.client}`, () => api.saveClientConfigEditor({
      client: editor.client,
      profileId: editor.profileId,
      patches,
      files,
    }))
    if (!result) return
    const client = editor.client
    closeEditor()
    setNotice(result.changedFiles.length
      ? `${clientMeta[client].name} 已保存并备份配置`
      : `${clientMeta[client].name} 配置无需更改`)
    const next = await api.getClientConfigs(activeProfiles[client])
    const status = next.find((candidate) => candidate.client === client)
    if (status) setStatuses((current) => current.map((candidate) => candidate.client === client ? status : candidate))
  }

  const apply = async (client: RouteClient) => {
    const result = await run(`apply-${client}`, () => api.applyClientConfig(client, activeProfiles[client]))
    if (!result) return
    setPreview(null)
    setNotice(result.changedFiles.length
      ? `${clientMeta[client].name} 已更新 ${result.changedFiles.length} 个文件，并创建 ${result.backups.length} 个备份`
      : `${clientMeta[client].name} 配置已是最新`)
    setStatuses(await api.getClientConfigs(activeProfiles[client]))
  }

  const toggleBackups = async (client: RouteClient) => {
    if (expandedBackups === client) {
      setExpandedBackups(null)
      return
    }
    const result = await run(`backups-${client}`, () => api.listClientConfigBackups(client, activeProfiles[client]))
    if (!result) return
    setBackups((current) => ({ ...current, [client]: result }))
    setExpandedBackups(client)
  }

  const restore = async () => {
    if (!restoreTarget) return
    const client = restoreTarget.client
    const result = await run(`restore-${client}`, () => api.restoreClientConfig(restoreTarget.backupPath, client, activeProfiles[client]))
    if (!result) return
    setRestoreTarget(null)
    setNotice(`${clientMeta[client].name} 已恢复到 ${formatDateTime(restoreTarget.createdAt)} 的备份`)
    const [nextStatuses, nextBackups] = await Promise.all([
      api.getClientConfigs(activeProfiles[client]),
      api.listClientConfigBackups(client, activeProfiles[client]),
    ])
    setStatuses(nextStatuses)
    setBackups((current) => ({ ...current, [client]: nextBackups }))
  }

  const selectProfile = async (client: RouteClient, profileId: string) => {
    setActiveProfiles((current) => ({ ...current, [client]: profileId }))
    setExpandedBackups(null)
    const result = await run(`profile-${client}`, () => api.getClientConfigs(profileId))
    const status = result?.find((candidate) => candidate.client === client)
    if (!status) return
    setStatuses((current) => current.map((candidate) => candidate.client === client ? status : candidate))
  }

  const saveProfile = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!profile) return
    const result = await run('save-profile', () => api.saveClientProfile({
      id: profile.isDefault ? undefined : profile.id,
      name: profile.name.trim(),
      client: profile.client,
      directory: profile.directory?.trim() || undefined,
      backupRetention: profile.backupRetention,
    }))
    if (!result) return
    const saved = result.clientProfiles
      .filter((candidate) => candidate.client === profile.client && !candidate.isDefault)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0]
    if (saved) await selectProfile(profile.client, saved.id)
    setProfile(null)
    setNotice('客户端配置 Profile 已保存')
  }

  const editProfile = (client: RouteClient) => {
    const selected = snapshot.clientProfiles.find((candidate) => candidate.id === activeProfiles[client])
    if (selected && !selected.isDefault) setProfile({ ...selected })
  }

  const deleteProfile = async (client: RouteClient) => {
    const selected = snapshot.clientProfiles.find((candidate) => candidate.id === activeProfiles[client])
    if (!selected || selected.isDefault) return
    const result = await run(`delete-profile-${client}`, () => api.deleteClientProfile(selected.id))
    if (!result) return
    const defaultId = `default-${client}`
    setActiveProfiles((current) => ({ ...current, [client]: defaultId }))
    await selectProfile(client, defaultId)
    setNotice(`${selected.name} Profile 已删除`)
  }

  const exportProfile = async (client: RouteClient) => {
    const selected = snapshot.clientProfiles.find((candidate) => candidate.id === activeProfiles[client])
    if (!selected) return
    const bundle = await run(`export-${client}`, () => api.exportClientProfile(selected.id))
    if (bundle) setProfileBundle(JSON.stringify(bundle, null, 2))
  }

  const importProfile = async () => {
    let parsed
    try { parsed = JSON.parse(profileBundle) } catch { setError('Profile JSON 无法解析'); return }
    const result = await run('import-profile', () => api.importClientProfile(parsed))
    if (result) { setProfileBundle(''); setNotice('Profile 已导入') }
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="客户端配置"
        description="检测、备份并更新本机 AI 编程客户端"
        actions={
          <>
            <button className="button button--secondary" type="button" onClick={() => setProfile({
              id: '',
              name: '',
              client: 'claude',
              backupRetention: 10,
              isDefault: false,
              createdAt: 0,
              updatedAt: 0,
            })}><Plus size={16} />新建 Profile</button>
            <button className="button button--secondary" type="button" onClick={() => setProfileBundle('{\n  "format": "stone-client-profile",\n  "version": 1,\n  "profile": {}\n}')}><Upload size={16} />导入</button>
            <button className="button button--secondary" type="button" disabled={busy === 'load'} onClick={() => void load()}>
              <RefreshCw size={16} className={busy === 'load' ? 'spin' : undefined} />刷新
            </button>
          </>
        }
      />

      {error && <div className="error-banner client-config-message" role="alert"><div><AlertTriangle size={16} /><span>{error}</span></div></div>}
      {notice && <div className="client-config-notice"><CheckCircle2 size={17} /><span>{notice}</span></div>}

      {busy === 'load' && statuses.length === 0 ? (
        <section className="panel"><div className="client-config-loading"><LoaderCircle size={20} className="spin" /><span>正在检测本机配置</span></div></section>
      ) : statuses.length === 0 ? (
        <section className="panel"><EmptyState icon={<FolderCog size={25} />} title="未能读取客户端配置" description="刷新后重试" /></section>
      ) : (
        <div className="client-config-grid">
          {statuses.map((status) => {
            const meta = clientMeta[status.client]
            const route = snapshot.routes.find((candidate) => candidate.client === status.client)
            const routeCompatible = route?.inboundProtocol === clientNativeProtocols[status.client]
            const clientBackups = backups[status.client] ?? []
            const clientBusy = busy?.endsWith(status.client) ?? false
            return (
              <article className="client-config-card" key={status.client}>
                <header className="client-config-card__header">
                  <span className="client-logo" style={{ '--client-color': meta.color } as React.CSSProperties}>{meta.mark}</span>
                  <div><h2>{meta.name}</h2><span className="mono">{status.directory}</span></div>
                  <Badge tone={status.configured ? 'success' : 'neutral'}>{status.configured ? '发现配置' : '尚未配置'}</Badge>
                </header>

                <div className="client-config-route">
                  <div><span>Stone 路由</span><strong>{routeCompatible ? route?.enabled ? '已启用' : '已停用' : '协议不兼容'}</strong></div>
                  <Badge tone={!routeCompatible ? 'danger' : route?.enabled ? 'success' : 'warning'}>{!routeCompatible ? '需修复路由' : route?.enabled ? '可连接' : '需启用路由'}</Badge>
                </div>

                <label className="client-profile-select">
                  <span>配置 Profile</span>
                  <div><select value={activeProfiles[status.client]} onChange={(event) => void selectProfile(status.client, event.target.value)}>
                      {snapshot.clientProfiles.filter((candidate) => candidate.client === status.client).map((candidate) => (
                        <option value={candidate.id} key={candidate.id}>{candidate.name}{candidate.directory ? ' · 自定义目录' : ''}</option>
                      ))}
                    </select>
                    {!snapshot.clientProfiles.find((candidate) => candidate.id === activeProfiles[status.client])?.isDefault && <><button className="text-button" type="button" onClick={() => editProfile(status.client)}>编辑</button><button className="icon-button" type="button" title="删除 Profile" onClick={() => void deleteProfile(status.client)}><Trash2 size={14} /></button></>}
                    <button className="icon-button" type="button" title="导出 Profile" onClick={() => void exportProfile(status.client)}><Download size={14} /></button>
                  </div>
                </label>

                <div className="client-config-files">
                  {status.files.map((file) => (
                    <div key={file.role}>
                      <FileCode2 size={16} />
                      <span><strong>{roleLabels[file.role]}</strong><code>{file.path}</code></span>
                      <Badge tone={file.exists ? 'neutral' : 'info'}>{file.exists ? '存在' : '将创建'}</Badge>
                    </div>
                  ))}
                </div>

                <div className="client-config-card__meta">
                  <span><ShieldCheck size={15} />写入前自动备份</span>
                  <span>{status.backupCount} 个历史备份</span>
                </div>

                {expandedBackups === status.client && (
                  <div className="client-backup-list">
                    {clientBackups.length ? clientBackups.map((backup) => (
                      <div key={backup.backupPath}>
                        <span><strong>{roleLabels[backup.role]}</strong><small>{formatDateTime(backup.createdAt)}</small></span>
                        <button className="icon-button" type="button" title="恢复此备份" disabled={clientBusy} onClick={() => setRestoreTarget(backup)}><RotateCcw size={15} /></button>
                      </div>
                    )) : <span className="client-backup-empty">暂无 Stone 备份</span>}
                  </div>
                )}

                <footer className="client-config-card__footer">
                  <button className="button button--secondary" type="button" disabled={clientBusy} onClick={() => void toggleBackups(status.client)}><History size={16} />备份</button>
                  <button className="button button--secondary" type="button" disabled={clientBusy} onClick={() => void openPreview(status.client)}>预览更改</button>
                  <button className="button button--secondary" type="button" disabled={clientBusy} onClick={() => void openEditor(status.client)}><Settings2 size={16} />配置</button>
                  <button className="button button--primary" type="button" disabled={clientBusy || !routeCompatible} onClick={() => void apply(status.client)}>{busy === `apply-${status.client}` ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}应用</button>
                </footer>
              </article>
            )
          })}
        </div>
      )}

      <Modal
        open={Boolean(editor)}
        title={editor ? `${clientMeta[editor.client].name} 配置` : '客户端配置'}
        description={editor ? snapshot.clientProfiles.find((candidate) => candidate.id === editor.profileId)?.name ?? '默认 Profile' : undefined}
        onClose={closeEditor}
        width="xlarge"
        footer={editor && <>
          <button className="button button--secondary" type="button" onClick={closeEditor}>取消</button>
          <button className="button button--primary" type="button" disabled={!editorIsDirty(editor, fieldDrafts, fileDrafts) || busy === `save-editor-${editor.client}`} onClick={() => void saveEditor()}>
            {busy === `save-editor-${editor.client}` ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}保存配置
          </button>
        </>}
      >
        {editor && <div className="client-editor">
          <div className="segmented-control client-editor__modes" role="tablist" aria-label="配置编辑视图">
            <button type="button" role="tab" aria-selected={editorMode === 'common'} className={editorMode === 'common' ? 'active' : ''} onClick={() => setEditorMode('common')}><Settings2 size={15} />常用设置</button>
            <button type="button" role="tab" aria-selected={editorMode === 'files'} className={editorMode === 'files' ? 'active' : ''} onClick={() => setEditorMode('files')}><Braces size={15} />完整文件</button>
          </div>
          {error && <div className="client-editor-error" role="alert"><AlertTriangle size={15} /><span>{error}</span></div>}

          {editorMode === 'common' ? (
            <div className="client-editor-fields">
              {[...new Set(editor.fields.map((field) => field.section))].map((section) => (
                <section className="client-editor-section" key={section}>
                  <header><h3>{section}</h3></header>
                  <div>
                    {editor.fields.filter((field) => field.section === section).map((field) => (
                      <div className="client-editor-field" key={field.id}>
                        <label htmlFor={`client-field-${field.id}`}>{field.label}</label>
                        <div className="client-editor-field__control">
                          {field.control === 'toggle' ? (
                            <Toggle checked={fieldDrafts[field.id] === true} onChange={(value) => setFieldDrafts((current) => ({ ...current, [field.id]: value }))} label={field.label} />
                          ) : field.control === 'select' ? (
                            <select id={`client-field-${field.id}`} value={configStringValue(fieldDrafts[field.id])} onChange={(event) => setFieldDrafts((current) => ({ ...current, [field.id]: event.target.value || null }))}>
                              <option value="">使用默认值</option>
                              {field.options?.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}
                            </select>
                          ) : field.control === 'string-list' ? (
                            <textarea id={`client-field-${field.id}`} className="mono" rows={3} value={configListValue(fieldDrafts[field.id])} onChange={(event) => setFieldDrafts((current) => ({ ...current, [field.id]: event.target.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) }))} />
                          ) : (
                            <input id={`client-field-${field.id}`} value={configStringValue(fieldDrafts[field.id])} placeholder={field.placeholder} onChange={(event) => setFieldDrafts((current) => ({ ...current, [field.id]: event.target.value || null }))} />
                          )}
                          <button className="icon-button" type="button" title={`恢复 ${field.label} 默认值`} onClick={() => setFieldDrafts((current) => ({ ...current, [field.id]: null }))}><RotateCcw size={14} /></button>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="client-editor-files">
              <div className="client-editor-file-tabs" role="tablist" aria-label="配置文件">
                {editor.files.map((file) => (
                  <button type="button" role="tab" aria-selected={activeEditorRole === file.role} className={activeEditorRole === file.role ? 'active' : ''} onClick={() => setActiveEditorRole(file.role)} key={file.role}>
                    <FileCode2 size={14} /><span>{roleLabels[file.role]}</span>{file.protectedValueCount > 0 && <ShieldCheck size={13} />}
                  </button>
                ))}
              </div>
              {editor.files.filter((file) => file.role === activeEditorRole).map((file) => (
                <div className="client-editor-document" key={file.role}>
                  <header><code>{file.path}</code><div><Badge tone={file.exists ? 'neutral' : 'info'}>{file.exists ? '当前文件' : '新文件'}</Badge>{file.protectedValueCount > 0 && <Badge tone="success">{file.protectedValueCount} 个值已保护</Badge>}</div></header>
                  {file.editable ? (
                    <textarea className="client-source-editor mono" spellCheck={false} value={fileDrafts[file.role] ?? ''} onChange={(event) => setFileDrafts((current) => ({ ...current, [file.role]: event.target.value }))} />
                  ) : (
                    <div className="client-editor-protected"><ShieldCheck size={24} /><strong>认证文件受保护</strong></div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>}
      </Modal>

      <Modal
        open={Boolean(preview)}
        title={preview ? `${clientMeta[preview.client].name} 配置预览` : '配置预览'}
        description="只显示 Stone 将管理的文件，不读取其他凭据到界面"
        onClose={() => setPreview(null)}
        width="medium"
        footer={preview && <><button className="button button--secondary" type="button" onClick={() => setPreview(null)}>取消</button><button className="button button--primary" type="button" disabled={busy === `apply-${preview.client}`} onClick={() => void apply(preview.client)}><Save size={16} />确认应用</button></>}
      >
        {preview && <div className="client-preview-list">{preview.files.map((file) => <div key={file.role}><FileCode2 size={17} /><span><strong>{roleLabels[file.role]}</strong><code>{file.path}</code><small>字段：{file.managedFields.join('、')}</small></span><Badge tone={!file.changed ? 'success' : file.existed ? 'warning' : 'info'}>{!file.changed ? '无需更改' : file.existed ? '将更新' : '将创建'}</Badge></div>)}</div>}
      </Modal>

      <ConfirmDialog
        open={Boolean(restoreTarget)}
        title="恢复客户端配置"
        message={restoreTarget ? `恢复 ${roleLabels[restoreTarget.role]} 到 ${formatDateTime(restoreTarget.createdAt)} 的版本吗？当前文件会先创建安全备份。` : ''}
        confirmLabel="恢复备份"
        busy={Boolean(restoreTarget && busy === `restore-${restoreTarget.client}`)}
        onCancel={() => setRestoreTarget(null)}
        onConfirm={() => void restore()}
      />

      <Modal
        open={Boolean(profileBundle)}
        title="Profile 导入 / 导出"
        description="JSON 只包含 Profile 路径与备份策略，不包含配置正文或 Token。"
        onClose={() => setProfileBundle('')}
        width="large"
        footer={<><button className="button button--secondary" type="button" onClick={() => navigator.clipboard?.writeText(profileBundle)}>复制</button><button className="button button--primary" type="button" onClick={() => void importProfile()}><Upload size={16} />导入为新 Profile</button></>}
      >
        <textarea className="profile-bundle-editor mono" rows={14} value={profileBundle} onChange={(event) => setProfileBundle(event.target.value)} />
      </Modal>

      <Modal
        open={Boolean(profile)}
        title={profile?.id ? '编辑客户端配置 Profile' : '新建客户端配置 Profile'}
        description="Profile 只保存目录和备份策略，不保存客户端文件内容"
        onClose={() => setProfile(null)}
        width="medium"
        footer={<><button className="button button--secondary" type="button" onClick={() => setProfile(null)}>取消</button><button className="button button--primary" type="submit" form="client-profile-form" disabled={busy === 'save-profile'}><Save size={16} />保存 Profile</button></>}
      >
        {profile && <form id="client-profile-form" className="form-grid" onSubmit={(event) => void saveProfile(event)}>
          <label className="field"><span>客户端</span><select value={profile.client} disabled={Boolean(profile.id)} onChange={(event) => setProfile({ ...profile, client: event.target.value as RouteClient })}><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="gemini">Gemini CLI</option></select>{profile.id && <small>已有 Profile 的客户端不可修改</small>}</label>
          <label className="field"><span>Profile 名称</span><input required value={profile.name} onChange={(event) => setProfile({ ...profile, name: event.target.value })} placeholder="例如：工作配置" /></label>
          <label className="field field--full"><span>自定义配置目录</span><input className="mono" value={profile.directory ?? ''} onChange={(event) => setProfile({ ...profile, directory: event.target.value })} placeholder="留空使用默认目录；填写绝对路径" /><small>Stone 不会扫描该目录之外的文件</small></label>
          <label className="field"><span>每个文件保留备份</span><input type="number" min={1} max={100} value={profile.backupRetention} onChange={(event) => setProfile({ ...profile, backupRetention: Number(event.target.value) })} /></label>
        </form>}
      </Modal>
    </div>
  )
}

function sameConfigValue(left: ClientConfigFieldValue, right: ClientConfigFieldValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function configStringValue(value: ClientConfigFieldValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function configListValue(value: ClientConfigFieldValue | undefined): string {
  return Array.isArray(value) ? value.join('\n') : ''
}

function editorIsDirty(
  editor: ClientConfigEditorState,
  fields: Record<string, ClientConfigFieldValue>,
  files: Record<string, string>,
): boolean {
  return editor.fields.some((field) => !sameConfigValue(field.value, fields[field.id] ?? null))
    || editor.files.some((file) => file.editable && file.content !== undefined && files[file.role] !== file.content)
}

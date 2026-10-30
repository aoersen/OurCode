import { useEffect, useState } from 'react'

import { getLocale } from '@/i18n'
import { useI18n } from '@/i18n/useI18n'
import { CLAW_CHANNELS, DEFAULT_CLAW_POLICY, type ClawChannelField, type ClawChannelId } from '@shared/claw'
import ClawAccessControlEditor from '@/components/Claw/ClawAccessControlEditor'
import ClawChannelIcon from '@/components/Claw/ClawChannelIcon'
import ClawConnectionPanel from '@/components/Claw/ClawConnectionPanel'
import { useClawStore } from '@/stores/clawStore'
import { useConfigStore } from '@/stores/configStore'
import { useEditorStore } from '@/stores/editorStore'
import { useUIStore } from '@/stores/uiStore'
import type { ClawAccessPolicy, ClawChannelConfig, ModelInfo } from '@/types'

const inputCls = 'px-2.5 py-1.5 rounded-md text-[12px] leading-[18px] outline-none transition-colors'
const inputStyle = { background: 'var(--hover)', border: '1px solid var(--border)', color: 'var(--text-primary)' }

/**
 * 设置 → 功能 → Claw 接入。
 *
 * 结构：总开关 → 渠道标签行（每个渠道一张连接卡片）→ 选中渠道的凭据表单 +
 * 连接状态 → 该渠道的接入控制 → 共享的 Agent 状态（工作区/模型/审批/记忆）。
 *
 * 「一个 Agent，多渠道」的分工在这里最直观：Agent 状态是共享的（改一次所有渠道
 * 都变），凭据与接入控制是每渠道独立的。
 */
export default function ClawSettingsSection() {
  const t = useI18n()
  const { preferences, savePreferences } = useEditorStore()
  const { configGroups, fetchModelsForGroup } = useConfigStore()
  const hub = useClawStore((s) => s.hub)
  const configs = useClawStore((s) => s.configs)
  const refreshStatus = useClawStore((s) => s.refreshStatus)
  const saveChannel = useClawStore((s) => s.saveChannel)
  const setChannelEnabled = useClawStore((s) => s.setChannelEnabled)
  const agentState = useClawStore((s) => s.agentState)
  const saveAgentState = useClawStore((s) => s.saveAgentState)

  // 打开设置时的目标渠道（Claw 面板「去设置」带过来的）；没有就停在微信。
  const settingsTarget = useUIStore((s) => s.settingsTarget)
  const [activeId, setActiveId] = useState<ClawChannelId>(settingsTarget?.clawChannel ?? 'wechat')
  const [groupModels, setGroupModels] = useState<ModelInfo[]>([])
  const [savedFlash, setSavedFlash] = useState(false)
  /** 凭据表单的本地草稿：输入过程中不落库（否则每敲一个字符都会重启渠道进程），
   *  失焦时才提交。null = 未编辑，显示库里的值。 */
  const [draft, setDraft] = useState<Record<string, string> | null>(null)

  const masterEnabled = preferences.clawEnabled !== false
  const activeMeta = CLAW_CHANNELS.find((c) => c.id === activeId) ?? CLAW_CHANNELS[0]
  // 渠道目录里的字段说明是双语的（中文为主、英文备查）；界面语言决定用哪一份。
  const isZh = getLocale() === 'zh-CN'
  const activeConfig = configs.find((c) => c.id === activeId)
  const activeStatus = hub?.channels.find((c) => c.id === activeId)

  const workspaceDir = preferences.clawWorkspaceDir ?? ''
  const approvalMode = agentState?.approvalMode ?? preferences.clawApprovalMode ?? 'approve'
  const groupIdPref = agentState?.configGroupId ?? preferences.clawConfigGroupId ?? ''
  const selectedGroup = configGroups.find((g) => g.id === groupIdPref) ?? configGroups[0]
  const selectedGroupId = selectedGroup?.id
  const modelIdPref = agentState?.modelId ?? preferences.clawModelId ?? ''
  const agentWorkspace = agentState?.currentWorkspace || agentState?.sandboxPath || ''

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  // 切换渠道时丢弃草稿（避免把 A 渠道没提交的输入写到 B 渠道上）
  useEffect(() => {
    setDraft(null)
  }, [activeId])

  // 面板上的「去设置」可能是对另一个渠道发起的：跟着切过去。
  useEffect(() => {
    if (settingsTarget?.clawChannel) setActiveId(settingsTarget.clawChannel)
  }, [settingsTarget])

  // 组变化时拉取其模型列表；失败则回退到「默认模型」单选项。
  useEffect(() => {
    let cancelled = false
    setGroupModels([])
    const group = selectedGroupId ? configGroups.find((g) => g.id === selectedGroupId) : undefined
    if (group) {
      fetchModelsForGroup(group)
        .then((ms) => {
          if (!cancelled) setGroupModels(ms)
        })
        .catch(() => {
          if (!cancelled) setGroupModels([])
        })
    }
    return () => {
      cancelled = true
    }
  }, [selectedGroupId, configGroups, fetchModelsForGroup])

  const modelOptions = Array.from(
    new Set([...groupModels.map((m) => m.id), ...(selectedGroup?.defaultModel ? [selectedGroup.defaultModel] : [])]),
  )

  const patchConfig = async (patch: Partial<ClawChannelConfig>) => {
    const base: ClawChannelConfig =
      activeConfig ?? {
        id: activeId,
        enabled: false,
        values: {},
        policy: { ...DEFAULT_CLAW_POLICY },
        updatedAt: Date.now(),
      }
    const next: ClawChannelConfig = { ...base, ...patch, updatedAt: Date.now() }
    const res = await saveChannel(next)
    if (res.ok) {
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 1500)
    }
  }

  const patchPolicy = (policy: ClawAccessPolicy) => void patchConfig({ policy })

  /** 当前显示的凭据值：编辑中看草稿，否则看库里的值。 */
  const values = draft ?? activeConfig?.values ?? {}

  /**
   * 提交草稿（失焦时调用）。逐字段改动都走这里，但只有真的变了才写库，
   * 因此「点一下输入框又离开」不会触发保存、也不会打断渠道连接。
   */
  const commitDraft = () => {
    if (!draft) return
    const current = activeConfig?.values ?? {}
    const changed = Object.keys(draft).some((k) => draft[k] !== current[k])
    setDraft(null)
    if (changed) void patchConfig({ values: draft })
  }

  const pickGroup = (id: string) => {
    // 换组后原组模型在新组大概率不可用：清掉模型偏好，回退到新组默认模型。
    void savePreferences({ clawConfigGroupId: id, clawModelId: '' })
    void saveAgentState({ configGroupId: id, modelId: null })
  }

  const pickModel = (id: string) => {
    void savePreferences({ clawModelId: id })
    void saveAgentState({ modelId: id || null })
  }

  const pickApprovalMode = (mode: 'approve' | 'full_access') => {
    void savePreferences({ clawApprovalMode: mode })
    void saveAgentState({ approvalMode: mode })
  }

  const toggleMaster = (on: boolean) => {
    void savePreferences({ clawEnabled: on })
    // 总开关落在主进程：关 = 停全部渠道进程，开 = 按各渠道自己的开关恢复。
    // 渲染层只负责记录偏好并通知，不去改每个渠道的 enabled（否则关一次总开关
    // 会把用户的渠道选择一起抹掉）。
    void window.electronAPI.setClawMasterEnabled(on).then(() => refreshStatus())
  }

  const pickWorkspace = async () => {
    const dir = await window.electronAPI.openFolder()
    if (!dir) return
    // 「设置即信任」：用户主动选择的目录注册为受信任根，接入会话的文件读写
    // 无需再弹原生授权框（与打开项目的信任流程一致）。
    await window.electronAPI.openProject(dir)
    void savePreferences({ clawWorkspaceDir: dir })
    // 仅当 agent 从未切换过工作区时，初始工作区才同步生效。
    if (!agentState?.currentWorkspace) void saveAgentState({ currentWorkspace: dir })
  }

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-nova-border bg-nova-card px-5 py-4">
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h3 className="text-[14px] leading-[20px] font-semibold text-nova-text-primary">
            {t('claw.settingsTitle')}
          </h3>
          <p className="text-[12px] leading-[18px] text-nova-text-muted">
            {t('claw.settingsSubtitle')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {savedFlash && (
            <span className="text-[12px] leading-[18px]" style={{ color: 'var(--success)' }}>
              {t('claw.saved')}
            </span>
          )}
          <span className="text-[12px] leading-[18px]" style={{ color: 'var(--text-muted)' }}>
            {t('claw.masterSwitch')}
          </span>
          <Toggle on={masterEnabled} onClick={() => toggleMaster(!masterEnabled)} label={t('claw.masterSwitch')} />
        </div>
      </header>

      {/* 渠道标签行 */}
      <div className="flex flex-wrap items-center gap-1.5">
        {CLAW_CHANNELS.map((meta) => {
          const status = hub?.channels.find((c) => c.id === meta.id)
          const cfg = configs.find((c) => c.id === meta.id)
          const on = cfg?.enabled ?? status?.enabled ?? false
          const dot = !on
            ? 'var(--text-muted)'
            : status?.state === 'connected'
              ? 'var(--success)'
              : status?.configured
                ? 'var(--warning)'
                : 'var(--text-muted)'
          const isActive = meta.id === activeId
          return (
            <button
              key={meta.id}
              onClick={() => setActiveId(meta.id)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[12px] leading-[18px] transition-colors"
              style={{
                background: isActive ? 'var(--bg-selected)' : 'var(--card)',
                border: `1px solid ${isActive ? 'color-mix(in srgb, var(--accent) 40%, transparent)' : 'var(--border)'}`,
                color: isActive ? 'var(--accent-text)' : 'var(--text-secondary)',
              }}
            >
              <span className="inline-block rounded-full" style={{ width: 6, height: 6, background: dot }} />
              {meta.label}
            </button>
          )
        })}
      </div>

      {/* 选中渠道：连接 + 凭据 */}
      <div
        className="rounded-xl px-4 py-3.5 flex flex-col gap-3"
        
      >
        <div className="flex items-center gap-3">
          <ClawChannelIcon id={activeMeta.id} color={activeMeta.brandColor} size={32} radius={10} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[13px] leading-[18px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                {activeMeta.label}
              </span>
              {activeMeta.maturity === 'beta' && (
                <span
                  className="px-1.5 py-[1px] text-[12px] leading-[18px] font-semibold rounded-full uppercase"
                  style={{ background: 'var(--hover)', color: 'var(--text-muted)' }}
                  title={t('claw.betaHint')}
                >
                  beta
                </span>
              )}
            </div>
            <span className="text-[12px] leading-[18px]" style={{ color: 'var(--text-muted)' }}>
              {isZh ? activeMeta.description : activeMeta.descriptionEn}
            </span>
          </div>
          <span className="text-[12px] leading-[18px] shrink-0" style={{ color: 'var(--text-muted)' }}>
            {t('claw.channelEnable')}
          </span>
          <Toggle
            on={activeConfig?.enabled ?? false}
            onClick={() => void setChannelEnabled(activeId, !(activeConfig?.enabled ?? false))}
            label={t('claw.channelEnable')}
          />
        </div>

        {/* 凭据表单 */}
        {activeMeta.fields.length > 0 && (
          <div className="grid grid-cols-2 gap-3">
            {activeMeta.fields.map((field) => (
              <FieldInput
                key={field.key}
                field={field}
                zh={isZh}
                value={values[field.key] ?? ''}
                onChange={(value) => setDraft({ ...values, [field.key]: value })}
                onBlur={commitDraft}
              />
            ))}
          </div>
        )}

        <ClawConnectionPanel meta={activeMeta} status={activeStatus} config={activeConfig} />

        {/* 凭据去哪拿、连接方式是什么——直接写在界面上，用户不用翻文档 */}
        <div className="flex flex-col gap-0.5">
          <span className="text-[12px] leading-[18px] leading-4" style={{ color: 'var(--text-secondary)' }}>
            {t('claw.connectionMode')}
          </span>
          <span className="text-[12px] leading-[18px] leading-4" style={{ color: 'var(--text-muted)' }}>
            {isZh ? activeMeta.credentialHint : activeMeta.credentialHintEn}
          </span>
        </div>
      </div>

      {/* 接入控制（每渠道一份） */}
      <div className="flex flex-col gap-2">
        <div>
          <h4 className="text-[13px] leading-[18px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            {t('claw.accessControlTitle', { name: activeMeta.label })}
          </h4>
          <p className="text-[12px] leading-[18px] leading-4" style={{ color: 'var(--text-muted)' }}>
            {t('claw.accessControlSubtitle')}
          </p>
        </div>
        <ClawAccessControlEditor
          policy={activeConfig?.policy ?? DEFAULT_CLAW_POLICY}
          onChange={patchPolicy}
        />
      </div>

      {/* Agent 状态（跨渠道共享） */}
      <div className="flex flex-col gap-2">
        <div>
          <h4 className="text-[13px] leading-[18px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            {t('claw.agentStateTitle')}
          </h4>
          <p className="text-[12px] leading-[18px] leading-4" style={{ color: 'var(--text-muted)' }}>
            {t('claw.agentStateSubtitle')}
          </p>
        </div>

        <Row
          label={t('claw.agentWorkspace')}
          desc={t('claw.agentWorkspaceDesc')}
          right={
            <div className="flex flex-col items-end gap-0.5 text-[12px] leading-[18px] max-w-[320px]" style={{ color: 'var(--text-secondary)' }}>
              <span className="truncate">
                {agentWorkspace
                  ? agentState?.currentWorkspace ?? t('claw.sandboxLabel', { path: agentState?.sandboxPath ?? '' })
                  : t('claw.notInitialized')}
              </span>
              <span>
                {t('claw.approvalMode')}：{agentState?.approvalMode === 'full_access' ? t('claw.approvalFull') : t('claw.approvalAsk')}
                {' · '}
                {t('claw.memoryCount', { count: agentState?.memory?.length ?? 0 })}
              </span>
            </div>
          }
        />

        <Row
          label={t('claw.agentGroup')}
          desc={t('claw.agentGroupDesc')}
          right={
            <select
              aria-label="渠道使用的配置组" value={selectedGroup?.id ?? ''}
              onChange={(e) => pickGroup(e.target.value)}
              className={`${inputCls} max-w-[240px]`}
              style={inputStyle}
            >
              {configGroups.length === 0 && <option value="">{t('claw.noGroup')}</option>}
              {configGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}（{g.defaultModel || t('claw.defaultModel')}）
                </option>
              ))}
            </select>
          }
        />

        <Row
          label={t('claw.agentModel')}
          desc={
            selectedGroup?.defaultModel
              ? t('claw.agentModelDesc', { model: selectedGroup.defaultModel })
              : t('claw.agentModelDescNoDefault')
          }
          right={
            <select
              aria-label="渠道模型" value={modelOptions.includes(modelIdPref) ? modelIdPref : ''}
              onChange={(e) => pickModel(e.target.value)}
              disabled={modelOptions.length === 0}
              className={`${inputCls} max-w-[240px] disabled:opacity-50`}
              style={inputStyle}
            >
              <option value="">{t('claw.groupDefaultModel')}</option>
              {modelOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          }
        />

        <Row
          label={t('claw.agentApproval')}
          desc={t('claw.agentApprovalDesc')}
          right={
            <select
              aria-label="权限审批模式" value={approvalMode}
              onChange={(e) => pickApprovalMode(e.target.value as 'approve' | 'full_access')}
              className={inputCls}
              style={inputStyle}
            >
              <option value="approve">{t('claw.approvalAsk')}</option>
              <option value="full_access">{t('claw.approvalFull')}</option>
            </select>
          }
        />

        <Row
          label={t('claw.agentInitialWorkspace')}
          desc={t('claw.agentInitialWorkspaceDesc')}
          right={
            <div className="flex items-center gap-1.5">
              <input
                aria-label="工作区目录" type="text"
                value={workspaceDir}
                onChange={(e) => {
                  void savePreferences({ clawWorkspaceDir: e.target.value })
                  // 仅当 agent 从未切换过工作区时，初始工作区才同步生效。
                  if (!agentState?.currentWorkspace) void saveAgentState({ currentWorkspace: e.target.value.trim() || null })
                }}
                placeholder={t('claw.workspacePlaceholder')}
                className={`${inputCls} font-mono w-[240px]`}
                style={inputStyle}
              />
              <button
                className="px-2.5 py-1.5 text-[12px] leading-[18px] rounded-md shrink-0"
                style={{ background: 'var(--hover)', color: 'var(--text-secondary)' }}
                onClick={() => void pickWorkspace()}
              >
                {t('claw.browse')}
              </button>
            </div>
          }
        />
      </div>
    </section>
  )
}

function FieldInput({
  field,
  value,
  onChange,
  onBlur,
  zh,
}: {
  field: ClawChannelField
  value: string
  onChange: (value: string) => void
  /** 失焦提交：输入过程中不落库（避免频繁重启渠道进程）。 */
  onBlur: () => void
  zh: boolean
}) {
  const label = zh ? field.label : field.labelEn
  const help = zh ? field.help : field.helpEn
  return (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="text-[12px] leading-[18px] font-medium" style={{ color: 'var(--text-secondary)' }}>
        {label}
        {field.required && <span style={{ color: 'var(--error)' }}> *</span>}
      </span>
      <input
        type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={field.placeholder}
        className={`${inputCls} ${field.type === 'password' ? 'font-mono' : ''}`}
        style={inputStyle}
        autoComplete="off"
      />
      {help && (
        <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
          {help}
        </span>
      )}
    </label>
  )
}

function Row({ label, desc, right }: { label: string; desc: string; right: React.ReactNode }) {
  return (
    <div
      className="flex items-center justify-between gap-6 border-b border-nova-border py-3 last:border-b-0"
      
    >
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-[13px] leading-[18px] font-medium" style={{ color: 'var(--text-primary)' }}>
          {label}
        </span>
        <span className="text-[12px] leading-[18px] leading-4" style={{ color: 'var(--text-muted)' }}>
          {desc}
        </span>
      </div>
      <div className="shrink-0">{right}</div>
    </div>
  )
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-pressed={on}
      className="relative h-5 w-9 shrink-0 rounded-full border border-transparent cursor-pointer transition-colors"
      style={{ background: on ? 'var(--accent)' : 'var(--border-strong)' }}
    >
      <span
        className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform"
        style={{ transform: on ? 'translateX(16px)' : 'translateX(0)' }}
      />
    </button>
  )
}

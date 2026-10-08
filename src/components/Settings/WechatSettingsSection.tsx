import { useEffect, useState } from 'react'

import { useConfigStore } from '@/stores/configStore'
import { useEditorStore } from '@/stores/editorStore'
import { useWechatStore } from '@/stores/wechatStore'
import type { ModelInfo, WechatChannelState } from '@/types'

const STATE_META: Record<WechatChannelState, { label: string; color: string }> = {
  idle: { label: '未登录', color: '#8b8fa3' },
  loggingIn: { label: '登录中', color: '#4a9eff' },
  connected: { label: '已连接', color: '#34d399' },
  disconnected: { label: '已断开', color: '#fbbf24' },
  stopped: { label: '未启动', color: '#8b8fa3' },
}

function Row({ label, desc, right }: { label: string; desc: string; right: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 bg-nova-card border border-nova-border rounded-lg gap-4 hover:border-nova-border-strong transition-colors">
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-[13px] font-medium text-nova-text-primary">{label}</span>
        <span className="text-[11px] text-nova-text-muted">{desc}</span>
      </div>
      <div className="flex items-center gap-2.5 shrink-0">{right}</div>
    </div>
  )
}

function Toggle({ on, onClick, disabled = false }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-10 h-[22px] rounded-full transition-colors relative shrink-0 border-none ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
      style={{ background: on ? 'var(--accent)' : 'var(--border)' }}
    >
      <div
        className="w-[18px] h-[18px] rounded-full bg-white absolute top-[1px] transition-all"
        style={{ left: on ? '20px' : '1px' }}
      />
    </button>
  )
}

const smallBtn =
  'px-2.5 py-1.5 text-xs bg-nova-hover text-nova-text-secondary rounded-md hover:text-nova-text-primary transition-colors disabled:opacity-50 shrink-0'
const accentBtn =
  'px-3 py-1.5 text-xs text-nova-accent bg-nova-accent/10 hover:bg-nova-accent/20 rounded-md transition-colors disabled:opacity-50 shrink-0'

/**
 * 设置 → 功能 → 微信通道。扫码登录走官方 ilink 协议（网关子进程完成），
 * 二维码以链接形式给出（复制到浏览器打开扫码即可）。
 */
export default function WechatSettingsSection() {
  const { preferences, savePreferences } = useEditorStore()
  const { configGroups, fetchModelsForGroup } = useConfigStore()
  const {
    state, qrUrl, scanned, needVerifyCode, verifyBlocked, notice,
    startLogin, submitVerifyCode, logout, clearNotice, agentState, saveAgentState,
  } = useWechatStore()
  const [verifyCode, setVerifyCode] = useState('')
  const [groupModels, setGroupModels] = useState<ModelInfo[]>([])

  const enabled = preferences.wechatEnabled !== false
  const meta = STATE_META[state]
  const workspaceDir = preferences.wechatWorkspaceDir ?? ''
  // AgentState 是运行期权威（对话可调）；偏好仅作初始值/回退。
  const approvalMode = agentState?.approvalMode ?? preferences.wechatApprovalMode ?? 'approve'
  const groupIdPref = agentState?.configGroupId ?? preferences.wechatConfigGroupId ?? ''
  const selectedGroup = configGroups.find((g) => g.id === groupIdPref) ?? configGroups[0]
  const selectedGroupId = selectedGroup?.id
  const modelIdPref = agentState?.modelId ?? preferences.wechatModelId ?? ''
  // Agent 状态是运行期权威（对话可调）：面板显示的是 agent 的实际状态。
  const agentWorkspace = agentState?.currentWorkspace || agentState?.sandboxPath || ''

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
    new Set([
      ...groupModels.map((m) => m.id),
      ...(selectedGroup?.defaultModel ? [selectedGroup.defaultModel] : []),
    ]),
  )

  const pickGroup = (id: string) => {
    // 换组后原组模型在新组大概率不可用：清掉模型偏好，回退到新组默认模型。
    void savePreferences({ wechatConfigGroupId: id, wechatModelId: '' })
    // 同步到 Agent 状态（运行期权威，可在微信里用 /group 随时改）。
    void saveAgentState({ configGroupId: id, modelId: null })
  }

  const pickModel = (id: string) => {
    void savePreferences({ wechatModelId: id })
    void saveAgentState({ modelId: id || null })
  }

  const pickApprovalMode = (mode: 'approve' | 'full_access') => {
    void savePreferences({ wechatApprovalMode: mode })
    void saveAgentState({ approvalMode: mode })
  }

  const toggleEnabled = (on: boolean) => {
    void savePreferences({ wechatEnabled: on })
    void window.electronAPI.wechatSetEnabled(on)
  }

  const pickWorkspace = async () => {
    const dir = await window.electronAPI.openFolder()
    if (!dir) return
    // 「设置即信任」：用户主动选择的目录注册为受信任根，微信会话的
    // 文件读写无需再弹原生授权框（与打开项目的信任流程一致）。
    await window.electronAPI.openProject(dir)
    void savePreferences({ wechatWorkspaceDir: dir })
    // 仅当 agent 从未切换过工作区时，初始工作区才同步生效。
    if (!agentState?.currentWorkspace) void saveAgentState({ currentWorkspace: dir })
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 text-[13px] font-semibold text-nova-text-primary uppercase tracking-wider">
        <span style={{ width: 3, height: 14, background: 'var(--accent)', borderRadius: 2 }} />
        微信通道
      </h3>

      <Row label="启用微信通道" desc="启动即拉起微信网关；已登录时自动恢复收发，微信消息会驱动 AI 助手在当前工作区工作" right={
        <Toggle on={enabled} onClick={() => toggleEnabled(!enabled)} />
      } />

      <Row label="连接状态" desc="当前微信网关与登录状态" right={
        <div className="flex items-center gap-1.5 text-xs">
          <span className="inline-block w-2 h-2 rounded-full" style={{ background: meta.color }} />
          <span className="text-nova-text-primary">{meta.label}</span>
        </div>
      } />

      <Row label="Agent 状态" desc="微信 Agent 当前工作区与审批模式（在微信里发「状态」或 /status 查看，/workspace 切换）" right={
        <div className="flex flex-col items-end gap-0.5 text-[11px] text-nova-text-secondary max-w-[320px]">
          <span className="truncate">工作区：{agentWorkspace ? (agentState?.currentWorkspace ?? `沙盒（${agentState?.sandboxPath}）`) : '未初始化'}</span>
          <span>审批：{agentState?.approvalMode === 'full_access' ? '免审批' : '逐条审批'}</span>
        </div>
      } />

      {state !== 'connected' && (
        <Row label="扫码登录" desc="用手机微信扫码后，本机即可通过微信与 AI 对话（官方通道，凭据仅保存在本机）" right={
          <button className={accentBtn} onClick={() => void startLogin()} disabled={state === 'loggingIn' || !enabled}>
            {state === 'loggingIn' ? '登录中…' : '获取二维码'}
          </button>
        } />
      )}

      {qrUrl && (
        <div className="flex flex-col gap-2 px-4 py-3 bg-nova-card border border-nova-border rounded-lg">
          <span className="text-[13px] font-medium text-nova-text-primary">{scanned ? '已扫码，请在手机上确认 ✅' : '请用手机微信扫码'}</span>
          {needVerifyCode ? (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={verifyCode}
                onChange={(e) => setVerifyCode(e.target.value)}
                placeholder="输入手机上显示的数字"
                className="px-2.5 py-1.5 bg-nova-input-bg border border-nova-border rounded-md text-xs text-nova-text-primary outline-none focus:border-nova-accent/50 transition-colors font-mono w-[220px]"
              />
              <button className={accentBtn} onClick={() => { void submitVerifyCode(verifyCode); setVerifyCode('') }}>
                提交
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <a href={qrUrl} target="_blank" rel="noreferrer" className="text-xs text-nova-accent underline truncate max-w-[320px]">
                {qrUrl}
              </a>
              <button className={smallBtn} onClick={() => void navigator.clipboard?.writeText(qrUrl)}>
                复制
              </button>
            </div>
          )}
          {verifyBlocked && <span className="text-[11px] text-amber-400">验证码错误，二维码已刷新，请重新扫码</span>}
        </div>
      )}

      {notice && (
        <div className="flex items-center justify-between px-4 py-2 bg-nova-card border border-red-400/30 rounded-lg">
          <span className="text-[11px] text-red-400">{notice}</span>
          <button className={smallBtn} onClick={clearNotice}>关闭</button>
        </div>
      )}

      {state === 'connected' && (
        <Row label="登出" desc="断开微信连接并清除本机保存的登录凭据" right={
          <button className={accentBtn} onClick={() => void logout()}>登出</button>
        } />
      )}

      <Row label="微信模型组" desc="微信会话使用哪个 API 配置组（无可用组时微信消息无法驱动 AI，需先在 API 配置里添加）" right={
        <select
          value={selectedGroup?.id ?? ''}
          onChange={(e) => pickGroup(e.target.value)}
          className="px-2.5 py-1.5 bg-nova-input-bg border border-nova-border rounded-md text-xs text-nova-text-primary outline-none focus:border-nova-accent/50 transition-colors max-w-[240px]"
        >
          {configGroups.length === 0 && <option value="">（无可用配置组）</option>}
          {configGroups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}（{g.defaultModel || '默认模型'}）
            </option>
          ))}
        </select>
      } />

      <Row label="微信模型" desc={`初始模型：留空 = 跟随模型组的默认模型${selectedGroup?.defaultModel ? `（${selectedGroup.defaultModel}）` : ''}；可在微信里用 /model 随时改`} right={
        <select
          value={modelOptions.includes(modelIdPref) ? modelIdPref : ''}
          onChange={(e) => pickModel(e.target.value)}
          disabled={modelOptions.length === 0}
          className="px-2.5 py-1.5 bg-nova-input-bg border border-nova-border rounded-md text-xs text-nova-text-primary outline-none focus:border-nova-accent/50 transition-colors max-w-[240px] disabled:opacity-50"
        >
          <option value="">（组的默认模型）</option>
          {modelOptions.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      } />

      <Row label="审批模式" desc="初始审批模式：逐条审批 = 写文件/执行命令前发微信确认；免审批 = 直接执行。可在微信里用 /mode 随时改" right={
        <select
          value={approvalMode}
          onChange={(e) => pickApprovalMode(e.target.value as 'approve' | 'full_access')}
          className="px-2.5 py-1.5 bg-nova-input-bg border border-nova-border rounded-md text-xs text-nova-text-primary outline-none focus:border-nova-accent/50 transition-colors"
        >
          <option value="approve">逐条审批</option>
          <option value="full_access">免审批</option>
        </select>
      } />

      <Row label="初始工作区" desc="微信 Agent 起步工作区（历史兼容）：留空 = 从独立沙盒开始，此后在微信里用 /workspace 随时切换" right={
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={workspaceDir}
            onChange={(e) => {
              void savePreferences({ wechatWorkspaceDir: e.target.value })
              // 仅当 agent 从未切换过工作区时，初始工作区才同步生效。
              if (!agentState?.currentWorkspace) void saveAgentState({ currentWorkspace: e.target.value.trim() || null })
            }}
            placeholder="留空 = 沙盒起步"
            className="px-2.5 py-1.5 bg-nova-input-bg border border-nova-border rounded-md text-xs text-nova-text-primary outline-none focus:border-nova-accent/50 transition-colors font-mono w-[240px]"
          />
          <button className={smallBtn} onClick={() => void pickWorkspace()}>浏览…</button>
        </div>
      } />
    </section>
  )
}

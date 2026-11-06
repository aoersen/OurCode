/**
 * 公司看板「MCP 服务器分配」面板 v2 —— 角色优先的双栏授权台。
 *
 * v1 的问题（用户反馈）：五个角色五把「跟随默认」下拉，信息量几乎为零；
 * 真正需要决策的东西（这个角色实际能用哪些服务器）藏在「自选」之后；
 * 默认档和角色行长得一样，没有层级；服务器多了只能逐条点。
 *
 * v2 结构（设计稿：Stitch 「MCP 服务器分配弹窗 · 双列紧凑无截断版」）：
 *  - 左栏：默认档（分段控件）+ 角色检索 + 角色列表（每行带解析结果胶囊）+ 批量恢复；
 *  - 右栏：选中角色 → 三态分段（跟随默认/全部/自选）+ 实际生效 chip 条 +
 *    双列服务器勾选网格（带运行状态点、全选/清空、检索）；
 *  - 底栏：脏状态 + 取消 / 保存分配。
 *
 * 语义不变：未单独分配的角色吃默认档（默认 all，含以后新装的）；分配即收窄——
 * 显式清单不会自动流入新装的服务器；保存后对运行中的员工无影响，下一次运行生效。
 * 唯一事实源仍是 .ourcode/company.json。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  loadCompanyMcpConfig,
  saveCompanyMcpConfig,
  type CompanyMcpConfig,
} from '@/services/company/mcpAssignments'
import { WORKER_ROSTER } from '@/services/office/workers'
import { useI18n } from '@/i18n/useI18n'
import type { TranslationKey } from '@/i18n'
import { MONO, roleAvatar } from './officeTheme'

const MONO_FONT = "'JetBrains Mono', ui-monospace, 'Cascadia Mono', Consolas, monospace"
const HAIRLINE = 'rgba(15, 23, 42, 0.08)'
const HAIRLINE_SOFT = 'rgba(15, 23, 42, 0.06)'
const PRIMARY = '#0058bc'
const INK = '#0d1c2d'

type TierMode = 'follow' | 'all' | 'custom'
type ServerRuntimeState = 'connecting' | 'ready' | 'failed' | 'restarting' | 'disabled' | 'stopped'

interface TierState {
  mode: TierMode
  list: string[]
}

interface ServerInfo {
  name: string
  state: ServerRuntimeState
}

/** 运行状态 → 圆点色 + 文案 key。ready/connecting 视为「可用」。 */
const STATE_META: Record<ServerRuntimeState, { dot: string; text: TranslationKey; usable: boolean }> = {
  ready: { dot: '#16A34A', text: 'office.mcpStateReady', usable: true },
  connecting: { dot: '#D97706', text: 'office.mcpStateConnecting', usable: true },
  restarting: { dot: '#D97706', text: 'office.mcpStateConnecting', usable: true },
  failed: { dot: '#DC2626', text: 'office.mcpStateFailed', usable: false },
  disabled: { dot: '#94A3B8', text: 'office.mcpStateDisabled', usable: false },
  stopped: { dot: '#94A3B8', text: 'office.mcpStateDisabled', usable: false },
}

/** 配置值 → 面板行状态。fallback：默认档=all，角色=跟随默认。 */
function toTier(v: 'all' | string[] | undefined, fallback: TierMode): TierState {
  if (v === undefined) return { mode: fallback, list: [] }
  if (v === 'all') return { mode: 'all', list: [] }
  return { mode: 'custom', list: v }
}

/** 某角色 + 默认档 → 解析后的实际可用清单（'all' 展开为当前目录全部）。 */
function resolveTier(
  tier: TierState | undefined,
  fallbackTier: TierState,
  catalog: string[],
): { mode: 'all' | 'list'; names: string[] } {
  const effective = !tier || tier.mode === 'follow' ? fallbackTier : tier
  if (effective.mode === 'all') return { mode: 'all', names: catalog }
  return { mode: 'list', names: effective.list }
}

/** 序列化当前草稿，用于脏状态比较。 */
function snapshotOf(defaultTier: TierState, roleTiers: Record<string, TierState>): string {
  const roles: Record<string, string> = {}
  for (const [role, tier] of Object.entries(roleTiers)) {
    roles[role] = tier.mode === 'custom' ? `custom:${[...tier.list].sort().join(',')}` : tier.mode
  }
  return JSON.stringify({
    default: defaultTier.mode === 'custom' ? `custom:${[...defaultTier.list].sort().join(',')}` : defaultTier.mode,
    roles,
  })
}

export default function RoleMcpSettingsCard({
  projectPath,
  onClose,
}: {
  projectPath: string
  onClose: () => void
}) {
  const t = useI18n()
  const [servers, setServers] = useState<ServerInfo[]>([])
  const [roleOrder, setRoleOrder] = useState<string[]>([])
  const [defaultTier, setDefaultTier] = useState<TierState>({ mode: 'all', list: [] })
  const [roleTiers, setRoleTiers] = useState<Record<string, TierState>>({})
  const [selectedRole, setSelectedRole] = useState('')
  const [roleQuery, setRoleQuery] = useState('')
  const [serverQuery, setServerQuery] = useState('')
  const [baseline, setBaseline] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    const [cfg, status] = await Promise.all([
      loadCompanyMcpConfig(projectPath),
      window.electronAPI.mcpStatus(projectPath).catch(() => [] as ServerInfo[]),
    ])
    const catalog: ServerInfo[] = (status || []).map((s) => ({
      name: s.name,
      state: (s.state ?? 'ready') as ServerRuntimeState,
    }))
    setServers(catalog)
    const initialDefault = toTier(cfg.default, 'all')
    const order: string[] = []
    for (const r of [...WORKER_ROSTER.map((w) => w.role), ...Object.keys(cfg.roles ?? {})]) {
      if (!order.includes(r)) order.push(r)
    }
    const tiers: Record<string, TierState> = {}
    for (const r of order) tiers[r] = toTier(cfg.roles?.[r], 'follow')
    setDefaultTier(initialDefault)
    setRoleTiers(tiers)
    setRoleOrder(order)
    setSelectedRole(order[0] ?? '')
    setBaseline(snapshotOf(initialDefault, tiers))
    setLoaded(true)
  }, [projectPath])

  useEffect(() => {
    void load()
  }, [load])

  // Esc 关闭（未保存时也关，由用户自己承担；面板不拦窗口级快捷键）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const catalogNames = useMemo(() => servers.map((s) => s.name), [servers])
  const catalogMap = useMemo(() => new Map(servers.map((s) => [s.name, s])), [servers])
  const roleTitle = useMemo(() => new Map(WORKER_ROSTER.map((w) => [w.role, w.title])), [])

  const dirty = loaded && snapshotOf(defaultTier, roleTiers) !== baseline
  const unassignedCount = roleOrder.filter((r) => roleTiers[r]?.mode === 'follow').length
  const assignedCount = roleOrder.length - unassignedCount
  const defaultEffective = resolveTier(defaultTier, defaultTier, catalogNames)

  const touch = (mutate: () => void) => {
    setSaved(false)
    mutate()
  }

  const setRoleMode = (role: string, mode: TierMode) =>
    touch(() =>
      setRoleTiers((prev) => {
        const current = prev[role] ?? { mode: 'follow', list: [] }
        // 首次切到自选：以「当前实际生效」为起点，避免用户从空清单重来
        const seed =
          mode === 'custom' && current.list.length === 0
            ? resolveTier(current, defaultTier, catalogNames).names
            : current.list
        return { ...prev, [role]: { mode, list: seed } }
      }),
    )

  const toggleServer = (role: string, name: string, checked: boolean) =>
    touch(() =>
      setRoleTiers((prev) => {
        const current = prev[role] ?? { mode: 'follow', list: [] }
        const base =
          current.mode === 'custom' ? current.list : resolveTier(current, defaultTier, catalogNames).names
        const list = checked ? Array.from(new Set([...base, name])) : base.filter((s) => s !== name)
        return { ...prev, [role]: { mode: 'custom', list } }
      }),
    )

  const setRoleList = (role: string, list: string[]) =>
    touch(() =>
      setRoleTiers((prev) => ({
        ...prev,
        [role]: { mode: 'custom', list },
      })),
    )

  const setDefaultMode = (mode: 'all' | 'custom') =>
    touch(() =>
      setDefaultTier((prev) => ({
        mode,
        list: mode === 'custom' && prev.list.length === 0 ? catalogNames : prev.list,
      })),
    )

  const resetAll = () =>
    touch(() => {
      const follow: Record<string, TierState> = {}
      for (const r of roleOrder) follow[r] = { mode: 'follow', list: [] }
      setRoleTiers(follow)
    })

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      const mcp: CompanyMcpConfig = {
        default: defaultTier.mode === 'all' ? 'all' : defaultTier.list,
      }
      const roles: Record<string, 'all' | string[]> = {}
      for (const [role, tier] of Object.entries(roleTiers)) {
        if (tier.mode === 'follow') continue
        roles[role] = tier.mode === 'all' ? 'all' : tier.list
      }
      if (Object.keys(roles).length > 0) mcp.roles = roles
      await saveCompanyMcpConfig(projectPath, mcp)
      setBaseline(snapshotOf(defaultTier, roleTiers))
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const tier = roleTiers[selectedRole]
  const selectedEffective = resolveTier(tier, defaultTier, catalogNames)
  const selectedTier = tier ?? { mode: 'follow', list: [] }

  /** 勾选网格：可用在前、不可用在中、失效（已勾选但目录里没有）在后。 */
  const gridRows = useMemo(() => {
    const missing = selectedEffective.names.filter((n) => !catalogMap.has(n))
    const rows: Array<{ name: string; info?: ServerInfo; missing: boolean }> = []
    for (const s of servers) rows.push({ name: s.name, info: s, missing: false })
    for (const n of missing) rows.push({ name: n, missing: true })
    const usableOf = (row: (typeof rows)[number]) =>
      row.missing ? 2 : STATE_META[row.info?.state ?? 'ready'].usable ? 0 : 1
    rows.sort((a, b) => usableOf(a) - usableOf(b))
    const q = serverQuery.trim().toLowerCase()
    return q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows
  }, [servers, selectedEffective.names, catalogMap, serverQuery])

  const usableCount = servers.filter((s) => STATE_META[s.state].usable).length
  const unavailableCount = servers.length - usableCount
  const checkedCount = selectedEffective.names.filter((n) => catalogMap.has(n)).length
  const missingCount = selectedEffective.names.filter((n) => !catalogMap.has(n)).length

  const filteredRoles = useMemo(() => {
    const q = roleQuery.trim().toLowerCase()
    if (!q) return roleOrder
    return roleOrder.filter((r) => {
      const title = roleTitle.get(r) ?? r
      return title.toLowerCase().includes(q) || r.toLowerCase().includes(q)
    })
  }, [roleOrder, roleQuery, roleTitle])

  const statusChip = (role: string) => {
    const tierOf = roleTiers[role]
    const isFollow = !tierOf || tierOf.mode === 'follow'
    const label = isFollow
      ? t('office.mcpModeFollow')
      : tierOf.mode === 'all'
        ? `${t('office.mcpModeAll')} ${catalogNames.length}`
        : `${t('office.mcpModeCustom')} ${tierOf.list.length}`
    return (
      <span
        className="shrink-0 rounded"
        style={{
          fontFamily: MONO_FONT,
          fontSize: 10.5,
          padding: '2px 6px',
          color: isFollow ? MONO.t2 : PRIMARY,
          background: isFollow ? 'transparent' : '#F0F6FF',
          border: `1px solid ${isFollow ? HAIRLINE : 'rgba(0,88,188,0.24)'}`,
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
    )
  }

  const segment = (
    options: Array<{ value: TierMode; label: string; hint?: string }>,
    value: TierMode,
    onPick: (v: TierMode) => void,
  ) => (
    <div className="flex items-center gap-1 rounded-md p-0.5" style={{ background: '#F4F5F7' }}>
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onPick(opt.value)}
            title={opt.hint}
            className="flex-1 rounded text-center"
            style={{
              fontSize: 11.5,
              fontWeight: active ? 700 : 500,
              color: active ? PRIMARY : MONO.t2,
              background: active ? '#FFFFFF' : 'transparent',
              border: `1px solid ${active ? 'rgba(0,88,188,0.28)' : 'transparent'}`,
              padding: '5px 8px',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )

  if (!loaded) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center"
        style={{ background: 'rgba(13,28,45,0.35)' }}
        onClick={onClose}
      >
        <div
          className="bg-white rounded-xl border shadow-lg px-8 py-6"
          style={{ borderColor: HAIRLINE, fontFamily: MONO_FONT, fontSize: 12, color: MONO.t2 }}
        >
          …
        </div>
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3"
      style={{ background: 'rgba(13,28,45,0.35)' }}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('office.mcpAssignTitle')}
        className="bg-white rounded-xl border shadow-xl flex flex-col overflow-hidden"
        style={{
          width: 'min(940px, calc(100vw - 24px))',
          // 高度按内容上限收敛：8 个服务器（双列 4 行）刚好放下，
          // 服务器更多时列表自身滚动，不把弹窗撑出屏幕。
          height: 'min(560px, calc(100vh - 24px))',
          borderColor: HAIRLINE,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── 头部 ─────────────────────────────────────────────────────── */}
        <div
          className="shrink-0 flex items-start justify-between gap-3 px-5 py-3"
          style={{ borderBottom: `1px solid ${HAIRLINE}` }}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-[14.5px] font-bold" style={{ color: INK }}>
                {t('office.mcpAssignTitle')}
              </h2>
              <span
                className="rounded"
                style={{
                  fontSize: 10,
                  fontFamily: MONO_FONT,
                  color: MONO.t2,
                  border: `1px solid ${HAIRLINE}`,
                  padding: '1px 5px',
                }}
              >
                {t('office.mcpGovernanceTag')}
              </span>
            </div>
            <p style={{ fontSize: 11.5, color: MONO.t2, marginTop: 3 }}>{t('office.mcpAssignSubtitle')}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {dirty && (
              <span
                className="rounded-full"
                style={{
                  fontSize: 10.5,
                  color: '#B45309',
                  background: '#FEF7E6',
                  border: '1px solid #FBE0AF',
                  padding: '2px 8px',
                }}
              >
                {t('office.mcpDirty')}
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label={t('common.close')}
              className="rounded"
              style={{
                fontSize: 14,
                color: MONO.t2,
                padding: '2px 8px',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* ── 主体：左栏角色 / 右栏详情 ────────────────────────────────── */}
        <div className="flex-1 min-h-0 flex">
          {/* 左栏 */}
          <div
            className="shrink-0 flex flex-col min-h-0"
            style={{ width: 288, borderRight: `1px solid ${HAIRLINE}` }}
          >
            {/* 默认档 */}
            <div className="shrink-0 px-3 pt-3 pb-2.5" style={{ borderBottom: `1px solid ${HAIRLINE_SOFT}` }}>
              <div className="flex items-baseline justify-between">
                <span className="font-bold" style={{ fontSize: 12.5, color: INK }}>
                  {t('office.mcpDefaultLabel')}
                </span>
                <span style={{ fontFamily: MONO_FONT, fontSize: 9.5, color: MONO.t3, letterSpacing: '0.06em' }}>
                  DEFAULT
                </span>
              </div>
              <p style={{ fontSize: 11, color: MONO.t2, marginTop: 2, lineHeight: 1.5 }}>
                {t('office.mcpDefaultCaption')}
              </p>
              <div className="mt-2">
                {segment(
                  [
                    { value: 'all', label: `${t('office.mcpModeAll')} ${catalogNames.length}` },
                    { value: 'custom', label: `${t('office.mcpModeCustom')} ${defaultTier.list.length}` },
                  ],
                  defaultTier.mode === 'custom' ? 'custom' : 'all',
                  (v) => setDefaultMode(v === 'custom' ? 'custom' : 'all'),
                )}
              </div>
              <div className="mt-2 flex items-center justify-between" style={{ fontSize: 10.5, color: MONO.t3 }}>
                <span>{t('office.mcpUnassignedCount', { n: unassignedCount })}</span>
                <span style={{ fontFamily: MONO_FONT }}>
                  {defaultEffective.mode === 'all'
                    ? t('office.mcpInheritAll')
                    : `${defaultEffective.names.length}`}
                </span>
              </div>
            </div>

            {/* 角色检索 */}
            <div className="shrink-0 px-3 py-2">
              <input
                value={roleQuery}
                onChange={(e) => setRoleQuery(e.target.value)}
                placeholder={t('office.mcpSearchRole')}
                aria-label={t('office.mcpSearchRole')}
                style={{
                  width: '100%',
                  fontSize: 11.5,
                  color: INK,
                  background: '#FAFAFB',
                  border: `1px solid ${HAIRLINE}`,
                  borderRadius: 6,
                  padding: '5px 8px',
                  outline: 'none',
                }}
              />
            </div>

            {/* 角色列表 */}
            <div className="flex-1 min-h-0 overflow-y-auto">
              {filteredRoles.map((role) => {
                const avatar = roleAvatar(roleTitle.get(role) ?? role)
                const active = role === selectedRole
                return (
                  <button
                    key={role}
                    type="button"
                    onClick={() => setSelectedRole(role)}
                    aria-current={active}
                    className="w-full flex items-center gap-2 text-left"
                    style={{
                      padding: '8px 12px',
                      background: active ? '#F5F8FF' : 'transparent',
                      borderLeft: `2px solid ${active ? PRIMARY : 'transparent'}`,
                      borderBottom: `1px solid ${HAIRLINE_SOFT}`,
                      cursor: 'pointer',
                    }}
                  >
                    <span
                      className="shrink-0 flex items-center justify-center rounded"
                      style={{
                        width: 26,
                        height: 26,
                        background: avatar.bg,
                        color: '#fff',
                        fontSize: 12,
                        fontWeight: 700,
                      }}
                    >
                      {avatar.char}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className="block truncate"
                        style={{ fontSize: 12.5, fontWeight: 600, color: INK, lineHeight: 1.35 }}
                      >
                        {roleTitle.get(role) ?? role}
                      </span>
                      <span
                        className="block truncate"
                        style={{ fontFamily: MONO_FONT, fontSize: 10, color: MONO.t3 }}
                      >
                        {role}
                      </span>
                    </span>
                    {statusChip(role)}
                  </button>
                )
              })}
              {filteredRoles.length === 0 && (
                <p className="px-3 py-4" style={{ fontSize: 11.5, color: MONO.t3 }}>
                  {t('office.mcpNoRoleMatch')}
                </p>
              )}
            </div>

            {/* 批量恢复 */}
            <div className="shrink-0 px-3 py-2" style={{ borderTop: `1px solid ${HAIRLINE_SOFT}` }}>
              <button
                type="button"
                onClick={resetAll}
                disabled={assignedCount === 0}
                className="w-full rounded"
                style={{
                  fontSize: 11.5,
                  color: assignedCount === 0 ? MONO.t3 : MONO.t2,
                  background: 'transparent',
                  border: `1px solid ${HAIRLINE}`,
                  padding: '5px 8px',
                  cursor: assignedCount === 0 ? 'default' : 'pointer',
                }}
              >
                ⟲ {t('office.mcpResetAll')}
              </button>
            </div>
          </div>

          {/* 右栏 */}
          <div className="flex-1 min-w-0 min-h-0 overflow-y-auto">
            {!selectedRole ? (
              <p className="p-5" style={{ fontSize: 12, color: MONO.t3 }}>
                {t('office.mcpPickRole')}
              </p>
            ) : (
              <div className="flex flex-col">
                {/* 角色标题 */}
                <div
                  className="flex items-start justify-between gap-3 px-4 py-3"
                  style={{ borderBottom: `1px solid ${HAIRLINE_SOFT}` }}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className="shrink-0 flex items-center justify-center rounded-md"
                      style={{
                        width: 34,
                        height: 34,
                        background: roleAvatar(roleTitle.get(selectedRole) ?? selectedRole).bg,
                        color: '#fff',
                        fontSize: 15,
                        fontWeight: 700,
                      }}
                    >
                      {roleAvatar(roleTitle.get(selectedRole) ?? selectedRole).char}
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span style={{ fontSize: 13.5, fontWeight: 700, color: INK }}>
                          {roleTitle.get(selectedRole) ?? selectedRole}
                        </span>
                        <span
                          className="rounded"
                          style={{
                            fontSize: 10,
                            color: PRIMARY,
                            background: '#F0F6FF',
                            padding: '1px 5px',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {t('office.mcpCurrentRole')}
                        </span>
                      </div>
                      <span style={{ fontFamily: MONO_FONT, fontSize: 10.5, color: MONO.t3 }}>
                        {selectedRole}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setRoleMode(selectedRole, 'follow')}
                    disabled={selectedTier.mode === 'follow'}
                    style={{
                      fontSize: 11,
                      color: selectedTier.mode === 'follow' ? MONO.t3 : MONO.t2,
                      background: 'transparent',
                      border: 'none',
                      cursor: selectedTier.mode === 'follow' ? 'default' : 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    ⟲ {t('office.mcpResetRole')}
                  </button>
                </div>

                {/* 可用范围 */}
                <div className="px-4 pt-3">
                  <div className="flex items-baseline justify-between">
                    <span className="font-bold" style={{ fontSize: 12.5, color: INK }}>
                      {t('office.mcpScopeTitle')}
                    </span>
                    <span style={{ fontSize: 10.5, color: MONO.t3 }}>{t('office.mcpScopeHint')}</span>
                  </div>
                  <div className="mt-2">
                    {segment(
                      [
                        { value: 'follow', label: t('office.mcpModeFollow'), hint: t('office.mcpFollowHint') },
                        { value: 'all', label: t('office.mcpModeAll'), hint: t('office.mcpAllHint') },
                        {
                          value: 'custom',
                          // 跟随默认时只显示「自选」，切过去才会以当前生效清单为起点，
                          // 这里报数字会让人误以为已经单独分配过。
                          label:
                            selectedTier.mode === 'custom'
                              ? `${t('office.mcpModeCustom')} ${checkedCount} / ${servers.length}`
                              : t('office.mcpModeCustom'),
                          hint: t('office.mcpCustomPickHint'),
                        },
                      ],
                      selectedTier.mode,
                      (v) => setRoleMode(selectedRole, v),
                    )}
                  </div>
                  <p style={{ fontSize: 10.5, color: MONO.t3, marginTop: 5 }}>
                    {selectedTier.mode === 'follow'
                      ? t('office.mcpFollowHint')
                      : selectedTier.mode === 'all'
                        ? t('office.mcpAllHint')
                        : t('office.mcpCustomPickHint')}
                  </p>
                </div>

                {/* 实际生效 */}
                <div className="px-4 pt-3">
                  <div
                    className="flex items-start gap-2 rounded-md px-2.5 py-2"
                    style={{ background: '#FAFAFB', border: `1px solid ${HAIRLINE_SOFT}` }}
                  >
                    <span
                      className="shrink-0"
                      style={{ fontSize: 11, color: MONO.t2, paddingTop: 2, whiteSpace: 'nowrap' }}
                    >
                      {t('office.mcpEffective', { n: selectedEffective.names.length })}
                    </span>
                    <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                      {selectedEffective.names.length === 0 && (
                        <span style={{ fontSize: 11, color: MONO.t3 }}>{t('office.mcpEffectiveEmpty')}</span>
                      )}
                      {selectedEffective.names.map((name) => {
                        const info = catalogMap.get(name)
                        const meta = info ? STATE_META[info.state] : null
                        const missing = !info
                        return (
                          <span
                            key={name}
                            className="flex items-center gap-1 rounded"
                            title={missing ? t('office.mcpMissingHint') : undefined}
                            style={{
                              fontFamily: MONO_FONT,
                              fontSize: 10.5,
                              color: missing ? '#B45309' : INK,
                              background: missing ? '#FEF7E6' : '#FFFFFF',
                              border: `1px solid ${missing ? '#FBE0AF' : HAIRLINE}`,
                              padding: '1px 6px',
                            }}
                          >
                            <span
                              className="rounded-full"
                              style={{
                                width: 5,
                                height: 5,
                                background: missing ? '#D97706' : meta?.dot ?? MONO.t3,
                              }}
                            />
                            {name}
                            {missing && <span>· {t('office.mcpMissingTag')}</span>}
                          </span>
                        )
                      })}
                    </div>
                  </div>
                </div>

                {/* 服务器清单 */}
                <div className="px-4 pt-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-baseline gap-2 min-w-0">
                      <span className="font-bold" style={{ fontSize: 12.5, color: INK }}>
                        {t('office.mcpServerListTitle')}
                      </span>
                      <span style={{ fontSize: 10.5, color: MONO.t3, whiteSpace: 'nowrap' }}>
                        {t('office.mcpSummary', {
                          ok: usableCount,
                          checked: checkedCount,
                          bad: unavailableCount + missingCount,
                        })}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <input
                        value={serverQuery}
                        onChange={(e) => setServerQuery(e.target.value)}
                        placeholder={t('office.mcpSearchServer')}
                        aria-label={t('office.mcpSearchServer')}
                        style={{
                          width: 132,
                          fontSize: 11,
                          color: INK,
                          background: '#FAFAFB',
                          border: `1px solid ${HAIRLINE}`,
                          borderRadius: 6,
                          padding: '3px 7px',
                          outline: 'none',
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => setRoleList(selectedRole, catalogNames)}
                        style={{
                          fontSize: 11,
                          color: PRIMARY,
                          background: 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                        }}
                      >
                        {t('office.mcpSelectAll')}
                      </button>
                      <span style={{ color: HAIRLINE }}>|</span>
                      <button
                        type="button"
                        onClick={() => setRoleList(selectedRole, [])}
                        style={{
                          fontSize: 11,
                          color: MONO.t2,
                          background: 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                        }}
                      >
                        {t('office.mcpClearAll')}
                      </button>
                    </div>
                  </div>

                  <div className="mt-2 grid grid-cols-2 gap-x-3">
                    {gridRows.map((row) => {
                      const info = row.info
                      const meta = info ? STATE_META[info.state] : null
                      const checked = selectedEffective.names.includes(row.name)
                      const dim = row.missing || (meta ? !meta.usable : false)
                      return (
                        <label
                          key={row.name}
                          className="flex items-center gap-1.5 rounded"
                          style={{
                            padding: '4px 6px',
                            borderBottom: `1px solid ${HAIRLINE_SOFT}`,
                            opacity: dim && !checked ? 0.62 : 1,
                            cursor: 'pointer',
                            minWidth: 0,
                          }}
                          title={row.missing ? t('office.mcpMissingHint') : undefined}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => toggleServer(selectedRole, row.name, e.target.checked)}
                          />
                          <span
                            className="shrink-0 rounded-full"
                            style={{
                              width: 5,
                              height: 5,
                              background: row.missing ? '#D97706' : meta?.dot ?? MONO.t3,
                            }}
                          />
                          <span
                            className="truncate"
                            style={{
                              fontSize: 11.5,
                              color: row.missing ? '#B45309' : INK,
                              fontWeight: 500,
                            }}
                          >
                            {row.name}
                          </span>
                          <span
                            className="ml-auto shrink-0"
                            style={{
                              fontFamily: MONO_FONT,
                              fontSize: 9.5,
                              color: row.missing ? '#B45309' : MONO.t3,
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {row.missing
                              ? t('office.mcpMissingTag')
                              : meta
                                ? t(meta.text)
                                : ''}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                  {gridRows.length === 0 && (
                    <p className="py-3" style={{ fontSize: 11.5, color: MONO.t3 }}>
                      {servers.length === 0 ? t('office.mcpNoServers') : t('office.mcpNoServerMatch')}
                    </p>
                  )}
                  <p style={{ fontSize: 10.5, color: MONO.t3, margin: '6px 0 10px' }}>
                    ⓘ {t('office.mcpCustomHint')}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── 底部 ─────────────────────────────────────────────────────── */}
        <div
          className="shrink-0 flex items-center justify-between gap-3 px-5 py-2.5"
          style={{ borderTop: `1px solid ${HAIRLINE}` }}
        >
          <span
            style={{
              fontFamily: MONO_FONT,
              fontSize: 10.5,
              color: error ? '#dc2626' : saved ? '#16a34a' : dirty ? '#B45309' : MONO.t3,
            }}
          >
            {error
              ? `${t('office.mcpSaveFailed')}: ${error}`
              : saved
                ? t('office.mcpSaved')
                : dirty
                  ? t('office.mcpDirtyHint')
                  : t('office.mcpSavedClean')}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md"
              style={{
                fontSize: 12,
                color: MONO.t1,
                background: '#FFFFFF',
                border: `1px solid ${HAIRLINE}`,
                padding: '5px 14px',
                cursor: 'pointer',
              }}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !dirty}
              className="rounded-md font-bold"
              style={{
                fontSize: 12,
                color: '#ffffff',
                background: saving ? '#93b4e8' : dirty ? PRIMARY : '#B9C6D8',
                border: 'none',
                padding: '5px 16px',
                cursor: saving || !dirty ? 'default' : 'pointer',
              }}
            >
              {t('office.mcpSave')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

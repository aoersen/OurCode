import { useCallback, useEffect, useMemo, useState } from 'react'
import { useUIStore } from '@/stores/uiStore'
import {
  listAllSkills,
  getGlobalRoot,
  type SkillInfo,
} from '@/services/skills/skillManager'
import {
  installSkill,
  importSkill,
  readSkillConfig,
  setSkillEnabled,
  type SkillConfig,
} from '@/services/skills/skillRegistry'
import {
  EmptyHint,
  FieldLabel,
  FormShell,
  PlainInput,
  PlainSelect,
  SectionLabel,
  SurfaceRow,
  TextAction,
  useListKeyboard,
} from '../surfaceParts'
import { ROW_PAGE_SIZE, nextRowLimit, rowWindow } from '../surfaceModel'
import {
  buildSkillRows,
  filterSkills,
  parseSkillInstallInput,
  skillCounts,
  skillMetaLine,
  skillStateWord,
  skillToggleLabel,
  type SkillRow,
} from './skillsModel'

/**
 * 「技能」面：已安装列表 + 纯文字启停 + 行内安装。
 *
 * 读写都走既有的技能 service（skills.json 由 skillRegistry 负责），组件只做
 * 「拉列表 / 组装行 / 调动作」。开关后 bumpSkillsRevision()，侧栏的技能面板
 * 与 agent 的技能索引才会一起刷新。
 */
export default function SkillsSurface({ projectPath }: { projectPath: string | null }) {
  const bumpSkillsRevision = useUIStore((s) => s.bumpSkillsRevision)
  const skillsRevision = useUIStore((s) => s.skillsRevision)

  const [rows, setRows] = useState<SkillRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(ROW_PAGE_SIZE)
  const [installOpen, setInstallOpen] = useState(false)
  const [installInput, setInstallInput] = useState('')
  const [installTarget, setInstallTarget] = useState<'global' | 'project'>(projectPath ? 'project' : 'global')
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)

  const listKeyboard = useListKeyboard()

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const all = await listAllSkills(true)
      const globalRoot = await getGlobalRoot()
      const rootOf = (skill: SkillInfo) => (skill.source === 'global' ? globalRoot : skill.projectPath || '')
      const roots = Array.from(new Set(all.map(rootOf)))
      const configs = new Map<string, SkillConfig>()
      await Promise.all(
        roots.map(async (root) => {
          configs.set(root, await readSkillConfig(root))
        }),
      )
      setRows(buildSkillRows({ skills: all, rootOf, configOf: (root) => configs.get(root) }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    // 其他入口（侧栏技能面板、注册表弹窗）改了技能后，这里跟着重扫
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillsRevision])

  useEffect(() => {
    setLimit(ROW_PAGE_SIZE)
  }, [query])

  const counts = useMemo(() => skillCounts(rows), [rows])
  const filtered = useMemo(() => filterSkills(rows, query), [rows, query])
  const windowed = useMemo(() => rowWindow(filtered, limit), [filtered, limit])

  const toggleSkill = async (row: SkillRow) => {
    if (row.builtin || busy) return
    setBusy(row.name)
    setError(null)
    try {
      const ok = await setSkillEnabled(row.name, !row.enabled, row.configRoot)
      if (!ok) setError('保存技能开关失败（skills.json 不可写）')
      // 版本号自增 → 上面的 effect 重扫，顺便让侧栏技能面板同步
      bumpSkillsRevision()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const submitInstall = async () => {
    if (installing) return
    setInstallError(null)
    const parsed = parseSkillInstallInput(installInput)
    if ('error' in parsed) {
      setInstallError(parsed.error)
      return
    }
    const root = installTarget === 'global' ? await getGlobalRoot() : projectPath
    if (!root) {
      setInstallError('没有可安装的项目根目录')
      return
    }
    setInstalling(true)
    try {
      const ok =
        parsed.target.kind === 'path'
          ? await importSkill(parsed.target.name, root, parsed.target.path, parsed.target.origin)
          : (await installSkill(parsed.target.name, root)) !== null
      if (!ok) {
        setInstallError(
          parsed.target.kind === 'path'
            ? '导入失败：该目录下没有可读的 SKILL.md / skill.md'
            : '安装失败：先在该作用域的 skills.json 里配好注册表地址，或换个技能名',
        )
        return
      }
      setInstallInput('')
      setInstallOpen(false)
      // 同上：版本号自增触发重扫
      bumpSkillsRevision()
    } catch (cause) {
      setInstallError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto pure-scroll px-5 pb-6">
      <div className="flex items-center gap-3 pt-1">
        <PlainInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索技能…"
          aria-label="搜索技能"
          className="bg-[var(--pure-hover)]"
        />
        <span className="shrink-0 whitespace-nowrap">
          <TextAction
            onClick={() => {
              setInstallOpen((open) => !open)
              setInstallError(null)
            }}
            title={installOpen ? '收起安装' : '安装技能'}
          >
            {installOpen ? '取消' : '安装'}
          </TextAction>
        </span>
      </div>

      <div className="pt-2 text-[11.5px] leading-[18px] text-[var(--pure-muted)]">
        {loading ? '读取中…' : `${counts.total} 个技能 · ${counts.enabled} 已启用 · ${counts.disabled} 已停用`}
      </div>

      {installOpen && (
        <FormShell>
          <FieldLabel>技能名（注册表）或本地技能目录路径</FieldLabel>
          <PlainInput
            autoFocus
            value={installInput}
            onChange={(event) => setInstallInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submitInstall()
            }}
            placeholder="code-review 或 E:\\skills\\code-review"
            aria-label="技能安装来源"
          />
          <div className="flex items-center gap-2 pt-1.5">
            <FieldLabel>装到</FieldLabel>
            <PlainSelect
              aria-label="安装目标"
              value={installTarget}
              onChange={(event) => setInstallTarget(event.target.value as 'global' | 'project')}
              options={[
                { value: 'global', label: '全局' },
                { value: 'project', label: projectPath ? '当前项目' : '当前项目（未打开项目）', disabled: !projectPath },
              ]}
            />
            <span className="ml-auto inline-flex">
              <TextAction onClick={() => void submitInstall()} disabled={installing || !installInput.trim()} title="安装技能">
                {installing ? '安装中…' : '安装'}
              </TextAction>
            </span>
          </div>
          {installError && (
            <div className="pt-1.5 text-[11.5px] leading-[18px] text-[var(--pure-danger)]" role="alert">
              {installError}
            </div>
          )}
        </FormShell>
      )}

      {error && (
        <div className="pt-2 text-[12px] leading-[18px] text-[var(--pure-danger)]" role="alert">
          {error}
        </div>
      )}

      <div onKeyDown={listKeyboard}>
        {!loading && filtered.length === 0 ? (
          <EmptyHint>
            {query.trim()
              ? '没有匹配的技能。'
              : '还没有已安装的技能。点上面的「安装」从注册表装一个，或指定本地技能目录导入。'}
          </EmptyHint>
        ) : (
          <>
            <SectionLabel trailing={filtered.length !== rows.length ? `匹配 ${filtered.length}` : undefined}>
              已安装
            </SectionLabel>
            {windowed.rows.map((row) => (
              <SurfaceRow
                key={`${row.source}:${row.projectPath || 'global'}:${row.name}`}
                label={`${row.name} ${skillStateWord(row)}`}
                onActivate={row.builtin ? undefined : () => void toggleSkill(row)}
                className="pure-row"
              >
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] leading-[20px] text-[var(--pure-ink)] truncate">{row.name}</div>
                    <div className="flex items-baseline gap-2 min-w-0">
                      <span className="shrink-0 whitespace-nowrap text-[10.5px] leading-[18px] text-[var(--pure-muted)]">
                        {skillMetaLine(row)}
                      </span>
                      {row.description && (
                        <span className="min-w-0 truncate text-[11.5px] leading-[18px] text-[var(--pure-muted)]">
                          {row.description}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 flex items-center gap-2.5 pt-0.5 whitespace-nowrap">
                    {/* 动作本身就表达状态（「停用」= 当前已启用），不再并列一个状态词；
                        内置技能没有动作，才用状态词占位。 */}
                    {row.builtin ? (
                      <span className="text-[10.5px] leading-[18px] text-[var(--pure-muted)]">{skillStateWord(row)}</span>
                    ) : (
                      <TextAction
                        onClick={() => void toggleSkill(row)}
                        disabled={busy === row.name}
                        title={`${skillToggleLabel(row)} ${row.name}`}
                      >
                        {busy === row.name ? '保存中…' : skillToggleLabel(row)}
                      </TextAction>
                    )}
                  </div>
                </div>
              </SurfaceRow>
            ))}
          </>
        )}

        {windowed.hidden > 0 && (
          <div className="pt-2">
            <TextAction onClick={() => setLimit((current) => nextRowLimit(current))}>
              显示更多（还有 {windowed.hidden} 个）
            </TextAction>
          </div>
        )}
      </div>
    </div>
  )
}

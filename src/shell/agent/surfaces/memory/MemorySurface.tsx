import { useEffect, useMemo, useState } from 'react'
import { useMemoryStore } from '@/stores/memoryStore'
import type { Memory } from '@/types'
import {
  EmptyHint,
  FieldLabel,
  FormShell,
  PlainInput,
  PlainSelect,
  PlainTextarea,
  SectionLabel,
  SurfaceRow,
  TextAction,
  useListKeyboard,
} from '../surfaceParts'
import { ROW_PAGE_SIZE, nextRowLimit, rowWindow } from '../surfaceModel'
import {
  MEMORY_FILTERS,
  memoryCounts,
  memoryGroups,
  memoryProjectTitle,
  memoryScopeLabel,
  type MemoryFilter,
  type MemoryGroup,
} from './memoryModel'

/**
 * 「记忆」面：作用域过滤 + 搜索 + 分组列表 + 行内新增。
 *
 * 数据全部来自 memoryStore（loadMemories / addMemory / deleteMemory 都是既有
 * store 动作），组件不自己拼 SQLite 调用。分组口径见 memoryModel.memoryGroups。
 */
export default function MemorySurface({ projectPath }: { projectPath: string | null }) {
  const memories = useMemoryStore((s) => s.memories)
  const loaded = useMemoryStore((s) => s.loaded)
  const loadMemories = useMemoryStore((s) => s.loadMemories)
  const addMemory = useMemoryStore((s) => s.addMemory)
  const deleteMemory = useMemoryStore((s) => s.deleteMemory)

  const [filter, setFilter] = useState<MemoryFilter>('all')
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [draftScope, setDraftScope] = useState<'project' | 'global'>(projectPath ? 'project' : 'global')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [limit, setLimit] = useState(ROW_PAGE_SIZE)

  const listKeyboard = useListKeyboard()

  useEffect(() => {
    if (!loaded) void loadMemories()
  }, [loaded, loadMemories])

  // 换过滤/搜索时把「显示更多」收回 100 行
  useEffect(() => {
    setLimit(ROW_PAGE_SIZE)
  }, [filter, query])

  const counts = useMemo(() => memoryCounts(memories, projectPath), [memories, projectPath])
  const groups = useMemo(
    () => memoryGroups(memories, { filter, query, projectPath }),
    [memories, filter, query, projectPath],
  )

  // 跨分组统一截断（最多 100 行），再按分组还原
  const flat = useMemo(
    () => groups.flatMap((group) => group.memories.map((memory) => ({ group, memory }))),
    [groups],
  )
  const windowed = useMemo(() => rowWindow(flat, limit), [flat, limit])
  const visibleGroups = useMemo(() => {
    const buckets = new Map<string, { group: MemoryGroup; memories: Memory[] }>()
    for (const item of windowed.rows) {
      const bucket = buckets.get(item.group.key) ?? { group: item.group, memories: [] }
      bucket.memories.push(item.memory)
      buckets.set(item.group.key, bucket)
    }
    return Array.from(buckets.values())
  }, [windowed])

  const totalVisible = flat.length

  const handleDelete = async (memory: Memory) => {
    setError(null)
    try {
      await deleteMemory(memory.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const handleSave = async () => {
    const content = draft.trim()
    if (!content || saving) return
    if (draftScope === 'project' && !projectPath) return
    setSaving(true)
    setError(null)
    try {
      await addMemory(content, draftScope, draftScope === 'project' ? projectPath ?? undefined : undefined)
      setDraft('')
      setAdding(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto pure-scroll px-5 pb-6">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 pt-1">
        {MEMORY_FILTERS.map((entry) => {
          const active = entry.id === filter
          return (
            <button
              key={entry.id}
              type="button"
              aria-pressed={active}
              onClick={() => setFilter(entry.id)}
              className={`pure-focus text-[12.5px] leading-[20px] transition-colors ${
                active
                  ? 'pure-tab-underline text-[var(--pure-ink)]'
                  : 'text-[var(--pure-muted)] hover:text-[var(--pure-ink)]'
              }`}
            >
              {entry.label}
              <span className="ml-1 text-[11.5px] text-[var(--pure-muted)]">{counts[entry.id]}</span>
            </button>
          )
        })}
        <span className="ml-auto text-[11.5px] leading-[18px] text-[var(--pure-muted)]">
          {memoryProjectTitle(projectPath)} · {counts.project} 条
        </span>
      </div>

      <div className="flex items-center gap-3 pt-3">
        <PlainInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索记忆…"
          aria-label="搜索记忆"
          className="bg-[var(--pure-hover)]"
        />
        <TextAction
          onClick={() => {
            setAdding((open) => !open)
            setError(null)
          }}
          title={adding ? '收起新增记忆' : '新增记忆'}
        >
          {adding ? '取消' : '新增记忆'}
        </TextAction>
      </div>

      {adding && (
        <FormShell>
          <PlainTextarea
            autoFocus
            rows={3}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void handleSave()
            }}
            placeholder="要长期记住什么？例如：这个项目统一用 pnpm，不要 npm install"
            aria-label="记忆内容"
          />
          <div className="flex items-center gap-2 pt-1.5">
            <FieldLabel>作用域</FieldLabel>
            <PlainSelect
              aria-label="记忆作用域"
              value={draftScope}
              onChange={(event) => setDraftScope(event.target.value as 'project' | 'global')}
              options={[
                { value: 'project', label: projectPath ? `项目 · ${memoryProjectTitle(projectPath)}` : '项目（未打开项目）', disabled: !projectPath },
                { value: 'global', label: '全局' },
              ]}
            />
            <span className="ml-auto text-[11.5px] leading-[18px] text-[var(--pure-muted)]">⌘/Ctrl + Enter 保存</span>
            <TextAction
              onClick={() => void handleSave()}
              disabled={!draft.trim() || saving || (draftScope === 'project' && !projectPath)}
              title="保存记忆"
            >
              {saving ? '保存中…' : '保存'}
            </TextAction>
          </div>
        </FormShell>
      )}

      {error && (
        <div className="pt-2 text-[12px] leading-[18px] text-[var(--pure-danger)]" role="alert">
          {error}
        </div>
      )}

      <div onKeyDown={listKeyboard}>
        {totalVisible === 0 ? (
          <EmptyHint>
            {query.trim()
              ? '没有匹配的记忆。'
              : filter === 'project' && !projectPath
                ? '未打开项目，项目范围记忆不可用。'
                : '还没有记忆。可以在上面新增一条，或在对话里让 agent 记住你的偏好。'}
          </EmptyHint>
        ) : (
          visibleGroups.map(({ group, memories: groupMemories }) => (
            <section key={group.key}>
              <SectionLabel trailing={`${groupMemories.length} 条`}>{group.label}</SectionLabel>
              {groupMemories.map((memory) => (
                <SurfaceRow key={memory.id} label={memory.content} className="pure-row">
                  <div className="flex items-start gap-3">
                    <p className="flex-1 min-w-0 text-[13px] leading-[20px] text-[var(--pure-ink)] whitespace-pre-wrap break-words line-clamp-2">
                      {memory.content}
                    </p>
                    <div className="shrink-0 flex items-center gap-2 pt-0.5">
                      <span className="text-[11.5px] leading-[18px] text-[var(--pure-muted)]">
                        {memoryScopeLabel(memory, projectPath)}
                      </span>
                      <span className="pure-row-actions inline-flex">
                        <TextAction
                          onClick={() => void handleDelete(memory)}
                          danger
                          title="删除记忆"
                          label={`删除记忆：${memory.content.slice(0, 30)}`}
                        >
                          删除
                        </TextAction>
                      </span>
                    </div>
                  </div>
                </SurfaceRow>
              ))}
            </section>
          ))
        )}

        {windowed.hidden > 0 && (
          <div className="pt-2">
            <TextAction onClick={() => setLimit((current) => nextRowLimit(current))}>
              显示更多（还有 {windowed.hidden} 条）
            </TextAction>
          </div>
        )}
      </div>
    </div>
  )
}

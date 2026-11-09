import { describe, expect, it } from 'vitest'
import {
  DANGEROUS_APPROVAL_TITLE,
  EDIT_PREVIEW_MAX_CHARS,
  TOOL_ACTION,
  TOOL_APPROVAL_TITLE,
  argsPreview,
  editPreviewOf,
  riskOf,
  toolApprovalView,
  toolTarget,
} from '@/shell/agent/approvals/approvalModel'

const call = (name: string, args: Record<string, unknown> = {}) => ({ name, arguments: args })

describe('riskOf —— 一行风险词', () => {
  it('flags destructive shell commands as danger', () => {
    expect(riskOf(call('run_command', { command: 'rm -rf /' }))).toEqual({
      level: 'danger',
      word: '危险命令',
    })
    expect(riskOf(call('run_command', { command: 'git push --force origin main' })).level).toBe('danger')
  })

  it('keeps a routine command at command level', () => {
    expect(riskOf(call('run_command', { command: 'npm run typecheck' }))).toEqual({
      level: 'command',
      word: '执行命令',
    })
  })

  it('labels file writes, deletes, git and MCP tools', () => {
    expect(riskOf(call('edit_file', { path: 'a.ts' })).word).toBe('写入文件')
    expect(riskOf(call('write_file', { path: 'a.ts' })).word).toBe('写入文件')
    expect(riskOf(call('delete_file', { path: 'a.ts' })).word).toBe('删除文件')
    expect(riskOf(call('git_commit', { message: 'x' })).word).toBe('改动 git 历史')
    expect(riskOf(call('run_subagent', { prompt: 'x' })).word).toBe('子代理')
    expect(riskOf(call('mcp__github__create_issue', { title: 'x' })).word).toBe('外部工具')
  })

  it('marks read-only tools as read', () => {
    expect(riskOf(call('read_file', { path: 'a.ts' }))).toEqual({ level: 'read', word: '只读' })
    expect(riskOf(call('search_in_files', { pattern: 'x' })).level).toBe('read')
  })

  it('lets the store verdict win over the local analysis', () => {
    expect(riskOf(call('edit_file', { path: 'a.ts' }), { dangerous: true })).toEqual({
      level: 'danger',
      word: '危险命令',
    })
    // 危险标记不会把命令降级
    expect(riskOf(call('run_command', { command: 'ls' }), { dangerous: true }).word).toBe('危险命令')
  })
})

describe('toolTarget —— 一行目标描述', () => {
  it('prefers structured args', () => {
    expect(toolTarget(call('edit_file', { path: 'src/shell/agent/BottomDock.tsx' }))).toBe(
      'src/shell/agent/BottomDock.tsx',
    )
    expect(toolTarget(call('run_command', { command: 'npm run typecheck' }))).toBe('npm run typecheck')
  })

  it('falls back to the store preview, flattened and truncated', () => {
    expect(toolTarget(call('manage_todo', {}), '更新任务\n第二行')).toBe('更新任务 第二行')
    const long = toolTarget(call('manage_todo', {}), 'x'.repeat(200))
    expect(long.length).toBeLessThanOrEqual(72)
    expect(long.endsWith('…')).toBe(true)
  })

  it('counts multi-target args instead of listing them', () => {
    expect(toolTarget(call('read_multiple_files', { paths: ['a', 'b', 'c'] }))).toBe('3 个文件')
    expect(toolTarget(call('multi_edit_file', { edits: [{}, {}] }))).toBe('2 处编辑')
  })
})

describe('argsPreview —— 参数 JSON 井', () => {
  it('pretty-prints with two-space indentation', () => {
    const preview = argsPreview({ path: 'a.ts', count: 2 })
    expect(preview.truncated).toBe(false)
    expect(preview.text).toBe('{\n  "path": "a.ts",\n  "count": 2\n}')
    expect(preview.totalChars).toBe(preview.text.length)
  })

  it('handles a missing arg bag', () => {
    expect(argsPreview(undefined).text).toBe('{}')
  })

  it('truncates long payloads and keeps the original length', () => {
    const preview = argsPreview({ blob: 'x'.repeat(200) }, 40)
    expect(preview.truncated).toBe(true)
    expect(preview.text.length).toBeLessThan(80)
    expect(preview.text.endsWith('…')).toBe(true)
    expect(preview.totalChars).toBeGreaterThan(40)
  })
})

describe('editPreviewOf —— 红删绿增', () => {
  it('extracts oldText/newText from edit_file', () => {
    expect(editPreviewOf(call('edit_file', { oldText: 'a', newText: 'b' }))).toEqual({
      removed: 'a',
      added: 'b',
      removedTruncated: false,
      addedTruncated: false,
    })
  })

  it('takes the first edit of multi_edit_file', () => {
    const preview = editPreviewOf(
      call('multi_edit_file', {
        edits: [
          { path: 'a.ts', oldText: 'one', newText: 'two' },
          { path: 'b.ts', oldText: 'three', newText: 'four' },
        ],
      }),
    )
    expect(preview?.removed).toBe('one')
    expect(preview?.added).toBe('two')
  })

  it('caps each side and flags the truncation', () => {
    const preview = editPreviewOf(
      call('edit_file', { oldText: 'x'.repeat(EDIT_PREVIEW_MAX_CHARS + 10), newText: 'y' }),
    )
    expect(preview?.removedTruncated).toBe(true)
    expect(preview?.addedTruncated).toBe(false)
    expect(preview?.removed.length).toBe(EDIT_PREVIEW_MAX_CHARS + 1)
  })

  it('returns null for tools without a text change', () => {
    expect(editPreviewOf(call('read_file', { path: 'a.ts' }))).toBeNull()
    expect(editPreviewOf(call('write_file', { path: 'a.ts', content: 'x' }))).toBeNull()
  })
})

describe('toolApprovalView —— 单条工具审批', () => {
  const payload = {
    toolCall: { ...call('edit_file', { path: 'src/a.ts', oldText: 'a', newText: 'b' }), id: 'tc1' },
    preview: 'Edit src/a.ts +1 -1',
  }

  it('offers 批准 / 始终允许（本项目） / 拒绝 with keyboard hints', () => {
    const view = toolApprovalView(payload)
    expect(view.title).toBe(TOOL_APPROVAL_TITLE)
    expect(view.actions.map((a) => a.label)).toEqual(['批准', '始终允许（本项目）', '拒绝'])
    expect(view.actions.map((a) => a.id)).toEqual([
      TOOL_ACTION.approve,
      TOOL_ACTION.alwaysAllowProject,
      TOOL_ACTION.reject,
    ])
    expect(view.actions.map((a) => a.tone)).toEqual(['primary', 'plain', 'danger'])
    expect(view.actions.map((a) => a.kbd)).toEqual(['↵', '⌘⇧↵', 'Esc'])
  })

  it('gives every action an aria-label that names the tool', () => {
    const view = toolApprovalView(payload)
    expect(view.actions.every((a) => a.ariaLabel.length > 0)).toBe(true)
    expect(view.actions[0].ariaLabel).toContain('Edit')
    expect(view.actions[2].ariaLabel).toContain('Edit')
  })

  it('builds the one-line target and the diff preview', () => {
    const view = toolApprovalView(payload)
    expect(view.label).toBe('Edit')
    expect(view.target).toBe('src/a.ts')
    expect(view.risk.word).toBe('写入文件')
    expect(view.edit).toEqual({ removed: 'a', added: 'b', removedTruncated: false, addedTruncated: false })
    expect(view.args.text).toContain('"path": "src/a.ts"')
  })

  it('drops the allowlist action for dangerous commands', () => {
    const view = toolApprovalView({
      toolCall: { ...call('run_command', { command: 'rm -rf /' }), id: 'tc2' },
      preview: 'Bash rm -rf /',
      dangerous: true,
    })
    expect(view.title).toBe(DANGEROUS_APPROVAL_TITLE)
    expect(view.actions.map((a) => a.id)).toEqual([TOOL_ACTION.approve, TOOL_ACTION.reject])
    expect(view.risk.level).toBe('danger')
    expect(view.preview).toBe('Bash rm -rf /')
  })
})

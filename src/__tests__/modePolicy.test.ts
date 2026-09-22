import { describe, it, expect } from 'vitest'
import {
  kindOf,
  resolveApproval,
  targetPathsOf,
  isPathInScope,
  MODE_CYCLE,
  type ToolKind,
  type EditMode,
} from '@/services/permissions/modePolicy'

describe('kindOf', () => {
  it('classifies built-in tools into operation kinds', () => {
    expect(kindOf('read_file')).toBe('read')
    expect(kindOf('search_in_files')).toBe('read')
    expect(kindOf('git_status')).toBe('read')
    expect(kindOf('web_search')).toBe('read')
    expect(kindOf('read_terminal_output')).toBe('read')
    expect(kindOf('stop_terminal')).toBe('read')
    expect(kindOf('browser_navigate')).toBe('read')

    expect(kindOf('write_file')).toBe('file_write')
    expect(kindOf('edit_file')).toBe('file_write')
    expect(kindOf('multi_edit_file')).toBe('file_write')
    expect(kindOf('create_directory')).toBe('file_write')
    expect(kindOf('delete_file')).toBe('file_write')

    expect(kindOf('run_command')).toBe('command')
    expect(kindOf('git_commit')).toBe('git_write')
    expect(kindOf('git_push')).toBe('git_write')
    expect(kindOf('git_split_commit')).toBe('git_write')
    expect(kindOf('browser_act')).toBe('browser_write')
    expect(kindOf('create_pull_request')).toBe('browser_write')
    expect(kindOf('run_subagent')).toBe('delegate')

    expect(kindOf('ask_user_question')).toBe('interactive')
    expect(kindOf('submit_plan')).toBe('interactive')
    expect(kindOf('manage_todo')).toBe('interactive')
    expect(kindOf('remember')).toBe('interactive')
    expect(kindOf('send_message')).toBe('interactive')
  })

  it('classifies dynamic tools by prefix', () => {
    expect(kindOf('mcp__filesystem.write')).toBe('mcp')
    expect(kindOf('skill__my-skill')).toBe('read')
  })
})

describe('resolveApproval — the per-mode matrix', () => {
  const cases: Array<{ kind: ToolKind; mode: EditMode; plan: { approved: boolean }; inScope: boolean; want: 'auto' | 'confirm' | 'block' }> = [
    // 只读/交互永远免审
    { kind: 'read', mode: 'confirm_before_change', plan: { approved: false }, inScope: false, want: 'auto' },
    { kind: 'interactive', mode: 'plan', plan: { approved: false }, inScope: false, want: 'auto' },
    // 手动确认：全部确认
    { kind: 'file_write', mode: 'confirm_before_change', plan: { approved: false }, inScope: false, want: 'confirm' },
    { kind: 'command', mode: 'confirm_before_change', plan: { approved: false }, inScope: false, want: 'confirm' },
    { kind: 'mcp', mode: 'confirm_before_change', plan: { approved: false }, inScope: false, want: 'confirm' },
    // 自动编辑：文件写入自动，其余确认
    { kind: 'file_write', mode: 'auto_edit', plan: { approved: false }, inScope: false, want: 'auto' },
    { kind: 'command', mode: 'auto_edit', plan: { approved: false }, inScope: false, want: 'confirm' },
    { kind: 'git_write', mode: 'auto_edit', plan: { approved: false }, inScope: false, want: 'confirm' },
    // 完全访问：全部自动
    { kind: 'file_write', mode: 'full_access', plan: { approved: false }, inScope: false, want: 'auto' },
    { kind: 'command', mode: 'full_access', plan: { approved: false }, inScope: false, want: 'auto' },
    { kind: 'mcp', mode: 'full_access', plan: { approved: false }, inScope: false, want: 'auto' },
    // 计划模式 · 只读期：写入类全部拦截
    { kind: 'file_write', mode: 'plan', plan: { approved: false }, inScope: false, want: 'block' },
    { kind: 'command', mode: 'plan', plan: { approved: false }, inScope: false, want: 'block' },
    { kind: 'git_write', mode: 'plan', plan: { approved: false }, inScope: false, want: 'block' },
    { kind: 'browser_write', mode: 'plan', plan: { approved: false }, inScope: false, want: 'block' },
    // 计划模式 · 批准后：文件写入仅限声明范围；本地交付动作自动；远端仍确认
    { kind: 'file_write', mode: 'plan', plan: { approved: true }, inScope: true, want: 'auto' },
    { kind: 'file_write', mode: 'plan', plan: { approved: true }, inScope: false, want: 'block' },
    { kind: 'command', mode: 'plan', plan: { approved: true }, inScope: false, want: 'auto' },
    { kind: 'git_write', mode: 'plan', plan: { approved: true }, inScope: false, want: 'auto' },
    { kind: 'delegate', mode: 'plan', plan: { approved: true }, inScope: false, want: 'auto' },
    { kind: 'browser_write', mode: 'plan', plan: { approved: true }, inScope: false, want: 'confirm' },
    { kind: 'mcp', mode: 'plan', plan: { approved: true }, inScope: false, want: 'confirm' },
  ]
  for (const c of cases) {
    it(`${c.kind} / ${c.mode} / approved=${c.plan.approved} / inScope=${c.inScope} → ${c.want}`, () => {
      expect(resolveApproval(c.kind, c.mode, c.plan, c.inScope)).toBe(c.want)
    })
  }

  it('MODE_CYCLE follows the ZCode order', () => {
    expect(MODE_CYCLE).toEqual(['confirm_before_change', 'auto_edit', 'plan', 'full_access'])
  })
})

describe('targetPathsOf', () => {
  it('extracts the target path per write tool', () => {
    expect(targetPathsOf({ name: 'write_file', arguments: { path: 'src/a.ts', content: 'x' } })).toEqual(['src/a.ts'])
    expect(targetPathsOf({ name: 'edit_file', arguments: { path: 'src/a.ts' } })).toEqual(['src/a.ts'])
    expect(targetPathsOf({ name: 'delete_file', arguments: { path: 'src/a.ts' } })).toEqual(['src/a.ts'])
    expect(targetPathsOf({ name: 'create_directory', arguments: { path: 'src/x' } })).toEqual(['src/x'])
    expect(targetPathsOf({ name: 'multi_edit_file', arguments: { edits: [{ path: 'a.ts' }, { path: 'b.ts' }] } })).toEqual(['a.ts', 'b.ts'])
    expect(targetPathsOf({ name: 'run_command', arguments: { command: 'ls' } })).toEqual([])
  })
})

describe('isPathInScope', () => {
  const project = 'E:/repo'
  it('matches exact files, relative paths, and directory scopes', () => {
    expect(isPathInScope(['E:/repo/src/a.ts'], ['src/a.ts'], project)).toBe(true)
    expect(isPathInScope(['E:/repo/src/a.ts'], ['E:/repo/src/a.ts'], project)).toBe(true)
    expect(isPathInScope(['src/a.ts'], ['src/a.ts'], project)).toBe(true)
    // 目录声明覆盖其下文件
    expect(isPathInScope(['E:/repo/src/a.ts'], ['src'], project)).toBe(true)
    // 大小写与反斜杠归一化
    expect(isPathInScope(['e:\\repo\\SRC\\A.TS'], ['src/a.ts'], project)).toBe(true)
  })

  it('rejects out-of-scope and sibling-prefix paths', () => {
    expect(isPathInScope(['E:/repo/src/utils/cache.ts'], ['src/a.ts'], project)).toBe(false)
    // 前缀陷阱：src/a.ts 不应命中 src/a.ts.bak
    expect(isPathInScope(['E:/repo/src/a.ts.bak'], ['src/a.ts'], project)).toBe(false)
    // 空清单 = fail closed
    expect(isPathInScope(['E:/repo/src/a.ts'], [], project)).toBe(false)
    expect(isPathInScope([], ['src/a.ts'], project)).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import {
  CONFIRM_ACTION,
  SCOPE_ACTION,
  isTextEntry,
  regenerateConfirmView,
  resolveApprovalKey,
  revertAllConfirmView,
  scopePathsLine,
  scopeView,
  uniquePaths,
} from '@/shell/agent/approvals/approvalModel'

describe('resolveApprovalKey —— 键盘契约', () => {
  it('Enter is the primary action', () => {
    expect(resolveApprovalKey({ key: 'Enter' })).toBe('primary')
    expect(resolveApprovalKey({ key: 'Enter', shiftKey: true })).toBe('primary')
  })

  it('⌘⇧Enter (Ctrl+Shift+Enter) is always-allow', () => {
    expect(resolveApprovalKey({ key: 'Enter', metaKey: true, shiftKey: true })).toBe('always-allow')
    expect(resolveApprovalKey({ key: 'Enter', ctrlKey: true, shiftKey: true })).toBe('always-allow')
  })

  it('bare ⌘Enter is left to the composer (no mapped action)', () => {
    expect(resolveApprovalKey({ key: 'Enter', metaKey: true })).toBeNull()
    expect(resolveApprovalKey({ key: 'Enter', ctrlKey: true })).toBeNull()
  })

  it('Alt+Enter and other keys do nothing', () => {
    expect(resolveApprovalKey({ key: 'Enter', altKey: true, metaKey: true, shiftKey: true })).toBeNull()
    expect(resolveApprovalKey({ key: 'a' })).toBeNull()
    expect(resolveApprovalKey({ key: 'Tab' })).toBeNull()
  })

  it('Esc moves focus to the reject action', () => {
    expect(resolveApprovalKey({ key: 'Escape' })).toBe('reject-focus')
  })
})

describe('isTextEntry —— 让开输入框', () => {
  it('is true for form fields and contenteditable', () => {
    expect(isTextEntry('INPUT')).toBe(true)
    expect(isTextEntry('textarea')).toBe(true)
    expect(isTextEntry('SELECT')).toBe(true)
    expect(isTextEntry('DIV', true)).toBe(true)
  })

  it('is false for buttons and plain containers', () => {
    expect(isTextEntry('BUTTON')).toBe(false)
    expect(isTextEntry('DIV')).toBe(false)
    expect(isTextEntry(undefined)).toBe(false)
  })
})

describe('uniquePaths —— 文件清单', () => {
  it('dedupes while keeping the first-seen order', () => {
    expect(uniquePaths(['b', 'a', 'b', '  ', 'c'])).toEqual(['b', 'a', 'c'])
    expect(uniquePaths(undefined)).toEqual([])
  })
})

describe('regenerateConfirmView —— 重新生成确认', () => {
  const view = regenerateConfirmView(['src/a.ts', 'src/a.ts', 'src/b.ts'])

  it('counts distinct files and states the consequence', () => {
    expect(view.title).toBe('重新生成这条回复？')
    expect(view.files).toEqual(['src/a.ts', 'src/b.ts'])
    expect(view.body).toBe('这条回复修改了 2 个文件。回退这些改动后再重新生成，或保留改动直接重来。')
  })

  it('offers 取消 / 回退并重新生成 / 保留并重新生成', () => {
    expect(view.actions.map((a) => a.label)).toEqual(['取消', '回退并重新生成', '保留并重新生成'])
    expect(view.actions.map((a) => a.id)).toEqual([
      CONFIRM_ACTION.dismiss,
      CONFIRM_ACTION.regenerateRevert,
      CONFIRM_ACTION.regenerateKeep,
    ])
    expect(view.actions.map((a) => a.tone)).toEqual(['plain', 'danger', 'primary'])
    expect(view.actions.every((a) => a.ariaLabel.length > 0)).toBe(true)
  })
})

describe('revertAllConfirmView —— 回退全部确认', () => {
  it('keeps the safe action primary and puts the red token on the destructive one', () => {
    const view = revertAllConfirmView(['src/a.ts'])
    expect(view.title).toBe('把本次改动全部回退？')
    expect(view.body).toBe('本次会话有 1 个文件被改过。回退后这些改动会回到 AI 动手前。')
    expect(view.actions.map((a) => a.label)).toEqual(['保留改动', '回退全部'])
    expect(view.actions.map((a) => a.tone)).toEqual(['primary', 'danger'])
  })
})

describe('计划外写入拦截', () => {
  it('lists at most three paths and counts the rest', () => {
    expect(scopePathsLine(['a', 'b', 'c'])).toBe('a、b、c')
    expect(scopePathsLine(['a', 'b', 'c', 'd'])).toBe('a、b、c 等 4 个路径')
    expect(scopePathsLine([])).toBe('（未声明路径）')
  })

  it('gives three exits, with the reject in red', () => {
    const view = scopeView('write_file', ['src/a.ts', 'src/b.ts'])
    expect(view.title).toBe('计划外写入被拦截')
    expect(view.body).toBe('src/a.ts、src/b.ts 不在批准的计划内，未写入任何内容。')
    expect(view.actions.map((a) => a.label)).toEqual(['加入计划并执行', '切换模式继续', '拒绝'])
    expect(view.actions.map((a) => a.id)).toEqual([
      SCOPE_ACTION.addToPlan,
      SCOPE_ACTION.switchMode,
      SCOPE_ACTION.reject,
    ])
    expect(view.actions[2].tone).toBe('danger')
    expect(view.actions[2].ariaLabel).toContain('Write')
  })
})

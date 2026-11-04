import { describe, it, expect } from 'vitest'
import { kindOf, resolveApproval, type EditMode } from '../services/permissions/modePolicy'

describe('computer-use permission matrix', () => {
  it('classifies desktop tools', () => {
    expect(kindOf('computer_click')).toBe('computer_write')
    expect(kindOf('computer_type')).toBe('computer_write')
    expect(kindOf('computer_set_value')).toBe('computer_write')
    expect(kindOf('computer_run_steps')).toBe('computer_write')
    expect(kindOf('computer_launch_app')).toBe('computer_write')
    expect(kindOf('computer_get_state')).toBe('read')
    expect(kindOf('computer_screenshot')).toBe('read')
    expect(kindOf('computer_stop')).toBe('interactive')
  })

  const plan = (approved: boolean) => ({ approved })

  it.each<[EditMode, 'auto' | 'confirm' | 'block']>([
    ['confirm_before_change', 'confirm'],
    ['auto_edit', 'confirm'],
    ['plan', 'block'],
    ['guarded', 'auto'],
    ['yolo', 'auto'],
  ])('%s → %s', (mode, expected) => {
    expect(resolveApproval('computer_write', mode, plan(false), true)).toBe(expected)
  })

  it('still asks after a plan is approved (desktop actions are not deliverables)', () => {
    expect(resolveApproval('computer_write', 'plan', plan(true), true)).toBe('confirm')
  })

  it('keeps the emergency stop always available', () => {
    expect(resolveApproval('interactive', 'plan', plan(false), false)).toBe('auto')
    expect(resolveApproval(kindOf('computer_stop'), 'confirm_before_change', plan(false), false)).toBe('auto')
  })
})

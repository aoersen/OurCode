import { describe, it, expect, vi } from 'vitest'
import { createApprovalPreHook, type ApprovalPreHookOptions } from '@/stores/approvalHook'
import type { ToolCall } from '@/services/tools/types'

/**
 * Approval pre-hook integration tests — the REAL hook (gate serialization +
 * re-checks + dialog + allow/deny) driven concurrently, without booting the
 * store. This pins the regression that motivated the gate: two approval-
 * requiring tools in one batch must prompt one at a time and each get its own
 * decision — never a silent "用户拒绝了此操作" from an overwritten dialog.
 */

const tc = (id: string, name = 'write_file'): ToolCall => ({ id, name, arguments: { path: `/tmp/${id}.ts` } })

function makeHook(overrides: Partial<ApprovalPreHookOptions> = {}) {
  const defaults: ApprovalPreHookOptions = {
    sessionId: 's1',
    batchRejectedRef: { current: new Set() },
    needsApproval: (name) => name.startsWith('write_'),
    getPreview: (t) => `preview:${t.name}`,
    isAborted: () => false,
    onDialog: async () => true,
  }
  return createApprovalPreHook({ ...defaults, ...overrides })
}

describe('createApprovalPreHook', () => {
  it('serializes concurrent dialogs and decides each tool independently', async () => {
    const dialogs: string[] = []
    const decisions: Record<string, boolean> = { c1: true, c2: false } // approve 1st, reject 2nd
    const onDialog = vi.fn(async (t: ToolCall) => {
      dialogs.push(t.id)
      await new Promise((r) => setTimeout(r, 10)) // simulate user thinking
      return decisions[t.id]
    })
    const hook = makeHook({ onDialog })

    const [r1, r2] = await Promise.all([hook(tc('c1'), { sessionId: 's1' }), hook(tc('c2'), { sessionId: 's1' })])
    // Dialogs were strictly sequential — c2's dialog waited for c1's decision.
    expect(dialogs).toEqual(['c1', 'c2'])
    expect(onDialog).toHaveBeenCalledTimes(2)
    expect(r1).toEqual({ allow: true })
    expect(r2).toEqual({ deny: true, reason: '用户拒绝了此操作' })
  })

  it('denies batch-rejected tools without a dialog', async () => {
    const batchRejectedRef = { current: new Set(['c9']) }
    const onDialog = vi.fn(async () => true)
    const hook = makeHook({ batchRejectedRef, onDialog })

    const r = await hook(tc('c9'), { sessionId: 's1' })
    expect(r).toEqual({ deny: true, reason: '用户拒绝了此操作' })
    expect(onDialog).not.toHaveBeenCalled()
  })

  it('allows tools that do not need approval without touching the gate', async () => {
    const onDialog = vi.fn(async () => true)
    const hook = makeHook({ onDialog })
    const r = await hook(tc('r1', 'read_file'), { sessionId: 's1' })
    expect(r).toEqual({ allow: true })
    expect(onDialog).not.toHaveBeenCalled()
  })

  it('ignores tool calls from other sessions (shared executor)', async () => {
    const onDialog = vi.fn(async () => true)
    const hook = makeHook({ onDialog })
    const r = await hook(tc('c1'), { sessionId: 'OTHER' })
    expect(r).toEqual({ allow: true })
    expect(onDialog).not.toHaveBeenCalled()
  })

  it('denies without a dialog once the run is aborted', async () => {
    const onDialog = vi.fn(async () => true)
    const hook = makeHook({ isAborted: () => true, onDialog })
    const r = await hook(tc('c1'), { sessionId: 's1' })
    expect(r).toEqual({ deny: true, reason: '已停止' })
    expect(onDialog).not.toHaveBeenCalled()
  })

  it('re-checks after waiting: an abort while queued denies without a dialog', async () => {
    let aborted = false
    let releaseC1: () => void = () => {}
    const dialogs: string[] = []
    const onDialog = vi.fn(async (t: ToolCall) => {
      dialogs.push(t.id)
      if (t.id === 'c1') {
        await new Promise<void>((r) => { releaseC1 = r })
      }
      return true
    })
    const hook = makeHook({ isAborted: () => aborted, onDialog })

    const p1 = hook(tc('c1'), { sessionId: 's1' }) // takes the dialog turn and stalls
    await new Promise((r) => setTimeout(r, 10))
    const p2 = hook(tc('c2'), { sessionId: 's1' }) // queued behind c1's dialog
    aborted = true // the run is stopped while c2 waits
    releaseC1() // c1's dialog resolves → c2's turn arrives → must re-check
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toEqual({ allow: true })
    expect(r2).toEqual({ deny: true, reason: '已停止' })
    expect(dialogs).toEqual(['c1']) // c2 never got a dialog
  })

  it('a dangerous command forces the dialog even when every exemption is active', async () => {
    const onDialog = vi.fn(async () => true)
    // needsApproval says NO for everything — the full-auto-approve scenario.
    const hook = makeHook({ needsApproval: () => false, onDialog })
    const dangerous = { id: 'd1', name: 'run_command', arguments: { command: 'rm -rf /' } } as ToolCall
    const r = await hook(dangerous, { sessionId: 's1' })
    expect(r).toEqual({ allow: true })
    expect(onDialog).toHaveBeenCalledTimes(1)
    const preview = onDialog.mock.calls[0][1] as string
    expect(preview).toContain('⚠️ 危险命令')
  })

  it('a routine command still passes without a dialog under exemptions', async () => {
    const onDialog = vi.fn(async () => true)
    const hook = makeHook({ needsApproval: () => false, onDialog })
    const routine = { id: 'd2', name: 'run_command', arguments: { command: 'npm test' } } as ToolCall
    const r = await hook(routine, { sessionId: 's1' })
    expect(r).toEqual({ allow: true })
    expect(onDialog).not.toHaveBeenCalled()
  })

  it('reports auto-approved calls only for approval-gated tools', async () => {
    const onAutoApprove = vi.fn()
    const hook = makeHook({
      needsApproval: () => false,
      requiresApproval: (name) => name.startsWith('write_'),
      onAutoApprove,
    })
    await hook(tc('w1'), { sessionId: 's1' }) // write tool, exempted → counted
    await hook(tc('r1', 'read_file'), { sessionId: 's1' }) // read-only → not counted
    expect(onAutoApprove).toHaveBeenCalledTimes(1)
    expect(onAutoApprove).toHaveBeenCalledWith(expect.objectContaining({ name: 'write_file' }))
  })
})

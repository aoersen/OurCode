import { describe, it, expect } from 'vitest'
import {
  WORKER_ROSTER,
  DEV_SLOTS,
  TEST_SLOTS,
  roleForSlot,
  titleForSlot,
  buildWorkerSystemPrompt,
  isDevWorker,
  isTestWorker,
} from '@/services/office/workers'
import type { ChatSession } from '@shared/types'

describe('office/workers: 8 工位动态编制（M4）', () => {
  it('最低编制 = 固定三岗 + 研发/测试各 1 名', () => {
    // 固定：需求分析师(2)、UI 研发(3)；动态最低：业务研发-1(4)、测试-1(7)
    expect(WORKER_ROSTER.map((w) => w.slot).sort((a, b) => a - b)).toEqual([2, 3, 4, 7])
    expect(WORKER_ROSTER.find((w) => w.slot === 4)?.role).toBe('tm-developer')
    expect(WORKER_ROSTER.find((w) => w.slot === 7)?.role).toBe('tm-tester')
  })

  it('工位池：研发 4/5/6、测试 7/8，各最少保留 1 名可增删', () => {
    expect(DEV_SLOTS).toEqual([4, 5, 6])
    expect(TEST_SLOTS).toEqual([7, 8])
    expect(roleForSlot(5)).toBe('tm-developer')
    expect(roleForSlot(8)).toBe('tm-tester')
    expect(titleForSlot(4)).toBe('业务研发-1')
    expect(titleForSlot(6)).toBe('业务研发-3')
    expect(titleForSlot(7)).toBe('测试-1')
    expect(titleForSlot(8)).toBe('测试-2')
    expect(titleForSlot(2)).toBe('需求分析师')
    expect(titleForSlot(3)).toBe('UI 研发')
  })

  it('员工系统提示 = 角色人设 + 员工规则（回报总监/只读子智能体）', async () => {
    const prompt = await buildWorkerSystemPrompt('tm-developer', '你是研发角色人设。')
    expect(prompt).toContain('你是研发角色人设。')
    expect(prompt).toContain('send_message 向总监会话回报')
    expect(prompt).toContain('readonly: true')
    expect(prompt).toContain('只与总监对话')
  })

  it('isDevWorker / isTestWorker 按工位池判定', () => {
    const mk = (slot: number): ChatSession =>
      ({ workerRole: 'tm-developer', workerSlot: slot } as ChatSession)
    expect(isDevWorker(mk(4))).toBe(true)
    expect(isDevWorker(mk(6))).toBe(true)
    expect(isDevWorker(mk(7))).toBe(false)
    expect(isTestWorker(mk(7))).toBe(true)
    expect(isTestWorker(mk(8))).toBe(true)
    expect(isTestWorker(mk(3))).toBe(false)
  })
})

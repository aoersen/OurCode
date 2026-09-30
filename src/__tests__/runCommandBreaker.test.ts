import { describe, it, expect, vi } from 'vitest'

// 与 chatStore.test.ts 相同的环境准备：monaco 的浏览器模块在 import 时引用
// window，Node 测试环境没有——用空桩替换；store 通过 window.electronAPI 持久化，
// 先 stub 再 import（vi.mock 会被 vitest 提升到 import 之前）。
vi.mock('@/editor/monacoSetup', () => ({ monaco: {} }))
vi.stubGlobal('window', { electronAPI: {} })

import { isRunCommandInfraFailure } from '@/stores/chatStore'

/**
 * 连续失败熔断的分类边界：只有「命令没跑成」的基础设施级失败（超时/终止/
 * 语法错误/无法执行/后台启动失败）才计入熔断；命令执行后如实报告的非零退出
 * 码（typecheck/测试报红）是验证信号，不计入——否则并行 worker 的正常
 * 编辑-验证循环会被反复误杀成「任务卡死」。
 */
describe('isRunCommandInfraFailure', () => {
  it('counts infra-level failures', () => {
    for (const text of [
      'Error: [超时] 命令执行超过 30 秒被终止。',
      'Error: [已终止] 用户停止了任务…',
      'Error: [语法错误] 命令被 PowerShell 解析器拒绝…',
      'Error: [无法执行] 找不到命令或解释器…',
      'Error: 后台命令启动失败：pty 打开失败',
    ]) {
      expect(isRunCommandInfraFailure(text), text).toBe(true)
    }
  })

  it('does NOT count verification failures (command ran, reported errors)', () => {
    for (const text of [
      'Error: [命令报错] Command failed: npm run typecheck\nsrc/ipc.ts(21,3): error TS6196',
      'Error: [命令报错] git commit 失败：pre-commit hook exited 1',
      'Error: Command failed: npm run typecheck', // 旧格式兜底也不计
      'Error executing run_command: IPC 异常', // 走 isError 通道
    ]) {
      expect(isRunCommandInfraFailure(text), text).toBe(false)
    }
  })

  it('ignores non-error results', () => {
    expect(isRunCommandInfraFailure('> tsc --noEmit')).toBe(false)
    expect(isRunCommandInfraFailure('[shell 兼容] …\n> tsc --noEmit')).toBe(false)
  })
})

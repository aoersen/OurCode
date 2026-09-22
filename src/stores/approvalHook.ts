/**
 * Approval pre-hook factory — the agent loop's per-tool approval decision,
 * extracted so the full flow (gate serialization → re-checks → dialog → allow /
 * deny) can be unit-tested without booting the whole store.
 *
 * The hook is registered on the shared ToolExecutor for one agent run. It
 * filters by session (the executor is shared by parallel loops), denies tools
 * the user batch-rejected, and shows ONE dialog at a time — the executor runs
 * a round's tools concurrently but the store has a single pendingApproval slot
 * and one resolve-key per session, so concurrent dialogs would overwrite each
 * other and silently reject every tool but the last.
 *
 * 决策顺序（权限模式矩阵）：
 *   批量拒绝 → 模式级硬拦截（计划只读期）→ 计划交付范围（scopeGate）→
 *   危险命令 → 项目黑名单 → 模式矩阵 / 白名单（needsApproval）→ 审批卡片。
 * 危险命令在黑名单之上：即使用户「始终拒绝」过该工具，危险命令仍弹确认；
 * 但计划只读期的硬拦截优先于危险命令（只读期任何写入/命令都不执行）。
 */
import type { ToolExecuteContext } from '@/services/tools/ToolExecutor'
import type { ToolCall } from '@/services/tools/types'
import { createSerialGate } from '@/utils/serialGate'
import { analyzeDangerousCommand } from '@/services/tools/dangerousCommands'

export type ApprovalHookOutcome = { allow: true } | { deny: true; reason: string }

export interface ApprovalPreHookOptions {
  sessionId: string
  /** Per-round batch-rejected tool ids (user declined the whole round). */
  batchRejectedRef: { current: Set<string> }
  /** Live approval decision (project edit mode / batch / allowlist). */
  needsApproval: (name: string) => boolean
  /** Preview text shown in the dialog. */
  getPreview: (toolCall: ToolCall) => string
  /** True once the enclosing run has been aborted — deny without a dialog. */
  isAborted: () => boolean
  /** 模式级硬拦截（计划模式只读期）：返回拒绝原因时直接拒绝，不弹窗、
   *  优先级高于危险命令与黑名单（只读期连危险命令也不执行）。 */
  blockedReason?: (name: string) => string | null
  /** 项目黑名单（始终拒绝）——命中即拒，不弹窗。危险命令不受其影响。 */
  isDenied?: (name: string) => string | null
  /** 计划模式交付范围门禁：返回 false 表示拒绝（通常已弹出「计划外写入被
   *  拦截」卡片等待用户决策）。在 needsApproval 之前运行。 */
  scopeGate?: (toolCall: ToolCall) => Promise<boolean>
  /** Show the dialog and resolve with the user's decision. dangerous=true 时
   *  卡片只提供 允许（一次）/拒绝，且不可加入任何白名单。权限请求不超时。 */
  onDialog: (toolCall: ToolCall, preview: string, dangerous: boolean) => Promise<boolean>
  /** Serialization gate — injectable for tests; defaults to a fresh FIFO gate. */
  gate?: { enter: () => Promise<() => void> }
}

/** Build the run's approval pre-hook (see the module docs). */
export function createApprovalPreHook(opts: ApprovalPreHookOptions): (
  toolCall: ToolCall,
  ctx: ToolExecuteContext,
) => Promise<ApprovalHookOutcome> {
  const gate = opts.gate ?? createSerialGate()
  return async (toolCall, ctx): Promise<ApprovalHookOutcome> => {
    if (ctx.sessionId !== opts.sessionId) return { allow: true }
    // Tools the user batch-rejected this round — deny without a dialog.
    if (opts.batchRejectedRef.current.has(toolCall.id)) return { deny: true, reason: '用户拒绝了此操作' }
    // 模式级硬拦截（计划模式只读期）优先于一切：连危险命令也不执行。
    const modeBlocked = opts.blockedReason?.(toolCall.name)
    if (modeBlocked) return { deny: true, reason: modeBlocked }
    // 计划模式执行期：只允许写计划声明的最终产物。scopeGate 内部处理弹卡
    // 与等待；返回 false 即拒绝（用户点了拒绝，或未声明且未放行）。
    if (opts.scopeGate) {
      const inScope = await opts.scopeGate(toolCall)
      if (!inScope) return { deny: true, reason: '计划外写入被拦截' }
    }
    // Destructive / irreversible / remote-execution shapes force the dialog
    // even when every exemption (full_access / batch / allowlist / denylist) is
    // active — when all other gates are off, this is the last line of defense.
    const danger = toolCall.name === 'run_command'
      ? analyzeDangerousCommand(String(toolCall.arguments?.command || ''))
      : null
    // 项目黑名单：直接拒绝，不弹窗（危险命令除外——它必须人工确认）。
    if (!danger) {
      const denied = opts.isDenied?.(toolCall.name)
      if (denied) return { deny: true, reason: denied }
    }
    if (!opts.needsApproval(toolCall.name) && !danger) {
      return { allow: true }
    }

    // Wait for the previous approval dialog before showing ours.
    const release = await gate.enter()
    try {
      // Re-check after waiting: the run may have been stopped or batch-approved
      // while we waited (e.g. the anti-flail question switched the edit mode),
      // and the batch-reject set may have been updated.
      if (opts.isAborted()) return { deny: true, reason: '已停止' }
      if (opts.batchRejectedRef.current.has(toolCall.id)) return { deny: true, reason: '用户拒绝了此操作' }
      if (!danger) {
        const denied = opts.isDenied?.(toolCall.name)
        if (denied) return { deny: true, reason: denied }
      }
      if (!opts.needsApproval(toolCall.name) && !danger) return { allow: true }

      const preview = danger
        ? `${opts.getPreview(toolCall)}\n\n⚠️ 危险命令：${danger.reason}（自动批准豁免对其无效，需人工确认）`
        : opts.getPreview(toolCall)
      const approved = await opts.onDialog(toolCall, preview, !!danger)
      return approved ? { allow: true } : { deny: true, reason: '用户拒绝了此操作' }
    } finally {
      release()
    }
  }
}

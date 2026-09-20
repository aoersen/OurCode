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
  /** Whether the tool is approval-gated by default — drives the auto-approve
   *  counter (only exempted approval tools count, read-only tools don't). */
  requiresApproval?: (name: string) => boolean
  /** Called when an approval-gated tool passes WITHOUT a dialog (edit-mode /
   *  batch / allowlist exemption) — feeds the auto-approve visibility counter. */
  onAutoApprove?: (toolCall: ToolCall) => void
  /** Preview text shown in the dialog. */
  getPreview: (toolCall: ToolCall) => string
  /** True once the enclosing run has been aborted — deny without a dialog. */
  isAborted: () => boolean
  /** Show the dialog and resolve with the user's decision. The 60s auto-reject
   *  and the store's pendingApproval/pending resolves live inside this — the
   *  hook only cares about the boolean outcome. */
  onDialog: (toolCall: ToolCall, preview: string) => Promise<boolean>
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
    // Destructive / irreversible / remote-execution shapes force the dialog
    // even when every exemption (full_access / batch / allowlist) is active —
    // when all other gates are off, this is the last line of defense.
    const danger = toolCall.name === 'run_command'
      ? analyzeDangerousCommand(String(toolCall.arguments?.command || ''))
      : null
    if (!opts.needsApproval(toolCall.name) && !danger) {
      if (opts.requiresApproval?.(toolCall.name)) opts.onAutoApprove?.(toolCall)
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
      if (!opts.needsApproval(toolCall.name) && !danger) return { allow: true }

      const preview = danger
        ? `${opts.getPreview(toolCall)}\n\n⚠️ 危险命令：${danger.reason}（自动批准豁免对其无效，需人工确认）`
        : opts.getPreview(toolCall)
      const approved = await opts.onDialog(toolCall, preview)
      return approved ? { allow: true } : { deny: true, reason: '用户拒绝了此操作' }
    } finally {
      release()
    }
  }
}

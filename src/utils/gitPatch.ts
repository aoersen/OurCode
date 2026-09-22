/**
 * `git apply` argument shapes the central diff editor sends for per-hunk
 * stage / unstage / revert, as pure data.
 *
 * Extracted because the git argv gate (electron/services/vcs-exec.ts) only
 * admits `apply` in these exact forms: pulling them here lets a unit test assert
 * "everything the UI sends still passes the gate", which is the regression that
 * silently broke per-hunk revert once already.
 */
export type PatchAction = 'stage' | 'unstage' | 'revert'

export interface PatchArgs {
  check: string[]
  apply: string[]
}

/**
 * Staged diff → the index is the working side, so unstage/revert both mean
 * reverse-apply to the index. Unstaged → the worktree is the working side.
 * `-` on both ends means the patch arrives on stdin, never as a file path.
 */
export function applyPatchArgs(action: PatchAction, staged: boolean): PatchArgs {
  if (action === 'stage') {
    return {
      check: ['apply', '--cached', '--whitespace=nowarn', '--check', '-'],
      apply: ['apply', '--cached', '--whitespace=nowarn', '-'],
    }
  }
  if (action === 'unstage' || (action === 'revert' && staged)) {
    return {
      check: ['apply', '--cached', '-R', '--whitespace=nowarn', '--check', '-'],
      apply: ['apply', '--cached', '-R', '--whitespace=nowarn', '-'],
    }
  }
  return {
    check: ['apply', '-R', '--whitespace=nowarn', '--check', '-'],
    apply: ['apply', '-R', '--whitespace=nowarn', '-'],
  }
}

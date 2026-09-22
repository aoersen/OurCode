/**
 * run_command side-effect checkpoints.
 *
 * The write-tool checkpoint (checkpointService) only covers files the model
 * edits through write/edit/delete tools. A command the model runs can change
 * files behind that net — formatters, code generators, `npm install` lockfile
 * churn — and those changes were previously unrevertable. This module closes
 * the gap for git repositories:
 *
 *   pre  — before the command runs, record `git status --porcelain -z` (the
 *          dirty set D0) plus the on-disk content of those files;
 *   post — after the command, re-run status (D1) and build a checkpoint from
 *          every file whose state moved: pre-command content comes from the
 *          D0 capture, or from `git show HEAD:<path>` for files that were
 *          clean before, or "did not exist" for files the command created.
 *
 * Git runs FROM the command's working directory (always inside the fs
 * allowlist), while status paths are repo-root-relative — so workspaces
 * nested inside a larger repo also work, without ever using the repo root as
 * a gitExec cwd (which the fs allowlist would reject). Files outside the
 * OPENED WORKSPACE root are skipped explicitly (isWithin): they cannot be
 * snapshotted and must not be reverted.
 *
 * Files over MAX_SNAPSHOT_FILE_BYTES are skipped entirely — a snapshot with
 * empty content for an existing file would let a revert clobber it with an
 * empty string, which is worse than no snapshot. The same skip applies to
 * files that exist but cannot be read, so a transient read failure can never
 * turn into a destructive "did not exist" revert record. Non-git workspaces
 * fall through: rev-parse fails and the caller gets null (nothing captured).
 */
import { v4 as uuidv4 } from 'uuid'
import type { Checkpoint } from '@/types'

/** Files larger than this are never snapshotted (content reads via IPC). */
export const MAX_SNAPSHOT_FILE_BYTES = 5 * 1024 * 1024

/** One dirty file's pre-command state (path relative to the repo root). */
export interface RunFileState {
  existed: boolean
  content: string
  tracked: boolean
  /** True when the file was too large / unreadable to snapshot — it must be
   *  skipped in the post phase too, or a revert would write empty content
   *  over it. */
  oversized?: boolean
}

/** Pre-command capture: repo root + dirty set D0 with disk contents. */
export interface RunPreState {
  /** The repository root (git paths are relative to it). */
  root: string
  /** Host path separator ('\\' on Windows) — derived from the workspace path. */
  sep: string
  /** The command's working directory (allowed gitExec cwd). */
  workDir: string
  /** The opened workspace root — paths outside it are never snapshotted. */
  workspaceRoot: string
  dirty: Map<string, RunFileState>
}

/**
 * Parse `git status --porcelain -z` output.
 * Each item is `XY PATH` (or `XY NEW` followed by `OLD` for rename/copy); the
 * -z form is NUL-terminated, so paths with spaces survive intact. Rename/copy
 * entries carry the trailing old-path item in `renameFrom` — callers use it to
 * also record the deleted old path, otherwise a `git mv` run by a command
 * would be invisible (the new path is not in HEAD, the old path is gone).
 */
export function parsePorcelainZ(output: string): Array<{ code: string; path: string; renameFrom?: string }> {
  const raw = output.split('\0').filter((s) => s.length > 0)
  const entries: Array<{ code: string; path: string; renameFrom?: string }> = []
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    if (item.length < 4) continue
    const code = item.slice(0, 2)
    const path = item.slice(3)
    if (code.startsWith('R') || code.startsWith('C')) {
      const oldPath = raw[++i]
      entries.push({ code, path, renameFrom: oldPath || undefined })
    } else {
      entries.push({ code, path })
    }
  }
  return entries
}

/** Where each candidate's pre-command content comes from. Pure for tests. */
export function classifyCandidates(
  preDirty: Map<string, RunFileState>,
  postDirty: Map<string, string>,
): Array<{ rel: string; source: 'captured' | 'head' | 'new' | 'skip' }> {
  const candidates = new Set([...preDirty.keys(), ...postDirty.keys()])
  const out: Array<{ rel: string; source: 'captured' | 'head' | 'new' | 'skip' }> = []
  for (const rel of candidates) {
    const pre = preDirty.get(rel)
    if (pre?.oversized) {
      out.push({ rel, source: 'skip' })
      continue
    }
    const code = postDirty.get(rel)
    if (pre) {
      // Dirty before the run — the capture holds the pre-command content.
      out.push({ rel, source: 'captured' })
    } else if (!code || !code.startsWith('??')) {
      // Clean before the run (or no longer present) — HEAD holds the content.
      out.push({ rel, source: 'head' })
    } else {
      // Untracked and unseen before — the command created it.
      out.push({ rel, source: 'new' })
    }
  }
  return out
}

/** Join a repo-root-relative git path onto the root, normalizing to `sep`.
 *  Git reports '/' separators (and returns the root forward-slashed on
 *  Windows); checkpoint paths must use the host spelling so they compare
 *  equal with the paths the rest of the app stores. */
function joinRepoPath(root: string, rel: string, sep: string): string {
  return `${root.replace(/[\\/]+$/, '')}${sep}${rel.replace(/\//g, sep)}`
}

/** Host separator style, inferred from the (host-spelled) workspace path. */
function hostSep(hint: string): string {
  return hint.includes('\\') ? '\\' : '/'
}

/** Is `p` equal to or inside `root`? Both are normalized to `sep` first.
 *  Case-insensitive like the main-process allowlist (isPathAllowed lowercases
 *  on win32): a case mismatch here would otherwise silently drop the whole
 *  checkpoint. On case-sensitive systems a wrong-case match can only make
 *  this check PASS — the main-side allowlist then rejects, which fails safe. */
function isWithin(p: string, root: string, sep: string): boolean {
  const P = p.replace(/[\\/]/g, sep).toLowerCase()
  const R = root.replace(/[\\/]/g, sep).replace(/[\\/]+$/, '').toLowerCase()
  return P === R || P.startsWith(R + sep)
}

/**
 * Capture the pre-command state for a run_command about to execute in
 * `workDir`. Git runs FROM workDir (an allowed path); status paths are
 * repo-root-relative, and files outside `workspaceRoot` are skipped — they
 * cannot be snapshotted and must not be reverted. Null when workDir is not
 * inside a git repository.
 */
export async function captureRunPreState(workDir: string, workspaceRoot?: string): Promise<RunPreState | null> {
  try {
    const rootRes = await window.electronAPI.gitExec(workDir, ['rev-parse', '--show-toplevel'])
    if (!rootRes?.success) return null
    const wsRoot = workspaceRoot || workDir
    const sep = hostSep(wsRoot)
    const root = rootRes.output.trim().replace(/[\\/]+$/, '').replace(/[\\/]/g, sep)
    if (!root) return null
    const statusRes = await window.electronAPI.gitExec(workDir, ['status', '--porcelain', '-z'])
    if (!statusRes?.success) return null
    const dirty = new Map<string, RunFileState>()
    for (const e of parsePorcelainZ(statusRes.output)) {
      const tracked = !e.code.startsWith('??')
      // A RENAME's old path is worktree-deleted by definition — record it so
      // the post-phase can restore it from HEAD when the command did the move.
      // (A COPY keeps the original on disk, so no synthetic deletion there.)
      if (e.renameFrom && e.code.startsWith('R')) {
        const oldAbs = joinRepoPath(root, e.renameFrom, sep)
        if (isWithin(oldAbs, wsRoot, sep)) {
          dirty.set(e.renameFrom, { existed: false, content: '', tracked: true })
        }
      }
      const abs = joinRepoPath(root, e.path, sep)
      if (!isWithin(abs, wsRoot, sep)) continue
      let st: { size: number; isFile: boolean } | null
      try {
        st = await window.electronAPI.stat(abs)
      } catch {
        // A stat FAILURE is not "file missing" — record nothing rather than a
        // destructive false "deleted" that a revert would enforce.
        continue
      }
      if (!st) {
        // Missing on disk (deleted in worktree) — still a member of D0.
        dirty.set(e.path, { existed: false, content: '', tracked })
      } else if (st.size > MAX_SNAPSHOT_FILE_BYTES || !st.isFile) {
        // Oversized files / untracked directories: skip in the post phase
        // (a snapshot with empty content would let a revert clobber them).
        dirty.set(e.path, { existed: true, content: '', tracked, oversized: true })
      } else {
        try {
          const { content } = await window.electronAPI.readFile(abs)
          dirty.set(e.path, { existed: true, content, tracked })
        } catch {
          // Exists but unreadable — skip; never let a revert delete it.
          dirty.set(e.path, { existed: true, content: '', tracked, oversized: true })
        }
      }
    }
    return { root, sep, workDir, workspaceRoot: wsRoot, dirty }
  } catch {
    return null
  }
}

/**
 * After the command finished, diff the tree against the pre-state and create
 * a checkpoint for every file whose content/existence moved. Returns the
 * checkpoint, or null when nothing changed (or the repo vanished mid-run).
 */
export async function buildRunCommandCheckpoint(
  pre: RunPreState,
  command: string,
  sessionId: string,
  messageId?: string,
): Promise<Checkpoint | null> {
  let postDirty: Map<string, string>
  try {
    const statusRes = await window.electronAPI.gitExec(pre.workDir, ['status', '--porcelain', '-z'])
    if (!statusRes?.success) return null
    postDirty = new Map<string, string>()
    for (const e of parsePorcelainZ(statusRes.output)) {
      if (e.renameFrom && e.code.startsWith('R')) {
        // A rename means: old path deleted in the worktree, new path exists
        // but is not in HEAD. Synthesize 'D ' / '??' so the classifier pulls
        // the old content from HEAD and treats the new path as command-created.
        const oldAbs = joinRepoPath(pre.root, e.renameFrom, pre.sep)
        if (isWithin(oldAbs, pre.workspaceRoot, pre.sep)) postDirty.set(e.renameFrom, 'D ')
        postDirty.set(e.path, '??')
      } else if (e.code.startsWith('C') || e.code.startsWith('A')) {
        // Staged copy / staged new file: the path is NOT in HEAD (an added
        // file shows as 'A ' by default — copy detection is usually off), so
        // its pre-state is "absent". Undoing the command deletes the copy /
        // new file and never touches the original.
        postDirty.set(e.path, '??')
      } else {
        postDirty.set(e.path, e.code)
      }
    }
  } catch {
    return null
  }

  const files: Array<{ path: string; content: string; existed: boolean }> = []
  for (const { rel, source } of classifyCandidates(pre.dirty, postDirty)) {
    if (source === 'skip') continue
    const abs = joinRepoPath(pre.root, rel, pre.sep)
    if (!isWithin(abs, pre.workspaceRoot, pre.sep)) continue

    // Pre-command content.
    let preContent = ''
    let preExisted = false
    if (source === 'captured') {
      const preEntry = pre.dirty.get(rel)!
      preContent = preEntry.content
      preExisted = preEntry.existed
    } else if (source === 'head') {
      try {
        // gitExecRaw: byte-exact stdout (gitExec trims, which would corrupt
        // leading/trailing whitespace in the snapshot). Status paths are
        // repo-root-relative, so `rel` is exactly the HEAD blob path.
        const res = await window.electronAPI.gitExecRaw(pre.workDir, ['show', `HEAD:${rel}`])
        if (!res?.success) continue
        if (Buffer.byteLength(res.output, 'utf8') > MAX_SNAPSHOT_FILE_BYTES) continue
        preContent = res.output
        preExisted = true
      } catch {
        continue
      }
    }
    // source === 'new': the command created the file — pre state is "absent".

    // Current on-disk content. Skip oversized / directories / unreadable —
    // a false "absent" here would make the revert DELETE the file.
    let curContent = ''
    let curExisted = false
    try {
      const st = await window.electronAPI.stat(abs)
      if (st) {
        if (st.size > MAX_SNAPSHOT_FILE_BYTES || !st.isFile) continue
        const { content } = await window.electronAPI.readFile(abs)
        curContent = content
        curExisted = true
      }
    } catch {
      // Unreadable right now — skip this file entirely.
      continue
    }

    if (curExisted === preExisted && curContent === preContent) continue
    files.push({ path: abs, content: preContent, existed: preExisted })
  }

  if (files.length === 0) return null

  const brief = command.trim().replace(/\s+/g, ' ').slice(0, 80)
  const checkpoint: Checkpoint = {
    id: uuidv4(),
    sessionId,
    createdAt: Date.now(),
    label: `run_command → ${brief}`,
    messageId: messageId || undefined,
    files,
  }
  await window.electronAPI.checkpointCreate(checkpoint)
  return checkpoint
}

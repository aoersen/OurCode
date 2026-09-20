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
 * All git reads go through the existing gitExec/gitExecRaw IPC (allowlisted,
 * 15s timeout, 5MB output cap), so no new privilege surface is opened. Files
 * over MAX_SNAPSHOT_FILE_BYTES are skipped entirely — a snapshot with empty
 * content for an existing file would let a revert clobber it with an empty
 * string, which is worse than no snapshot. Non-git workspaces fall through:
 * rev-parse fails and the caller gets null (nothing captured).
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
  /** True when the file was too large to snapshot — it must be skipped in the
   *  post phase too, or a revert would write empty content over it. */
  oversized?: boolean
}

/** Pre-command capture: repo root + dirty set D0 with disk contents. */
export interface RunPreState {
  root: string
  dirty: Map<string, RunFileState>
}

/**
 * Parse `git status --porcelain -z` output.
 * Each item is `XY PATH` (or `XY NEW` followed by `OLD` for rename/copy); the
 * -z form is NUL-terminated, so paths with spaces survive intact. Rename/copy
 * entries consume their trailing old-path item.
 */
export function parsePorcelainZ(output: string): Array<{ code: string; path: string }> {
  const raw = output.split('\0').filter((s) => s.length > 0)
  const entries: Array<{ code: string; path: string }> = []
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    if (item.length < 4) continue
    const code = item.slice(0, 2)
    const path = item.slice(3)
    entries.push({ code, path })
    if (code.startsWith('R') || code.startsWith('C')) i++ // skip the old-path item
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

/** Join a repo-root-relative git path onto the root (git uses '/' separators). */
function joinRepoPath(root: string, rel: string): string {
  return `${root.replace(/[\\/]+$/, '')}/${rel}`
}

/**
 * Capture the pre-command state for a run_command about to execute in
 * `workDir`. Resolves the repo root first (rev-parse), then snapshots the
 * dirty set. Null when workDir is not inside a git repository.
 */
export async function captureRunPreState(workDir: string): Promise<RunPreState | null> {
  try {
    const rootRes = await window.electronAPI.gitExec(workDir, ['rev-parse', '--show-toplevel'])
    if (!rootRes?.success) return null
    const root = rootRes.output.trim()
    if (!root) return null
    const statusRes = await window.electronAPI.gitExec(root, ['status', '--porcelain', '-z'])
    if (!statusRes?.success) return null
    const dirty = new Map<string, RunFileState>()
    for (const e of parsePorcelainZ(statusRes.output)) {
      const tracked = !e.code.startsWith('??')
      const abs = joinRepoPath(root, e.path)
      try {
        const st = await window.electronAPI.stat(abs)
        if (st && st.size > MAX_SNAPSHOT_FILE_BYTES) {
          dirty.set(e.path, { existed: true, content: '', tracked, oversized: true })
          continue
        }
        const { content } = await window.electronAPI.readFile(abs)
        dirty.set(e.path, { existed: true, content, tracked })
      } catch {
        // Missing on disk (deleted in worktree) — still a member of D0.
        dirty.set(e.path, { existed: false, content: '', tracked })
      }
    }
    return { root, dirty }
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
  let postDirty = new Map<string, string>()
  try {
    const statusRes = await window.electronAPI.gitExec(pre.root, ['status', '--porcelain', '-z'])
    if (!statusRes?.success) return null
    for (const e of parsePorcelainZ(statusRes.output)) postDirty.set(e.path, e.code)
  } catch {
    return null
  }

  const files: Array<{ path: string; content: string; existed: boolean }> = []
  for (const { rel, source } of classifyCandidates(pre.dirty, postDirty)) {
    if (source === 'skip') continue
    const abs = joinRepoPath(pre.root, rel)

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
        // leading/trailing whitespace in the snapshot).
        const res = await window.electronAPI.gitExecRaw(pre.root, ['show', `HEAD:${rel}`])
        if (!res?.success) continue
        if (Buffer.byteLength(res.output, 'utf8') > MAX_SNAPSHOT_FILE_BYTES) continue
        preContent = res.output
        preExisted = true
      } catch {
        continue
      }
    }
    // source === 'new': the command created the file — pre state is "absent".

    // Current on-disk content (skip oversized — see the module comment).
    let curContent = ''
    let curExisted = false
    try {
      const st = await window.electronAPI.stat(abs)
      if (st) {
        if (st.size > MAX_SNAPSHOT_FILE_BYTES) continue
        const { content } = await window.electronAPI.readFile(abs)
        curContent = content
        curExisted = true
      }
    } catch {
      curExisted = false
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

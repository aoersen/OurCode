/**
 * Shadow-git whole-tree checkpoints.
 *
 * The renderer's per-file checkpoints (checkpointService.ts) cover write tools,
 * but they cannot restore a deleted directory, a command's side effects, or a
 * project that is not a git repository. This service keeps a shadow git repo
 * OUTSIDE the project (under userData) and snapshots the whole work tree into
 * it. It never touches the project's own `.git`.
 *
 * Key properties:
 * - works for non-git projects (the project is only a --work-tree);
 * - `-f` includes files ignored by the project's .gitignore (.env, local
 *   config) while pathspec excludes keep generated directories out;
 * - commits are stored under `refs/checkpoints/<id>`, not on HEAD, so old
 *   snapshots can be pruned independently;
 * - every operation is serialized per project (the renderer may run several
 *   agents in parallel).
 */
import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, rmdirSync, rmSync, statSync } from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'

/** Generated directories are rebuildable; keep them out of full-tree snapshots. */
const DEFAULT_EXCLUDES = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.cache',
]

export class CheckpointError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CheckpointError'
  }
}

export interface SnapshotOptions {
  /** Checkpoint id; used for the shadow ref. */
  id: string
  /** Restrict the snapshot to these absolute paths (targeted file/dir ops). */
  paths?: string[]
  /** Include generated directories (strict restore mode). */
  includeGenerated?: boolean
  /** Collect empty directories (needed to restore a deleted directory tree). */
  collectEmptyDirs?: boolean
}

export interface SnapshotResult {
  commit: string
  paths: string[]
  emptyDirs: string[]
}

export interface WorkspaceDiffEntryFs {
  path: string
  status: 'added' | 'modified' | 'deleted'
}

export interface RestoreResultFs {
  restored: number
  deleted: number
  skipped: number
  conflicts: string[]
}

// One promise chain per project root — snapshots and restores must not race on
// the shadow index.
const projectLocks = new Map<string, Promise<unknown>>()

function normalizeRoot(projectRoot: string): string {
  return resolve(projectRoot)
}

function projectKey(projectRoot: string): string {
  const normalized = normalizeRoot(projectRoot)
  return createHash('sha1').update(process.platform === 'win32' ? normalized.toLowerCase() : normalized).digest('hex')
}

function hostPath(projectRoot: string, rel: string): string {
  return join(projectRoot, ...rel.split('/'))
}

/** Relative POSIX path for git args (git always speaks '/'). */
function gitRel(projectRoot: string, absPath: string): string {
  return relative(projectRoot, absPath).split(sep).join('/')
}

function isWithin(projectRoot: string, absPath: string): boolean {
  const root = normalizeRoot(projectRoot)
  const p = resolve(absPath)
  if (process.platform === 'win32') {
    const r = root.toLowerCase()
    const q = p.toLowerCase()
    return q === r || q.startsWith(r + sep)
  }
  return p === root || p.startsWith(root + sep)
}

function pathspecFor(projectRoot: string, absPaths: string[]): string[] {
  return absPaths.map((p) => `:(literal)${gitRel(projectRoot, p)}`)
}

function excludesPathspec(includeGenerated: boolean): string[] {
  if (includeGenerated) return []
  return DEFAULT_EXCLUDES.map((d) => `:(exclude,glob)**/${d}/**`)
}

const GENERATED_DIR_NAMES = new Set(DEFAULT_EXCLUDES)

/** Does the restore scope touch a generated dir? If so, the full staging pass
 *  must include generated dirs too — otherwise a deletion inside them is never
 *  staged and the diff/restore cannot see it. */
function scopeTouchesGenerated(paths: string[]): boolean {
  return paths.some((p) =>
    p.split(/[\\/]/).some((seg) => GENERATED_DIR_NAMES.has(seg)),
  )
}

function runGit(
  projectRoot: string,
  repoDir: string,
  args: string[],
  opts: { allowFailure?: boolean } = {},
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      ['--git-dir', repoDir, '--work-tree', normalizeRoot(projectRoot), ...args],
      {
        cwd: normalizeRoot(projectRoot),
        timeout: 60_000,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_AUTHOR_NAME: 'OurCode Checkpoint',
          GIT_AUTHOR_EMAIL: 'checkpoint@ourcode.local',
          GIT_COMMITTER_NAME: 'OurCode Checkpoint',
          GIT_COMMITTER_EMAIL: 'checkpoint@ourcode.local',
        },
      },
      (error, stdout, stderr) => {
        if (error && !opts.allowFailure) {
          reject(new CheckpointError(String(stderr || error.message || 'git 执行失败').trim()))
          return
        }
        resolvePromise(String(stdout))
      },
    )
  })
}

/** `git init` rejects --work-tree; run it with only --git-dir. */
function runGitDir(repoDir: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      ['--git-dir', repoDir, ...args],
      {
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new CheckpointError(String(stderr || error.message || 'git 执行失败').trim()))
          return
        }
        resolvePromise(String(stdout))
      },
    )
  })
}

/** Parse `git diff --name-status -z` output. */
export function parseNameStatusZ(output: string): Array<{ status: 'added' | 'modified' | 'deleted'; rel: string }> {
  const parts = output.split('\0').filter((s) => s.length > 0)
  const out: Array<{ status: 'added' | 'modified' | 'deleted'; rel: string }> = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i]
    const rel = parts[i + 1]
    if (!rel) continue
    const letter = code[0]
    const status = letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified'
    out.push({ status, rel })
  }
  return out
}

/** Recursively collect empty directories under `root` (absolute paths). */
function collectEmptyDirs(root: string, includeRoot = false): string[] {
  const out: string[] = []
  const walk = (dir: string): boolean => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return false
    }
    let hasContent = false
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        hasContent = true
        continue
      }
      if (entry.isDirectory()) {
        const childHasContent = walk(join(dir, entry.name))
        if (childHasContent) hasContent = true
      } else {
        hasContent = true
      }
    }
    if (!hasContent && (dir !== root || includeRoot)) out.push(dir)
    return hasContent
  }
  try {
    if (statSync(root).isDirectory()) walk(root)
  } catch {
    // Missing path → nothing to record.
  }
  return out
}

/** Remove now-empty parent directories up to (but excluding) the project root. */
function pruneEmptyParents(projectRoot: string, fileAbs: string): void {
  const root = normalizeRoot(projectRoot)
  let dir = dirname(fileAbs)
  while (isWithin(root, dir) && dir !== root) {
    try {
      if (readdirSync(dir).length > 0) return
      rmdirSync(dir)
    } catch {
      return
    }
    dir = dirname(dir)
  }
}

export class CheckpointRepo {
  constructor(private readonly rootDir: string) {}

  private repoDirFor(projectRoot: string): string {
    return join(this.rootDir, projectKey(projectRoot), 'repo.git')
  }

  private async ensureRepo(projectRoot: string): Promise<string> {
    const root = normalizeRoot(projectRoot)
    let st
    try {
      st = statSync(root)
    } catch {
      throw new CheckpointError(`项目目录不存在：${root}`)
    }
    if (!st.isDirectory()) throw new CheckpointError(`项目路径不是目录：${root}`)

    const repoDir = this.repoDirFor(root)
    const head = join(repoDir, 'HEAD')
    if (!existsSync(head)) {
      mkdirSync(repoDir, { recursive: true })
      await runGitDir(repoDir, ['init', '--bare', '-q'])
      // Byte-exact restores: no CRLF conversion, no mode noise, no global
      // config/hooks leaking in from the user's environment.
      await runGit(root, repoDir, ['config', 'core.autocrlf', 'false'])
      await runGit(root, repoDir, ['config', 'core.safecrlf', 'false'])
      await runGit(root, repoDir, ['config', 'core.fileMode', 'false'])
      await runGit(root, repoDir, ['config', 'core.symlinks', 'true'], { allowFailure: true })
    }
    return repoDir
  }

  private async withLock<T>(projectRoot: string, fn: () => Promise<T>): Promise<T> {
    const key = projectKey(projectRoot)
    const previous = projectLocks.get(key) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(fn)
    projectLocks.set(key, current)
    try {
      return await current
    } finally {
      if (projectLocks.get(key) === current) projectLocks.delete(key)
    }
  }

  /** Snapshot the work tree (or the given paths) into the shadow repo. */
  async snapshot(projectRoot: string, opts: SnapshotOptions): Promise<SnapshotResult> {
    if (!opts.id) throw new CheckpointError('checkpoint id 不能为空')
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(opts.id)) throw new CheckpointError('checkpoint id 含有非法字符')
    const root = normalizeRoot(projectRoot)
    const targeted = (opts.paths || []).map((p) => resolve(p))
    for (const p of targeted) {
      if (!isWithin(root, p)) throw new CheckpointError(`路径在工作区外，无法快照：${p}`)
    }
    return this.withLock(root, async () => {
      const repoDir = await this.ensureRepo(root)
      const paths = targeted.length > 0 ? pathspecFor(root, targeted) : ['.', ...excludesPathspec(!!opts.includeGenerated)]
      // -f: include files ignored by the project's .gitignore; the pathspec
      // excludes above still keep generated directories out of full snapshots.
      await runGit(root, repoDir, ['add', '-A', '-f', '--', ...paths])

      const tree = (await runGit(root, repoDir, ['write-tree'])).trim()
      if (!tree) throw new CheckpointError('git write-tree 未返回树对象')
      const commit = (await runGit(root, repoDir, ['commit-tree', tree, '-m', `checkpoint ${opts.id}`])).trim()
      if (!commit) throw new CheckpointError('git commit-tree 未返回提交')
      await runGit(root, repoDir, ['update-ref', `refs/checkpoints/${opts.id}`, commit])

      let emptyDirs: string[] = []
      if (opts.collectEmptyDirs) {
        const roots = targeted.length > 0 ? targeted : [root]
        emptyDirs = roots.flatMap((p) => collectEmptyDirs(p, targeted.length > 0))
      }
      return { commit, paths: targeted, emptyDirs }
    })
  }

  /**
   * Diff a checkpoint against the current work tree. Stages the current state
   * in the shadow index first so untracked files are included; the project's
   * own index and .git are never touched.
   */
  async diff(projectRoot: string, commit: string, paths?: string[]): Promise<WorkspaceDiffEntryFs[]> {
    const root = normalizeRoot(projectRoot)
    return this.withLock(root, async () => {
      const repoDir = await this.ensureRepo(root)
      const targeted = (paths || []).map((p) => resolve(p))
      for (const p of targeted) {
        if (!isWithin(root, p)) throw new CheckpointError(`路径在工作区外：${p}`)
      }
      // Stage the whole tree once; the scope is applied to the diff pathspec
      // (a deleted directory no longer matches an add pathspec). Generated
      // dirs are normally excluded, but a scope inside one needs them staged.
      const excludes = scopeTouchesGenerated(targeted) ? [] : excludesPathspec(false)
      await runGit(root, repoDir, ['add', '-A', '-f', '--', '.', ...excludes])
      const diffSpec = targeted.length > 0 ? pathspecFor(root, targeted) : ['.']
      const out = await runGit(root, repoDir, [
        'diff', '--cached', '--name-status', '--no-renames', '-z', commit, '--', ...diffSpec,
      ], { allowFailure: true })
      return parseNameStatusZ(out).map((e) => ({
        path: hostPath(root, e.rel),
        status: e.status,
      }))
    })
  }

  /**
   * Restore the given checkpoint. Files present in the checkpoint are checked
   * out; files created after it are deleted (within the scoped paths).
   */
  async restore(
    projectRoot: string,
    commit: string,
    opts: { paths?: string[]; emptyDirs?: string[]; createdDirs?: string[]; conflicts?: string[]; includeGenerated?: boolean } = {},
  ): Promise<RestoreResultFs> {
    const root = normalizeRoot(projectRoot)
    const scope = (opts.paths || []).map((p) => resolve(p))
    const conflicts = new Set((opts.conflicts || []).map((p) => resolve(p)))
    for (const p of scope) {
      if (!isWithin(root, p)) throw new CheckpointError(`路径在工作区外，无法恢复：${p}`)
    }
    return this.withLock(root, async () => {
      const repoDir = await this.ensureRepo(root)
      const targeted = scope.length > 0 ? scope : []
      // Full staging (with generated-dir excludes) + scoped diff: a deleted
      // directory has no pathspec to stage, but the diff still reports its
      // files as deleted and checkout restores them. A generated-dir scope
      // must be staged without the excludes (see scopeTouchesGenerated).
      const excludes = (opts.includeGenerated || scopeTouchesGenerated(targeted)) ? [] : excludesPathspec(false)
      await runGit(root, repoDir, ['add', '-A', '-f', '--', '.', ...excludes])
      const diffSpec = targeted.length > 0 ? pathspecFor(root, targeted) : ['.']
      const diffOut = await runGit(root, repoDir, [
        'diff', '--cached', '--name-status', '--no-renames', '-z', commit, '--', ...diffSpec,
      ], { allowFailure: true })
      const changed = parseNameStatusZ(diffOut)

      // One ls-tree for the whole commit: much faster than one cat-file per path.
      const treeOut = await runGit(root, repoDir, ['ls-tree', '-r', '--name-only', '-z', commit], { allowFailure: true })
      const inCommit = new Set(treeOut.split('\0').filter(Boolean))

      let restored = 0
      let deleted = 0
      let skipped = 0
      const conflictHits: string[] = []

      for (const entry of changed) {
        const abs = hostPath(root, entry.rel)
        if (!isWithin(root, abs)) {
          skipped++
          continue
        }
        if (conflicts.has(abs)) {
          conflictHits.push(abs)
          skipped++
          continue
        }
        try {
          if (inCommit.has(entry.rel)) {
            await runGit(root, repoDir, ['checkout', commit, '--', `:(literal)${entry.rel}`])
            restored++
          } else {
            // Created after the checkpoint → remove it. The diff lists files,
            // not directories, so a recursive delete is safe here.
            if (existsSync(abs)) rmSync(abs, { force: true, recursive: true })
            pruneEmptyParents(root, abs)
            deleted++
          }
        } catch {
          skipped++
        }
      }

      // Empty directories that existed at snapshot time (git does not track them).
      for (const dir of opts.emptyDirs || []) {
        try {
          if (isWithin(root, dir)) mkdirSync(dir, { recursive: true })
        } catch {
          skipped++
        }
      }
      // Directories created by the operation (e.g. create_directory) — remove
      // them only when empty, so files created inside are never destroyed.
      for (const dir of opts.createdDirs || []) {
        try {
          if (isWithin(root, dir) && existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir)
        } catch {
          skipped++
        }
      }

      return { restored, deleted, skipped, conflicts: conflictHits }
    })
  }

  /** Delete a checkpoint ref (call when its metadata row is deleted). */
  async deleteRef(projectRoot: string, id: string): Promise<void> {
    const root = normalizeRoot(projectRoot)
    await this.withLock(root, async () => {
      const repoDir = await this.ensureRepo(root)
      await runGit(root, repoDir, ['update-ref', '-d', `refs/checkpoints/${id}`], { allowFailure: true })
    })
  }

  /** Best-effort repo compaction after deleting refs. */
  async gc(projectRoot: string): Promise<void> {
    const root = normalizeRoot(projectRoot)
    await this.withLock(root, async () => {
      const repoDir = await this.ensureRepo(root)
      await runGit(root, repoDir, ['reflog', 'expire', '--expire=now', '--all'], { allowFailure: true })
      await runGit(root, repoDir, ['gc', '--prune=now', '--quiet'], { allowFailure: true })
    })
  }
}

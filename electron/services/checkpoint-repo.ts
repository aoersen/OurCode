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
import { promises as fsp } from 'fs'
import type { Dirent } from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'

/** Generated directories are rebuildable; keep them out of full-tree snapshots.
 *  Anything NOT listed here is snapshotted with `-f` (so `.env`,
 *  `local.properties` and other gitignored files are still revertable) —
 *  the list must therefore only contain build output, dependency caches and
 *  IDE scratch state, never source. */
const DEFAULT_EXCLUDES = [
  '.git',
  'node_modules',
  'bower_components',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.parcel-cache',
  // Toolchains that rewrite their cache on every build. Leaving these in made
  // every snapshot diff look dirty and slowed the whole command path down.
  '.gradle',
  '.dart_tool',
  '.pub-cache',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  // IDE index state
  '.idea',
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
  gitBin = 'git',
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      gitBin,
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
function runGitDir(repoDir: string, args: string[], gitBin = 'git'): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      gitBin,
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

export interface CheckpointRepoOptions {
  /** Git executable; tests point this at a missing path to exercise the
   *  filesystem fallback. Defaults to `git` on PATH. */
  gitBin?: string
}

/** Filesystem-snapshot commit ids (used when the git binary is unavailable). */
const FS_COMMIT_PREFIX = 'fs1:'
const FS_MAX_FILES = 50_000
const FS_MAX_BYTES = 512 * 1024 * 1024
const FS_MAX_FILE_BYTES = 64 * 1024 * 1024

interface FsWalkEntry {
  abs: string
  rel: string
  kind: 'file' | 'symlink'
  size: number
  link?: string
}

function fsCommitId(commit: string): string | null {
  if (!commit.startsWith(FS_COMMIT_PREFIX)) return null
  const id = commit.slice(FS_COMMIT_PREFIX.length)
  return /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : null
}

/** Relative POSIX path from the project root (for both walkers). */
function relPosix(projectRoot: string, abs: string): string {
  return relative(projectRoot, abs).split(sep).join('/')
}

export class CheckpointRepo {
  private readonly gitBin: string
  /** null = not probed yet; false = use the filesystem fallback. */
  private gitAvailable: boolean | null = null

  constructor(
    private readonly rootDir: string,
    opts: CheckpointRepoOptions = {},
  ) {
    this.gitBin = opts.gitBin || 'git'
  }

  private git(projectRoot: string, repoDir: string, args: string[], opts?: { allowFailure?: boolean }): Promise<string> {
    return runGit(projectRoot, repoDir, args, opts, this.gitBin)
  }

  private gitDir(repoDir: string, args: string[]): Promise<string> {
    return runGitDir(repoDir, args, this.gitBin)
  }

  /** Is the git binary usable? Probed once per repo instance. A project does
   *  NOT need git: when the binary is missing we fall back to a plain
   *  filesystem snapshot under the same shadow directory. */
  private async detectGit(): Promise<boolean> {
    if (this.gitAvailable !== null) return this.gitAvailable
    this.gitAvailable = await new Promise<boolean>((resolveProbe) => {
      execFile(this.gitBin, ['--version'], { timeout: 10_000, windowsHide: true }, (error) => {
        resolveProbe(!error)
      })
    })
    return this.gitAvailable
  }

  private repoDirFor(projectRoot: string): string {
    return join(this.rootDir, projectKey(projectRoot), 'repo.git')
  }

  private fsRootFor(projectRoot: string): string {
    return join(this.rootDir, projectKey(projectRoot), 'fs')
  }

  private fsTreeFor(projectRoot: string, commit: string): string {
    const id = fsCommitId(commit)
    if (!id) throw new CheckpointError(`不是文件系统快照：${commit}`)
    return join(this.fsRootFor(projectRoot), id, 'tree')
  }

  private async ensureGitRepo(projectRoot: string): Promise<string> {
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
      await this.gitDir(repoDir, ['init', '--bare', '-q'])
      // Byte-exact restores: no CRLF conversion, no mode noise, no global
      // config/hooks leaking in from the user's environment.
      await this.git(root, repoDir, ['config', 'core.autocrlf', 'false'])
      await this.git(root, repoDir, ['config', 'core.safecrlf', 'false'])
      await this.git(root, repoDir, ['config', 'core.fileMode', 'false'])
      await this.git(root, repoDir, ['config', 'core.symlinks', 'true'], { allowFailure: true })
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
      // The project does NOT need git: the shadow repo is ours, and when the
      // git binary itself is unavailable we fall back to a plain filesystem
      // snapshot (copy + manifest-by-walk) under the same directory.
      if (!(await this.detectGit())) {
        return this.snapshotFsLocked(root, opts, targeted)
      }
      const repoDir = await this.ensureGitRepo(root)
      const paths = targeted.length > 0 ? pathspecFor(root, targeted) : ['.', ...excludesPathspec(!!opts.includeGenerated)]
      // -f: include files ignored by the project's .gitignore; the pathspec
      // excludes above still keep generated directories out of full snapshots.
      await this.git(root, repoDir, ['add', '-A', '-f', '--', ...paths])

      const tree = (await this.git(root, repoDir, ['write-tree'])).trim()
      if (!tree) throw new CheckpointError('git write-tree 未返回树对象')
      const commit = (await this.git(root, repoDir, ['commit-tree', tree, '-m', `checkpoint ${opts.id}`])).trim()
      if (!commit) throw new CheckpointError('git commit-tree 未返回提交')
      await this.git(root, repoDir, ['update-ref', `refs/checkpoints/${opts.id}`, commit])

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
      if (fsCommitId(commit)) return this.diffFsLocked(root, commit, paths)
      const repoDir = await this.ensureGitRepo(root)
      const targeted = (paths || []).map((p) => resolve(p))
      for (const p of targeted) {
        if (!isWithin(root, p)) throw new CheckpointError(`路径在工作区外：${p}`)
      }
      // Stage the whole tree once; the scope is applied to the diff pathspec
      // (a deleted directory no longer matches an add pathspec). Generated
      // dirs are normally excluded, but a scope inside one needs them staged.
      const excludes = scopeTouchesGenerated(targeted) ? [] : excludesPathspec(false)
      await this.git(root, repoDir, ['add', '-A', '-f', '--', '.', ...excludes])
      const diffSpec = targeted.length > 0 ? pathspecFor(root, targeted) : ['.']
      const out = await this.git(root, repoDir, [
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
      if (fsCommitId(commit)) return this.restoreFsLocked(root, commit, opts)
      const repoDir = await this.ensureGitRepo(root)
      const targeted = scope.length > 0 ? scope : []
      // Full staging (with generated-dir excludes) + scoped diff: a deleted
      // directory has no pathspec to stage, but the diff still reports its
      // files as deleted and checkout restores them. A generated-dir scope
      // must be staged without the excludes (see scopeTouchesGenerated).
      const excludes = (opts.includeGenerated || scopeTouchesGenerated(targeted)) ? [] : excludesPathspec(false)
      await this.git(root, repoDir, ['add', '-A', '-f', '--', '.', ...excludes])
      const diffSpec = targeted.length > 0 ? pathspecFor(root, targeted) : ['.']
      const diffOut = await this.git(root, repoDir, [
        'diff', '--cached', '--name-status', '--no-renames', '-z', commit, '--', ...diffSpec,
      ], { allowFailure: true })
      const changed = parseNameStatusZ(diffOut)

      // One ls-tree for the whole commit: much faster than one cat-file per path.
      const treeOut = await this.git(root, repoDir, ['ls-tree', '-r', '--name-only', '-z', commit], { allowFailure: true })
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
            await this.git(root, repoDir, ['checkout', commit, '--', `:(literal)${entry.rel}`])
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

  // ── Filesystem fallback (no git binary / no project git needed) ─────────

  /**
   * Walk files under `walkRoot` into a rel→entry map. `strict` is used while
   * taking a snapshot: an unreadable file must fail the snapshot instead of
   * silently disappearing (a missing snapshot entry would make a later restore
   * treat it as command-created and DELETE it). Diff walks are non-strict so a
   * locked file never aborts a restore.
   */
  private async walkFs(
    walkRoot: string,
    opts: { excludeGenerated: boolean; strict?: boolean },
    out: Map<string, FsWalkEntry>,
    relPrefix = '',
  ): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await fsp.readdir(walkRoot, { withFileTypes: true })
    } catch (error) {
      if (opts.strict) throw new CheckpointError(`无法读取目录：${walkRoot}`)
      return
    }
    for (const entry of entries) {
      const abs = join(walkRoot, entry.name)
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) {
        let link = ''
        try {
          link = await fsp.readlink(abs)
        } catch {
          if (opts.strict) throw new CheckpointError(`无法读取符号链接：${abs}`)
          continue
        }
        out.set(rel, { abs, rel, kind: 'symlink', size: 0, link })
        continue
      }
      if (entry.isDirectory()) {
        if (opts.excludeGenerated && GENERATED_DIR_NAMES.has(entry.name)) continue
        await this.walkFs(abs, opts, out, rel)
        continue
      }
      if (entry.isFile()) {
        try {
          const st = await fsp.stat(abs)
          out.set(rel, { abs, rel, kind: 'file', size: st.size })
        } catch {
          if (opts.strict) throw new CheckpointError(`无法读取文件信息：${abs}`)
        }
      }
    }
  }

  /** Collect the live side of a diff: the whole tree or the given scopes. */
  private async collectLiveFs(
    projectRoot: string,
    scope: string[] | undefined,
    excludeGenerated: boolean,
    strict = false,
  ): Promise<Map<string, FsWalkEntry>> {
    const out = new Map<string, FsWalkEntry>()
    if (scope && scope.length > 0) {
      for (const p of scope) {
        const abs = resolve(p)
        if (!isWithin(projectRoot, abs)) continue
        const rel = relPosix(projectRoot, abs)
        // Mirror the git pathspec excludes: a scope inside a generated dir is
        // not part of a full snapshot.
        if (excludeGenerated && rel.split('/').some((seg) => GENERATED_DIR_NAMES.has(seg))) continue
        let st
        try {
          st = await fsp.lstat(abs)
        } catch {
          // Missing (e.g. deleted by the operation) → the snapshot side wins.
          continue
        }
        if (st.isDirectory()) {
          await this.walkFs(abs, { excludeGenerated, strict }, out, rel)
        } else if (st.isSymbolicLink()) {
          try {
            out.set(rel, { abs, rel, kind: 'symlink', size: 0, link: await fsp.readlink(abs) })
          } catch {
            if (strict) throw new CheckpointError(`无法读取符号链接：${abs}`)
          }
        } else if (st.isFile()) {
          out.set(rel, { abs, rel, kind: 'file', size: st.size })
        }
      }
      return out
    }
    await this.walkFs(projectRoot, { excludeGenerated, strict }, out)
    return out
  }

  private async snapshotFsLocked(
    root: string,
    opts: SnapshotOptions,
    targeted: string[],
  ): Promise<SnapshotResult> {
    const fsBase = join(this.fsRootFor(root), opts.id)
    rmSync(fsBase, { recursive: true, force: true })
    const treeRoot = join(fsBase, 'tree')
    mkdirSync(treeRoot, { recursive: true })

    const entries =
      targeted.length > 0
        ? await this.collectLiveFs(root, targeted, false, true)
        : await this.collectLiveFs(root, undefined, !opts.includeGenerated, true)
    if (entries.size > FS_MAX_FILES) {
      throw new CheckpointError(`文件过多（${entries.size}），无法使用文件系统快照`)
    }
    let totalBytes = 0
    for (const entry of entries.values()) {
      if (entry.kind === 'file') {
        if (entry.size > FS_MAX_FILE_BYTES) {
          throw new CheckpointError(`文件过大，无法使用文件系统快照：${entry.rel}`)
        }
        totalBytes += entry.size
        if (totalBytes > FS_MAX_BYTES) {
          throw new CheckpointError('项目过大，无法使用文件系统快照')
        }
      }
      const dest = join(treeRoot, ...entry.rel.split('/'))
      mkdirSync(dirname(dest), { recursive: true })
      if (entry.kind === 'symlink') {
        try {
          await fsp.symlink(entry.link || '', dest)
        } catch {
          throw new CheckpointError(`无法快照符号链接：${entry.rel}`)
        }
      } else {
        await fsp.copyFile(entry.abs, dest)
      }
    }

    let emptyDirs: string[] = []
    if (opts.collectEmptyDirs) {
      const roots = targeted.length > 0 ? targeted : [root]
      emptyDirs = roots.flatMap((p) => collectEmptyDirs(p, targeted.length > 0))
    }
    return { commit: `${FS_COMMIT_PREFIX}${opts.id}`, paths: targeted, emptyDirs }
  }

  private async diffFsLocked(
    root: string,
    commit: string,
    paths?: string[],
  ): Promise<WorkspaceDiffEntryFs[]> {
    const tree = this.fsTreeFor(root, commit)
    if (!existsSync(tree)) throw new CheckpointError('快照不存在')
    const snapEntries = new Map<string, FsWalkEntry>()
    // Strict: an unreadable snapshot tree must fail the diff/restore instead of
    // making every live file look "added" (a restore would then DELETE them).
    await this.walkFs(tree, { excludeGenerated: false, strict: true }, snapEntries)

    const scope = (paths || []).map((p) => resolve(p))
    for (const p of scope) {
      if (!isWithin(root, p)) throw new CheckpointError(`路径在工作区外：${p}`)
    }
    // Same staging rule as the git path: generated dirs are excluded unless
    // the restore scope explicitly targets one (a targeted dir-delete).
    const includeGenerated = scope.length > 0 && scopeTouchesGenerated(scope)
    const liveEntries = await this.collectLiveFs(
      root,
      scope.length > 0 ? scope : undefined,
      !includeGenerated,
    )

    const out: WorkspaceDiffEntryFs[] = []
    const keys = new Set<string>([...snapEntries.keys(), ...liveEntries.keys()])
    for (const rel of keys) {
      const abs = hostPath(root, rel)
      if (scope.length > 0 && !scope.some((p) => isWithin(p, abs))) continue
      const s = snapEntries.get(rel)
      const l = liveEntries.get(rel)
      let status: WorkspaceDiffEntryFs['status'] | null = null
      if (s && l) {
        if (s.kind !== l.kind) status = 'modified'
        else if (s.kind === 'symlink') status = s.link !== l.link ? 'modified' : null
        else if (s.size !== l.size) status = 'modified'
        else {
          const snapHash = createHash('sha1').update(await fsp.readFile(s.abs)).digest('hex')
          const liveHash = createHash('sha1').update(await fsp.readFile(l.abs)).digest('hex')
          status = snapHash !== liveHash ? 'modified' : null
        }
      } else if (l) {
        status = 'added'
      } else if (s) {
        status = 'deleted'
      }
      if (status) out.push({ path: abs, status })
    }
    return out
  }

  private async copyFsEntry(snapAbs: string, destAbs: string): Promise<void> {
    const st = await fsp.lstat(snapAbs)
    await fsp.mkdir(dirname(destAbs), { recursive: true })
    try {
      const cur = await fsp.lstat(destAbs)
      if (cur.isDirectory()) await fsp.rm(destAbs, { recursive: true, force: true })
      else await fsp.unlink(destAbs)
    } catch {
      /* absent — nothing to replace */
    }
    if (st.isSymbolicLink()) {
      await fsp.symlink(await fsp.readlink(snapAbs), destAbs)
    } else {
      await fsp.copyFile(snapAbs, destAbs)
    }
  }

  private async restoreFsLocked(
    root: string,
    commit: string,
    opts: { paths?: string[]; emptyDirs?: string[]; createdDirs?: string[]; conflicts?: string[]; includeGenerated?: boolean },
  ): Promise<RestoreResultFs> {
    const tree = this.fsTreeFor(root, commit)
    const scope = (opts.paths || []).map((p) => resolve(p))
    const conflicts = new Set((opts.conflicts || []).map((p) => resolve(p)))
    for (const p of scope) {
      if (!isWithin(root, p)) throw new CheckpointError(`路径在工作区外，无法恢复：${p}`)
    }

    const diffs = await this.diffFsLocked(root, commit, opts.paths)
    let restored = 0
    let deleted = 0
    let skipped = 0
    const conflictHits: string[] = []
    for (const entry of diffs) {
      const abs = entry.path
      if (!isWithin(root, abs)) {
        skipped++
        continue
      }
      if (conflicts.has(abs)) {
        conflictHits.push(abs)
        skipped++
        continue
      }
      const rel = relPosix(root, abs)
      const snapAbs = join(tree, ...rel.split('/'))
      try {
        if (entry.status === 'added') {
          // Created after the checkpoint → remove it.
          if (existsSync(abs)) rmSync(abs, { force: true, recursive: true })
          pruneEmptyParents(root, abs)
          deleted++
        } else {
          if (!existsSync(snapAbs)) {
            skipped++
            continue
          }
          await this.copyFsEntry(snapAbs, abs)
          restored++
        }
      } catch {
        skipped++
      }
    }

    // Empty directories that existed at snapshot time (not tracked as files).
    for (const dir of opts.emptyDirs || []) {
      try {
        if (isWithin(root, dir)) mkdirSync(dir, { recursive: true })
      } catch {
        skipped++
      }
    }
    // Directories created by the operation — remove only when empty.
    for (const dir of opts.createdDirs || []) {
      try {
        if (isWithin(root, dir) && existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir)
      } catch {
        skipped++
      }
    }

    return { restored, deleted, skipped, conflicts: conflictHits }
  }

  /** Delete a checkpoint ref (call when its metadata row is deleted). */
  async deleteRef(projectRoot: string, id: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return
    const root = normalizeRoot(projectRoot)
    await this.withLock(root, async () => {
      // Filesystem fallback snapshot (if any).
      try {
        rmSync(join(this.fsRootFor(root), id), { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
      // Git ref (if a shadow repo exists). Never create a repo just to delete.
      const repoDir = this.repoDirFor(root)
      if (!existsSync(join(repoDir, 'HEAD'))) return
      if (!(await this.detectGit())) return
      try {
        await this.git(root, repoDir, ['update-ref', '-d', `refs/checkpoints/${id}`], { allowFailure: true })
      } catch {
        /* project may be gone; the ref is only disk */
      }
    })
  }

  /** Best-effort repo compaction after deleting refs. */
  async gc(projectRoot: string): Promise<void> {
    const root = normalizeRoot(projectRoot)
    await this.withLock(root, async () => {
      if (!(await this.detectGit())) return
      const repoDir = this.repoDirFor(root)
      if (!existsSync(join(repoDir, 'HEAD'))) return
      try {
        await this.git(root, repoDir, ['reflog', 'expire', '--expire=now', '--all'], { allowFailure: true })
        await this.git(root, repoDir, ['gc', '--prune=now', '--quiet'], { allowFailure: true })
      } catch {
        /* best-effort */
      }
    })
  }
}

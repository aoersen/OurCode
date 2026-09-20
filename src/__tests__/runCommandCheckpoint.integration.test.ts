/**
 * runCommandCheckpoint integration tests — drive the REAL git binary against
 * a temp repository, mocking only window.electronAPI with a thin adapter over
 * the same git + real fs. This pins the porcelain -z parsing, the
 * `git show HEAD:<path>` round-trip and the rename synthesis against actual
 * git output (unit tests use synthetic strings, which can silently drift).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

const execFileP = promisify(execFile)

let repo = ''
const captured: any[] = []

async function git(args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout } = await execFileP('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 })
    return { ok: true, output: stdout as string }
  } catch (error: any) {
    return { ok: false, output: String(error?.stderr || error?.message || '') }
  }
}

beforeAll(async () => {
  repo = await fs.mkdtemp(join(tmpdir(), 'rcc-int-'))
  const version = await git(['--version'], repo)
  if (!version.ok) return // git unavailable — the tests below skip via repo === ''
  await git(['init', '-q'], repo)
  await git(['config', 'user.email', 't@example.com'], repo)
  await git(['config', 'user.name', 't'], repo)
  await git(['config', 'core.autocrlf', 'false'], repo)
  await fs.mkdir(join(repo, 'sub'))
  await fs.writeFile(join(repo, 'a.txt'), 'base-a\n')
  await fs.writeFile(join(repo, 'sub', 'b.txt'), 'base-b\n')
  await git(['add', '-A'], repo)
  await git(['commit', '-q', '-m', 'init'], repo)

  vi.stubGlobal('window', {
    electronAPI: {
      gitExec: async (cwd: string, args: string[]) => {
        const r = await git(args, cwd)
        return r.ok ? { success: true, output: r.output.trimEnd() } : { success: false, output: '', error: r.output }
      },
      gitExecRaw: async (cwd: string, args: string[]) => {
        const r = await git(args, cwd)
        return r.ok ? { success: true, output: r.output } : { success: false, output: '', error: r.output }
      },
      stat: async (p: string) => {
        try {
          const st = await fs.stat(p)
          return { size: st.size, isFile: st.isFile(), isDirectory: st.isDirectory(), createdAt: 0, modifiedAt: 0 }
        } catch {
          return null
        }
      },
      readFile: async (p: string) => {
        const content = await fs.readFile(p, 'utf8')
        return { content, encoding: 'utf-8', hasBom: false }
      },
      checkpointCreate: async (cp: any) => {
        captured.push(cp)
      },
    },
  })
})

afterAll(async () => {
  if (repo) await fs.rm(repo, { recursive: true, force: true })
})

beforeEach(async () => {
  captured.length = 0
  if (repo) {
    await git(['reset', '--hard', '-q', 'HEAD'], repo)
    await git(['clean', '-qfd'], repo)
  }
})

/** Module import is deferred so the window stub above is in place first. */
async function loadModule() {
  return import('@/services/runCommandCheckpoint')
}

function findByPath(cp: any, path: string) {
  const want = path.replace(/\\/g, '/')
  return cp?.files?.find((f: any) => String(f.path).replace(/\\/g, '/').endsWith(want))
}

describe('runCommandCheckpoint against real git', () => {
  it('captures command-modified tracked files (modified / deleted / created)', async () => {
    const { captureRunPreState, buildRunCommandCheckpoint } = await loadModule()
    const pre = await captureRunPreState(repo)
    expect(pre).not.toBeNull()
    expect(pre!.dirty.size).toBe(0)

    // The "command": modify, create, delete.
    await fs.writeFile(join(repo, 'a.txt'), 'changed-a\n')
    await fs.writeFile(join(repo, 'c.txt'), 'new-c\n')
    await fs.rm(join(repo, 'sub', 'b.txt'))

    const cp = await buildRunCommandCheckpoint(pre!, 'fmt', 's1', 'm1')
    expect(cp).not.toBeNull()
    expect(cp!.files).toHaveLength(3)
    expect(findByPath(cp, 'a.txt')).toEqual({ path: join(repo, 'a.txt'), content: 'base-a\n', existed: true })
    expect(findByPath(cp, 'c.txt')).toEqual({ path: join(repo, 'c.txt'), content: '', existed: false })
    expect(findByPath(cp, 'sub/b.txt')).toEqual({ path: join(repo, 'sub', 'b.txt'), content: 'base-b\n', existed: true })
    expect(captured).toHaveLength(1)
  })

  it('uses the pre-command capture for files that were already dirty', async () => {
    const { captureRunPreState, buildRunCommandCheckpoint } = await loadModule()
    await fs.writeFile(join(repo, 'a.txt'), 'dirty\n')
    const pre = await captureRunPreState(repo)
    expect(pre!.dirty.get('a.txt')?.content).toBe('dirty\n')

    await fs.writeFile(join(repo, 'a.txt'), 'changed-again\n')
    const cp = await buildRunCommandCheckpoint(pre!, 'fmt', 's1', 'm1')
    expect(findByPath(cp, 'a.txt')).toEqual({ path: join(repo, 'a.txt'), content: 'dirty\n', existed: true })
  })

  it('returns null when the command changed nothing', async () => {
    const { captureRunPreState, buildRunCommandCheckpoint } = await loadModule()
    const pre = await captureRunPreState(repo)
    const cp = await buildRunCommandCheckpoint(pre!, 'noop', 's1', 'm1')
    expect(cp).toBeNull()
    expect(captured).toHaveLength(0)
  })

  it('returns null outside a git repository', async () => {
    const { captureRunPreState } = await loadModule()
    const outside = await fs.mkdtemp(join(tmpdir(), 'rcc-nonrepo-'))
    try {
      expect(await captureRunPreState(outside)).toBeNull()
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('a rename done by the command reverts to the old path (no data loss)', async () => {
    const { captureRunPreState, buildRunCommandCheckpoint } = await loadModule()
    const pre = await captureRunPreState(repo)
    await git(['mv', 'a.txt', 'd.txt'], repo)

    const cp = await buildRunCommandCheckpoint(pre!, 'git mv', 's1', 'm1')
    expect(cp).not.toBeNull()
    // Old path restored from HEAD; new path treated as command-created.
    expect(findByPath(cp, 'a.txt')).toEqual({ path: join(repo, 'a.txt'), content: 'base-a\n', existed: true })
    expect(findByPath(cp, 'd.txt')).toEqual({ path: join(repo, 'd.txt'), content: '', existed: false })
  })

  it('a rename that predates the command produces no spurious checkpoint', async () => {
    const { captureRunPreState, buildRunCommandCheckpoint } = await loadModule()
    await git(['mv', 'a.txt', 'd.txt'], repo)
    const pre = await captureRunPreState(repo)
    // Pre-state saw the rename (new path captured, old path recorded deleted).
    expect(pre!.dirty.get('a.txt')?.existed).toBe(false)
    expect(pre!.dirty.get('d.txt')?.content).toBe('base-a\n')

    const cp = await buildRunCommandCheckpoint(pre!, 'noop', 's1', 'm1')
    expect(cp).toBeNull()
    expect(captured).toHaveLength(0)
  })

  it('a staged copy reverts by deleting the copy, never the original', async () => {
    const { captureRunPreState, buildRunCommandCheckpoint } = await loadModule()
    const pre = await captureRunPreState(repo)
    // The "command": copy a tracked file and stage it (porcelain 'C ').
    await fs.copyFile(join(repo, 'a.txt'), join(repo, 'a-copy.txt'))
    await git(['add', 'a-copy.txt'], repo)

    const cp = await buildRunCommandCheckpoint(pre!, 'cp + git add', 's1', 'm1')
    expect(cp).not.toBeNull()
    // Reverting deletes the copy; the original a.txt must NOT be in the
    // checkpoint (deleting it would be data loss).
    expect(findByPath(cp, 'a-copy.txt')).toEqual({ path: join(repo, 'a-copy.txt'), content: '', existed: false })
    expect(findByPath(cp, 'a.txt')).toBeUndefined()
  })

  it('handles paths with spaces', async () => {
    const { captureRunPreState, buildRunCommandCheckpoint } = await loadModule()
    const pre = await captureRunPreState(repo)
    await fs.writeFile(join(repo, 'my spaced file.txt'), 'spaced\n')
    await git(['add', 'my spaced file.txt'], repo)
    await git(['commit', '-q', '-m', 'spaced'], repo)

    // Now dirty it again via the "command".
    await fs.writeFile(join(repo, 'my spaced file.txt'), 'spaced2\n')
    const cp = await buildRunCommandCheckpoint(pre!, 'touch', 's1', 'm1')
    expect(findByPath(cp, 'my spaced file.txt')?.content).toBe('spaced\n')
  })
})

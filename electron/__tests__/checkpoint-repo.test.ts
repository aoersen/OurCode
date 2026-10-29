import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CheckpointRepo } from '../services/checkpoint-repo'

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf-8')
}

describe('CheckpointRepo (shadow git)', () => {
  let base: string
  let project: string
  let repo: CheckpointRepo

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'ourcode-cp-'))
    project = join(base, 'project')
    mkdirSync(project, { recursive: true })
    repo = new CheckpointRepo(join(base, 'checkpoints'))
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('snapshots and restores a non-git project without touching the project .git', async () => {
    write(join(project, 'src', 'a.txt'), 'hello')
    write(join(project, 'src', 'sub', 'b.txt'), 'world')
    write(join(project, '.env'), 'SECRET=1')

    const snap = await repo.snapshot(project, { id: 'cp1' })
    expect(snap.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(existsSync(join(project, '.git'))).toBe(false)

    // Command-style side effects: modify, delete, create.
    writeFileSync(join(project, 'src', 'a.txt'), 'changed', 'utf-8')
    rmSync(join(project, 'src', 'sub'), { recursive: true, force: true })
    writeFileSync(join(project, 'new.txt'), 'created', 'utf-8')

    const diff = await repo.diff(project, snap.commit)
    const byPath = new Map(diff.map((d) => [d.path.replace(/\\/g, '/'), d.status]))
    expect(byPath.get(`${project.replace(/\\/g, '/')}/src/a.txt`)).toBe('modified')
    expect(byPath.get(`${project.replace(/\\/g, '/')}/src/sub/b.txt`)).toBe('deleted')
    expect(byPath.get(`${project.replace(/\\/g, '/')}/new.txt`)).toBe('added')

    const result = await repo.restore(project, snap.commit)
    expect(result.skipped).toBe(0)
    expect(readFileSync(join(project, 'src', 'a.txt'), 'utf-8')).toBe('hello')
    expect(readFileSync(join(project, 'src', 'sub', 'b.txt'), 'utf-8')).toBe('world')
    expect(existsSync(join(project, 'new.txt'))).toBe(false)
    expect(readFileSync(join(project, '.env'), 'utf-8')).toBe('SECRET=1')
  })

  it('restores a deleted directory including empty subdirectories', async () => {
    mkdirSync(join(project, 'legacy', 'empty'), { recursive: true })
    write(join(project, 'legacy', 'a.txt'), 'a')
    write(join(project, 'legacy', 'sub', 'b.txt'), 'b')

    const snap = await repo.snapshot(project, {
      id: 'cp-dir',
      paths: [join(project, 'legacy')],
      collectEmptyDirs: true,
    })
    expect(snap.emptyDirs.map((p) => p.replace(/\\/g, '/')).some((p) => p.endsWith('/legacy/empty'))).toBe(true)

    rmSync(join(project, 'legacy'), { recursive: true, force: true })
    const result = await repo.restore(project, snap.commit, {
      paths: [join(project, 'legacy')],
      emptyDirs: snap.emptyDirs,
    })
    expect(result.skipped).toBe(0)
    expect(readFileSync(join(project, 'legacy', 'a.txt'), 'utf-8')).toBe('a')
    expect(readFileSync(join(project, 'legacy', 'sub', 'b.txt'), 'utf-8')).toBe('b')
    expect(existsSync(join(project, 'legacy', 'empty'))).toBe(true)
  })

  it('keeps generated directories out of full snapshots but restores source files', async () => {
    write(join(project, 'src', 'main.ts'), 'src')
    write(join(project, 'node_modules', 'pkg', 'index.js'), 'pkg')

    const snap = await repo.snapshot(project, { id: 'cp-gen' })
    rmSync(join(project, 'src'), { recursive: true, force: true })
    rmSync(join(project, 'node_modules'), { recursive: true, force: true })

    await repo.restore(project, snap.commit)
    expect(readFileSync(join(project, 'src', 'main.ts'), 'utf-8')).toBe('src')
    // Generated dirs are excluded from full snapshots by design (rebuildable).
    expect(existsSync(join(project, 'node_modules'))).toBe(false)
  })

  it('restores a targeted generated-directory delete', async () => {
    write(join(project, 'node_modules', 'pkg', 'index.js'), 'pkg')
    const snap = await repo.snapshot(project, {
      id: 'cp-nm',
      paths: [join(project, 'node_modules')],
      collectEmptyDirs: true,
    })
    rmSync(join(project, 'node_modules'), { recursive: true, force: true })
    const result = await repo.restore(project, snap.commit, {
      paths: [join(project, 'node_modules')],
      emptyDirs: snap.emptyDirs,
    })
    expect(result.skipped).toBe(0)
    expect(readFileSync(join(project, 'node_modules', 'pkg', 'index.js'), 'utf-8')).toBe('pkg')
  })

  it('restores a specific file scope without touching sibling changes', async () => {
    write(join(project, 'src', 'a.txt'), 'a0')
    write(join(project, 'src', 'b.txt'), 'b0')
    const snap = await repo.snapshot(project, { id: 'cp-file' })

    writeFileSync(join(project, 'src', 'a.txt'), 'a1', 'utf-8')
    writeFileSync(join(project, 'src', 'b.txt'), 'b1', 'utf-8')

    await repo.restore(project, snap.commit, { paths: [join(project, 'src', 'a.txt')] })
    expect(readFileSync(join(project, 'src', 'a.txt'), 'utf-8')).toBe('a0')
    expect(readFileSync(join(project, 'src', 'b.txt'), 'utf-8')).toBe('b1')
  })

  it('serializes concurrent snapshots on the same project', async () => {
    write(join(project, 'a.txt'), 'a')
    const [s1, s2] = await Promise.all([
      repo.snapshot(project, { id: 'cp-a' }),
      repo.snapshot(project, { id: 'cp-b' }),
    ])
    expect(s1.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(s2.commit).toMatch(/^[0-9a-f]{40}$/)
  })
})

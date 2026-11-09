import { describe, it, expect } from 'vitest'
import {
  ARTIFACT_TABS,
  BROWSER_ARTIFACT,
  MAX_FILE_ARTIFACTS,
  PLAN_ARTIFACT,
  baseName,
  deriveArtifacts,
  deriveFileArtifacts,
  fileArtifact,
  filterArtifactCandidates,
  relativePathOf,
  shouldShowArtifactStrip,
  tabForNavKey,
  tabIndexOf,
  upsertArtifact,
} from '@/shell/agent/artifact/artifactModel'

describe('artifactModel · baseName', () => {
  it('takes the last segment for both separators', () => {
    expect(baseName('E:\\proj\\src\\ArtifactPanel.tsx')).toBe('ArtifactPanel.tsx')
    expect(baseName('/home/me/proj/README.md')).toBe('README.md')
    expect(baseName('README.md')).toBe('README.md')
  })

  it('handles trailing separators and empty input', () => {
    expect(baseName('E:\\proj\\src\\')).toBe('src')
    expect(baseName('')).toBe('')
  })
})

describe('artifactModel · tabs', () => {
  it('exposes the four typographic tabs in order', () => {
    expect(ARTIFACT_TABS.map((tab) => tab.id)).toEqual(['plan', 'changes', 'file', 'browser'])
    expect(ARTIFACT_TABS.map((tab) => tab.label)).toEqual(['计划', '变更', '文件', '浏览器'])
  })

  it('wraps with arrow keys and jumps with Home/End', () => {
    expect(tabForNavKey('plan', 'ArrowLeft')).toBe('browser')
    expect(tabForNavKey('browser', 'ArrowRight')).toBe('plan')
    expect(tabForNavKey('changes', 'ArrowRight')).toBe('file')
    expect(tabForNavKey('file', 'ArrowDown')).toBe('browser')
    expect(tabForNavKey('file', 'ArrowUp')).toBe('changes')
    expect(tabForNavKey('browser', 'Home')).toBe('plan')
    expect(tabForNavKey('plan', 'End')).toBe('browser')
  })

  it('ignores non-navigation keys', () => {
    expect(tabForNavKey('plan', 'Enter')).toBeNull()
    expect(tabForNavKey('plan', 'Escape')).toBeNull()
  })

  it('falls back to the first index for unknown tabs', () => {
    // @ts-expect-error — runtime guard for a stale persisted tab id
    expect(tabIndexOf('nope')).toBe(0)
    expect(tabIndexOf('changes')).toBe(1)
  })
})

describe('artifactModel · deriveFileArtifacts', () => {
  const files = (...paths: string[]) => paths.map((path) => ({ path }))

  it('puts the active file first, then most-recently opened', () => {
    const entries = deriveFileArtifacts(files('a.ts', 'b.ts', 'c.ts'), 'b.ts')
    expect(entries.map((entry) => entry.label)).toEqual(['b.ts', 'c.ts', 'a.ts'])
    expect(entries[0].key).toBe('file:b.ts')
    expect(entries[0].tab).toBe('file')
  })

  it('skips untitled buffers and duplicates', () => {
    const entries = deriveFileArtifacts(files('/untitled/untitled-1.txt', 'a.ts', 'a.ts'), 'a.ts')
    expect(entries.map((entry) => entry.path)).toEqual(['a.ts'])
  })

  it('caps the list at six files', () => {
    const many = files('1.ts', '2.ts', '3.ts', '4.ts', '5.ts', '6.ts', '7.ts', '8.ts')
    const entries = deriveFileArtifacts(many, null)
    expect(entries).toHaveLength(MAX_FILE_ARTIFACTS)
    expect(entries[0].path).toBe('8.ts')
  })

  it('survives a null active file', () => {
    expect(deriveFileArtifacts([], null)).toEqual([])
  })
})

describe('artifactModel · list assembly', () => {
  it('adds 计划 only when the session has a plan, and always lists 浏览器', () => {
    expect(deriveArtifacts(null, [])).toEqual([BROWSER_ARTIFACT])
    expect(deriveArtifacts({}, [])).toEqual([BROWSER_ARTIFACT])
    expect(deriveArtifacts({ planContent: '# 计划' }, [])).toEqual([PLAN_ARTIFACT, BROWSER_ARTIFACT])
  })

  it('shows the artifact strip once more than one artifact is open', () => {
    expect(shouldShowArtifactStrip([])).toBe(false)
    expect(shouldShowArtifactStrip([BROWSER_ARTIFACT])).toBe(false)
    expect(shouldShowArtifactStrip([BROWSER_ARTIFACT, fileArtifact('a.ts')])).toBe(true)
    expect(shouldShowArtifactStrip(deriveArtifacts({ planContent: 'x' }, []))).toBe(true)
    expect(shouldShowArtifactStrip(deriveArtifacts(null, [fileArtifact('a.ts'), fileArtifact('b.ts')]))).toBe(true)
  })

  it('moves a selected file to the front of the file group and dedupes', () => {
    const list = [BROWSER_ARTIFACT, fileArtifact('a.ts'), fileArtifact('b.ts')]
    const next = upsertArtifact(list, fileArtifact('b.ts'))
    expect(next.map((entry) => entry.key)).toEqual(['browser', 'file:b.ts', 'file:a.ts'])
  })

  it('keeps file entries capped when upserting a new file', () => {
    let list = [BROWSER_ARTIFACT]
    for (let i = 0; i < 9; i++) list = upsertArtifact(list, fileArtifact(`${i}.ts`))
    expect(list.filter((entry) => entry.kind === 'file')).toHaveLength(MAX_FILE_ARTIFACTS)
    expect(list[0].kind).toBe('browser')
  })

  it('puts non-file entries in front', () => {
    const next = upsertArtifact([fileArtifact('a.ts')], PLAN_ARTIFACT)
    expect(next.map((entry) => entry.key)).toEqual(['plan', 'file:a.ts'])
  })
})

describe('artifactModel · relativePathOf', () => {
  it('returns the project-relative path (both slash styles)', () => {
    expect(relativePathOf('E:\\proj\\src\\a.ts', 'E:\\proj')).toBe('src/a.ts')
    expect(relativePathOf('/home/me/proj/src/a.ts', '/home/me/proj/')).toBe('src/a.ts')
  })

  it('is case-insensitive on the root (Windows drive/dir casing)', () => {
    expect(relativePathOf('e:/proj/src/a.ts', 'E:\\proj')).toBe('src/a.ts')
  })

  it('returns null outside the root or without a root', () => {
    expect(relativePathOf('E:\\other\\a.ts', 'E:\\proj')).toBeNull()
    expect(relativePathOf('E:\\proj\\a.ts', null)).toBeNull()
    expect(relativePathOf('', 'E:\\proj')).toBeNull()
  })

  it('returns an empty string for the root itself', () => {
    expect(relativePathOf('E:\\proj', 'E:\\proj')).toBe('')
  })
})

describe('artifactModel · filterArtifactCandidates', () => {
  const paths = [
    'E:\\proj\\src\\shell\\agent\\ArtifactPanel.tsx',
    'E:\\proj\\src\\components\\Editor\\DiffView.tsx',
    '/untitled/untitled-1.txt',
    'E:\\proj\\README.md',
    'E:\\proj\\src\\shell\\agent\\ArtifactPanel.tsx',
  ]

  it('dedupes, drops untitled buffers and keeps input order for an empty query', () => {
    expect(filterArtifactCandidates(paths, '')).toEqual([
      'E:\\proj\\src\\shell\\agent\\ArtifactPanel.tsx',
      'E:\\proj\\src\\components\\Editor\\DiffView.tsx',
      'E:\\proj\\README.md',
    ])
  })

  it('ranks file-name matches above path matches', () => {
    const result = filterArtifactCandidates(paths, 'diff')
    expect(result[0]).toBe('E:\\proj\\src\\components\\Editor\\DiffView.tsx')
  })

  it('matches by subsequence as a last resort and respects max', () => {
    expect(filterArtifactCandidates(paths, 'artpantsx')).toEqual(['E:\\proj\\src\\shell\\agent\\ArtifactPanel.tsx'])
    expect(filterArtifactCandidates(paths, '', 1)).toHaveLength(1)
  })

  it('returns nothing when there is no match', () => {
    expect(filterArtifactCandidates(paths, 'zzz-nothing')).toEqual([])
  })
})

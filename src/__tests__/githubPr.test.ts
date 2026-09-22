import { describe, it, expect } from 'vitest'
import {
  buildPrBody,
  buildPrCreateArgs,
  formatPullRequestForModel,
  parseGhJson,
  summarizeChecks,
  toPullRequestDetail,
  toPullRequestSummaries,
} from '@/services/github'

describe('parseGhJson', () => {
  it('parses clean output', () => {
    expect(parseGhJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 })
  })

  it('recovers when gh prints a warning above the payload', () => {
    const raw = 'warn: something about token scopes\n{"number":7,"title":"x"}'
    expect(parseGhJson<{ number: number }>(raw)).toEqual({ number: 7, title: 'x' })
  })

  it('returns null for non-JSON instead of throwing', () => {
    expect(parseGhJson('not json at all')).toBeNull()
    expect(parseGhJson('')).toBeNull()
  })
})

describe('buildPrCreateArgs', () => {
  it('always passes title and body explicitly (gh would otherwise prompt)', () => {
    expect(buildPrCreateArgs({ title: 'T', body: 'B' })).toEqual(['pr', 'create', '--title', 'T', '--body', 'B'])
  })

  it('adds base/head/draft only when given', () => {
    expect(buildPrCreateArgs({ title: 'T', body: '', base: 'develop', draft: true })).toEqual([
      'pr', 'create', '--title', 'T', '--body', '', '--base', 'develop', '--draft',
    ])
  })
})

describe('summarizeChecks', () => {
  it('handles the flat array shape', () => {
    const out = summarizeChecks([{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }])
    expect(out).toEqual([{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }])
  })

  it('flattens the grouped shape gh returns for commit statuses', () => {
    const out = summarizeChecks([
      [{ context: 'ci/lint', state: 'SUCCESS' }],
      [{ name: 'test', status: 'IN_PROGRESS' }],
    ])
    expect(out).toEqual([
      { name: 'ci/lint', status: '', conclusion: 'SUCCESS' },
      { name: 'test', status: 'IN_PROGRESS', conclusion: '' },
    ])
  })

  it('tolerates junk', () => {
    expect(summarizeChecks(null)).toEqual([])
    expect(summarizeChecks(['nope', 3])).toEqual([])
  })
})

describe('toPullRequestDetail', () => {
  const raw = {
    number: 12,
    title: 'Add PR workflow',
    state: 'OPEN',
    isDraft: false,
    url: 'https://github.com/o/r/pull/12',
    headRefName: 'feat/pr',
    baseRefName: 'main',
    author: { login: 'octocat' },
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }],
    comments: [{ author: { login: 'reviewer' }, body: 'please rebase', createdAt: '2026-09-20T00:00:00Z' }],
    reviews: [
      {
        author: { login: 'lead' },
        submittedAt: '2026-09-20T01:00:00Z',
        comments: [{ body: 'missing null check', path: 'src/a.ts', line: 42 }],
      },
    ],
  }

  it('maps gh fields onto the UI shape', () => {
    const detail = toPullRequestDetail(raw)
    expect(detail.number).toBe(12)
    expect(detail.author).toBe('octocat')
    expect(detail.checks).toEqual([{ name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }])
    expect(detail.mergeable).toBe('MERGEABLE')
  })

  it('merges issue comments and inline review comments, tagging the inline ones', () => {
    const { comments } = toPullRequestDetail(raw)
    expect(comments).toHaveLength(2)
    expect(comments[0]).toMatchObject({ author: 'reviewer', kind: 'issue' })
    expect(comments[1]).toMatchObject({ author: 'lead', kind: 'review', path: 'src/a.ts', line: 42 })
  })

  it('survives a minimal payload', () => {
    const detail = toPullRequestDetail({ number: '7' })
    expect(detail.number).toBe(7)
    expect(detail.checks).toEqual([])
    expect(detail.comments).toEqual([])
    expect(detail.mergeable).toBeUndefined()
  })
})

describe('toPullRequestSummaries', () => {
  it('returns [] for a non-array payload', () => {
    expect(toPullRequestSummaries({})).toEqual([])
    expect(toPullRequestSummaries(null)).toEqual([])
  })
})

describe('buildPrBody', () => {
  it('lists the branch commits and appends the diffstat', () => {
    const body = buildPrBody(['feat: a', 'fix: b'], ' 2 files changed')
    expect(body).toContain('- feat: a')
    expect(body).toContain('- fix: b')
    expect(body).toContain(' 2 files changed')
  })

  it('says so when there are no commits', () => {
    expect(buildPrBody([], '')).toContain('(无提交)')
  })
})

describe('formatPullRequestForModel', () => {
  it('includes number, state, checks and comments so the agent can act on it', () => {
    const text = formatPullRequestForModel(toPullRequestDetail({
      number: 12,
      title: 'T',
      state: 'OPEN',
      url: 'u',
      headRefName: 'h',
      baseRefName: 'main',
      statusCheckRollup: [{ name: 'build', conclusion: 'FAILURE' }],
      comments: [{ author: { login: 'bot' }, body: 'lint failed' }],
    }))
    expect(text).toContain('#12 T')
    expect(text).toContain('h → main')
    expect(text).toContain('build: FAILURE')
    expect(text).toContain('bot: lint failed')
  })
})

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  parseAgentFrontmatter,
  loadAgentDefinition,
  SubagentGuard,
  CONTROL_TOOLS,
  isPathWithin,
  resolveAllowedRoot,
} from '@/services/subagents/subagentDefinitions'

describe('parseAgentFrontmatter', () => {
  it('parses scalar and array fields from frontmatter', () => {
    const content = [
      '---',
      'name: reviewer',
      'description: 审查员',
      'tools: [read_file, list_directory, web_search]',
      'allowedPaths: src, tests',
      'maxIterations: 5',
      'maxTokensBudget: 10000',
      'temperature: 0.3',
      'model: gpt-4o',
      '---',
      '你是审查员',
    ].join('\n')
    const parsed = parseAgentFrontmatter(content, 'fallback')
    expect(parsed.name).toBe('reviewer')
    expect(parsed.description).toBe('审查员')
    expect(parsed.systemPrompt).toBe('你是审查员')
    expect(parsed.frontmatter.tools).toBe('[read_file, list_directory, web_search]')
    expect(parsed.frontmatter.allowedpaths).toBe('src, tests')
    expect(parsed.frontmatter.maxiterations).toBe('5')
  })

  it('falls back to the file name and tolerates missing frontmatter', () => {
    const parsed = parseAgentFrontmatter('只有正文，没有前matter', 'code-reviewer')
    expect(parsed.name).toBe('code-reviewer')
    expect(parsed.systemPrompt).toBe('只有正文，没有前matter')
  })
})

describe('loadAgentDefinition', () => {
  const root = 'C:/workspace'
  const agentFile = `${root}/.ourcode/agents/code-reviewer.md`
  const testerFile = `${root}/.ourcode/agents/tm-tester.md`

  const mockApi = {
    listDir: vi.fn(async (dir: string) => {
      if (dir === `${root}/.ourcode/agents`) {
        return [{ name: 'code-reviewer.md', isDirectory: false, isHidden: false },
                { name: 'tm-tester.md', isDirectory: false, isHidden: false }]
      }
      if (dir === 'C:/userData/agents') return []
      return []
    }),
    readFile: vi.fn(async (path: string) => {
      const files: Record<string, string> = {
        [agentFile]: [
          '---',
          'name: workspace-reviewer',
          'description: 工作区审查员',
          'tools: [read_file]',
          'allowedPaths: [src]',
          'maxIterations: 4',
          '---',
          '只读审查。',
        ].join('\n'),
        [testerFile]: [
          '---',
          'name: tm-tester',
          'description: 测试',
          'tools: [read_file, write_file, run_command]',
          'allowedWritePaths: [.ourcode/targemode, tests]',
          'maxIterations: 6',
          '---',
          '独立验证。',
        ].join('\n'),
      }
      return { content: files[path] || '', encoding: 'utf-8' }
    }),
    stat: vi.fn(async () => ({ size: 1, isFile: true, isDirectory: false, createdAt: 1, modifiedAt: 1000 })),
    getPath: vi.fn(async () => 'C:/userData'),
  }

  beforeEach(() => {
    vi.stubGlobal('window', { electronAPI: mockApi })
    vi.resetModules()
  })

  it('loads a workspace definition file, parsing frontmatter into fields', async () => {
    const def = await loadAgentDefinition('code-reviewer', root)
    expect(def.source).toBe('workspace')
    expect(def.name).toBe('workspace-reviewer')
    expect(def.systemPrompt).toBe('只读审查。')
    expect(def.tools).toEqual(['read_file'])
    expect(def.allowedPaths).toEqual(['src'])
    expect(def.maxIterations).toBe(4)
    expect(def.path).toBe(agentFile)
  })

  it('falls back to a built-in archetype when no file matches', async () => {
    const def = await loadAgentDefinition('code-reviewer', 'C:/other-root')
    expect(def.source).toBe('builtin')
    expect(def.tools).not.toContain('write_file')
    expect(def.tools).toContain('read_file')
  })

  it('falls back to a generic definition for unknown names (never throws)', async () => {
    const def = await loadAgentDefinition('ghost-agent', 'C:/other-root')
    expect(def.source).toBe('builtin')
    expect(def.name).toBe('ghost-agent')
    expect(def.systemPrompt).toContain('ghost-agent')
    expect(def.tools).toBeUndefined()
  })

  it('parses allowedWritePaths from frontmatter (target-mode roles)', async () => {
    const def = await loadAgentDefinition('tm-tester', root)
    expect(def.source).toBe('workspace')
    expect(def.allowedWritePaths).toEqual(['.ourcode/targemode', 'tests'])
    expect(def.allowedReadPaths).toBeUndefined()
  })

  it('provides target-mode strong-boundary builtins as no-config fallback', async () => {
    const ra = await loadAgentDefinition('requirement-analyst', 'C:/other-root')
    expect(ra.source).toBe('builtin')
    expect(ra.allowedWritePaths).toEqual(['.ourcode/targemode'])
    expect(ra.tools).toContain('read_file')
    expect(ra.tools).not.toContain('delete_file')

    const tester = await loadAgentDefinition('tester', 'C:/other-root')
    expect(tester.allowedWritePaths).toBeDefined()
    expect(tester.tools).toContain('run_command')
    expect(tester.tools).not.toContain('submit_plan')
  })

  it('tm-* workspace names fall back to the strong boundary, not the generic definition', async () => {
    // The supervisor spawns tm-* roles (SPEC ch.9). If the editable .md is
    // deleted, the tm-* builtin alias must keep the write restriction —
    // never the unrestricted generic fallback.
    const tmTester = await loadAgentDefinition('tm-tester', 'C:/other-root')
    expect(tmTester.source).toBe('builtin')
    expect(tmTester.allowedWritePaths).toBeDefined()
    expect(tmTester.tools).toContain('run_command')

    const tmRa = await loadAgentDefinition('tm-requirement-analyst', 'C:/other-root')
    expect(tmRa.allowedWritePaths).toEqual(['.ourcode/targemode'])
    expect(tmRa.tools).not.toContain('delete_file')
  })
})

describe('SubagentGuard — permission isolation', () => {
  const base = (over: Partial<Parameters<typeof makeGuard>[0]> = {}) => makeGuard(over)

  function makeGuard(defOverrides: Record<string, any>) {
    const def = {
      name: 'reviewer',
      description: '',
      systemPrompt: 'x',
      tools: ['read_file', 'list_directory', 'run_command', 'mcp__git__git_status'],
      allowedPaths: ['src', 'tests'],
      blockedCommands: ['rm -rf'],
      source: 'builtin' as const,
      ...defOverrides,
    }
    return new SubagentGuard(def, 'C:/workspace')
  }

  it('always blocks control tools, even with no allowlist', () => {
    const guard = base({ tools: undefined })
    for (const t of CONTROL_TOOLS) {
      expect(guard.toolAllowed(t)).toBe(false)
      expect(guard.checkCall(t, {})).toBeTruthy()
    }
  })

  it('with no allowlist, non-control tools are allowed', () => {
    const guard = base({ tools: undefined })
    expect(guard.toolAllowed('write_file')).toBe(true)
    expect(guard.toolAllowed('run_command')).toBe(true)
  })

  it('blocks tools outside the allowlist; allows listed ones', () => {
    const guard = base()
    expect(guard.toolAllowed('read_file')).toBe(true)
    expect(guard.toolAllowed('write_file')).toBe(false)
    expect(guard.checkCall('write_file', { path: 'C:/workspace/src/a.ts' })).toContain('白名单')
  })

  it('always allows skill__ tools (pure instruction loaders)', () => {
    const guard = base()
    expect(guard.toolAllowed('skill__code-review')).toBe(true)
    expect(guard.checkCall('skill__code-review', {})).toBeNull()
  })

  it('allows MCP tools that are explicitly allowlisted', () => {
    const guard = base()
    expect(guard.toolAllowed('mcp__git__git_status')).toBe(true)
    expect(guard.checkCall('mcp__git__git_status', {})).toBeNull()
  })

  it('blocks paths outside allowedPaths, allows inside (win/posix separators)', () => {
    const guard = base()
    expect(guard.checkCall('read_file', { path: 'C:/workspace/src/a.ts' })).toBeNull()
    expect(guard.checkCall('read_file', { path: 'C:\\workspace\\src\\a.ts' })).toBeNull()
    expect(guard.checkCall('read_file', { path: 'C:/workspace/src2/evil.ts' })).toContain('超出')
    expect(guard.checkCall('read_file', { path: 'D:/elsewhere/a.ts' })).toContain('超出')
  })

  it('validates every path in read_multiple_files / multi_edit_file against allowedPaths', () => {
    const guard = base({ tools: ['read_multiple_files', 'multi_edit_file', 'read_file'] })

    expect(guard.checkCall('read_multiple_files', { paths: ['C:/workspace/src/a.ts', 'C:/workspace/tests/b.ts'] })).toBeNull()
    expect(guard.checkCall('read_multiple_files', { paths: ['C:/workspace/src/a.ts', 'C:/workspace/outside/x.ts'] })).toContain('超出')

    expect(guard.checkCall('multi_edit_file', {
      edits: [{ path: 'C:/workspace/src/a.ts', oldText: 'x', newText: 'y' }],
    })).toBeNull()
    expect(guard.checkCall('multi_edit_file', {
      edits: [
        { path: 'C:/workspace/src/a.ts', oldText: 'x', newText: 'y' },
        { path: 'C:/workspace/outside/x.ts', oldText: 'x', newText: 'y' },
      ],
    })).toContain('超出')
  })

  it('does not block batch tools with empty path arrays', () => {
    const guard = base({ tools: ['read_multiple_files', 'multi_edit_file'] })
    expect(guard.checkCall('read_multiple_files', { paths: [] })).toBeNull()
    expect(guard.checkCall('multi_edit_file', { edits: [] })).toBeNull()
  })

  it('scopes run_command cwd and blocks dangerous command fragments', () => {
    const guard = base()
    expect(guard.checkCall('run_command', { command: 'npm test', cwd: 'C:/workspace/src' })).toBeNull()
    expect(guard.checkCall('run_command', { command: 'npm test', cwd: 'C:/workspace/node_modules' })).toContain('超出')
    expect(guard.checkCall('run_command', { command: 'rm -rf /', cwd: 'C:/workspace/src' })).toContain('禁用')
  })

  it('does not path-scope tools without a path argument', () => {
    const guard = base()
    expect(guard.checkCall('read_file', {})).toBeNull()
  })
})

describe('SubagentGuard — read/write path separation (target-mode strong-boundary roles)', () => {
  function writeScopeGuard(over: Record<string, any> = {}) {
    const def = {
      name: 'tester',
      description: '',
      systemPrompt: 'x',
      tools: ['read_file', 'read_multiple_files', 'write_file', 'edit_file', 'multi_edit_file', 'run_command'],
      allowedWritePaths: ['tests', '.ourcode/targemode'],
      source: 'builtin' as const,
      ...over,
    }
    return new SubagentGuard(def, 'C:/workspace')
  }

  it('write tools are scoped to allowedWritePaths; reads stay unrestricted', () => {
    const guard = writeScopeGuard()
    expect(guard.checkCall('write_file', { path: 'C:/workspace/tests/a.test.ts' })).toBeNull()
    expect(guard.checkCall('edit_file', { path: 'C:/workspace/src/business.ts' })).toContain('超出')
    // no allowedReadPaths / allowedPaths → reads anywhere
    expect(guard.checkCall('read_file', { path: 'C:/workspace/src/business.ts' })).toBeNull()
    expect(guard.checkCall('read_file', { path: 'D:/elsewhere/x.ts' })).toBeNull()
  })

  it('multi_edit_file batch paths are checked against the write scope', () => {
    const guard = writeScopeGuard()
    expect(guard.checkCall('multi_edit_file', { edits: [{ path: 'C:/workspace/tests/a.test.ts' }] })).toBeNull()
    expect(guard.checkCall('multi_edit_file', { edits: [{ path: 'C:/workspace/src/business.ts' }] })).toContain('超出')
  })

  it('run_command cwd follows the read/execute scope — tester can run at project root', () => {
    const guard = writeScopeGuard()
    // read scope unrestricted → no cwd requirement
    expect(guard.checkCall('run_command', { command: 'npm test', cwd: 'C:/workspace' })).toBeNull()
  })

  it('explicit allowedReadPaths narrows reads and run_command cwd', () => {
    const guard = writeScopeGuard({ allowedReadPaths: ['src'] })
    expect(guard.checkCall('read_file', { path: 'C:/workspace/src/business.ts' })).toBeNull()
    expect(guard.checkCall('read_file', { path: 'C:/workspace/tests/a.test.ts' })).toContain('超出')
    expect(guard.checkCall('run_command', { command: 'npm test', cwd: 'C:/workspace' })).toContain('超出')
    expect(guard.checkCall('run_command', { command: 'npm test', cwd: 'C:/workspace/src' })).toBeNull()
  })

  it('definitions without the new fields keep the unified allowedPaths behavior', () => {
    const guard = new SubagentGuard({
      name: 'x', description: '', systemPrompt: 'x', source: 'builtin',
      allowedPaths: ['src'],
    }, 'C:/workspace')
    expect(guard.checkCall('read_file', { path: 'C:/workspace/src/a.ts' })).toBeNull()
    expect(guard.checkCall('write_file', { path: 'C:/workspace/src/a.ts' })).toBeNull()
    expect(guard.checkCall('write_file', { path: 'C:/workspace/tests/a.ts' })).toContain('超出')
    // run_command still requires cwd inside allowedPaths (original behavior)
    expect(guard.checkCall('run_command', { command: 'x', cwd: 'C:/workspace' })).toContain('超出')
    expect(guard.checkCall('run_command', { command: 'x', cwd: 'C:/workspace/src' })).toBeNull()
  })
})

describe('path helpers', () => {
  it('isPathWithin handles root boundary and case', () => {
    expect(isPathWithin('C:/workspace/src', 'C:/workspace/src/a.ts')).toBe(true)
    expect(isPathWithin('C:/workspace/src', 'C:/workspace/src')).toBe(true)
    expect(isPathWithin('C:/workspace/src', 'C:/workspace/src2/a.ts')).toBe(false)
    expect(isPathWithin('C:/workspace/src', 'C:/Workspace/src/a.ts')).toBe(true)
    expect(isPathWithin('/home/u/src', '/home/u/src/a.ts')).toBe(true)
    expect(isPathWithin('/home/u/src', '/home/u/srcx')).toBe(false)
  })

  it('resolveAllowedRoot joins relative entries and keeps absolute ones', () => {
    expect(resolveAllowedRoot('C:/workspace', 'src')).toBe('C:/workspace/src')
    expect(resolveAllowedRoot('C:/workspace', './tests')).toBe('C:/workspace/tests')
    expect(resolveAllowedRoot('C:/workspace', 'D:/abs/path')).toBe('D:/abs/path')
  })
})

describe('SubagentGuard — worker mode (M4 员工会话)', () => {
  const workerDef = {
    name: 'tm-developer',
    description: '',
    systemPrompt: 'x',
    tools: undefined,
    source: 'builtin' as const,
  }

  it('lets workers use send_message / run_subagent（回报总监 / 派只读调研助手）', () => {
    const g = new SubagentGuard(workerDef, 'C:/workspace', { workerMode: true })
    expect(g.toolAllowed('send_message')).toBe(true)
    expect(g.checkCall('send_message', { targetSessionId: 'd1', message: 'hi' })).toBeNull()
    expect(g.toolAllowed('run_subagent')).toBe(true)
    expect(g.checkCall('run_subagent', { name: 'researcher', prompt: '调研' })).toBeNull()
  })

  it('still blocks the other control tools for workers（隐藏会话不能向用户提问）', () => {
    const g = new SubagentGuard(workerDef, 'C:/workspace', { workerMode: true })
    for (const t of ['submit_plan', 'ask_user_question', 'manage_todo']) {
      expect(g.toolAllowed(t)).toBe(false)
      expect(g.checkCall(t, {})).toBeTruthy()
    }
  })

  it('worker mode does not leak into plain subagents（同一角色定义，子智能体照旧封禁）', () => {
    const sub = new SubagentGuard(workerDef, 'C:/workspace')
    expect(sub.toolAllowed('send_message')).toBe(false)
    expect(sub.toolAllowed('run_subagent')).toBe(false)
  })
})

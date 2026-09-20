import { describe, it, expect, vi } from 'vitest'
import { createToolRegistry, toToolDefinitions } from '../services/tools/ToolRegistry'
import { ToolExecutor } from '../services/tools/ToolExecutor'
import { extractKeywords, scoreAgainstKeywords, isIgnoredPath, loadWorkspaceKnowledge, buildActiveFileRulesBlock } from '../services/tools/context'

// Skills discovery reads the real filesystem through electronAPI; these tests
// are about rules files, so keep the skill index out of the comparison. The
// rest of the module stays real because ToolExecutor imports other pieces of it.
vi.mock('@/services/skills/skillManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/skills/skillManager')>()),
  listSkills: vi.fn(async () => []),
  buildSkillIndex: vi.fn(async () => ''),
}))

/** In-memory workspace: paths use forward slashes, missing paths stat to null
 *  (mirroring the real fs:stat handler). */
function stubWorkspace(files: Record<string, string>) {
  vi.stubGlobal('window', {
    electronAPI: {
      stat: async (p: string) => (p.replace(/\\/g, '/') in files ? { modifiedAt: 1000 } : null),
      readFile: async (p: string) => {
        const key = p.replace(/\\/g, '/')
        if (!(key in files)) throw new Error(`ENOENT: ${key}`)
        return { content: files[key] }
      },
    },
  })
}

describe('contextEngine - keyword extraction', () => {
  it('extracts camelCase and snake_case identifiers', () => {
    const keywords = extractKeywords('请修复 getUserById 中的 bug')
    expect(keywords).toContain('getuserbyid')
    // camelCase parts become searchable tokens
    expect(keywords).toContain('user')
    expect(keywords).toContain('bug')
  })

  it('extracts CJK bigrams for Chinese text', () => {
    const keywords = extractKeywords('重构登录模块')
    // 2-char CJK bigrams present
    expect(keywords.some((k) => /^[\u4e00-\u9fff]{2}$/.test(k))).toBe(true)
  })

  it('extracts plain English words and skips stopwords', () => {
    const keywords = extractKeywords('please fix the timer for the search feature')
    expect(keywords).toContain('fix')
    expect(keywords).toContain('search')
    expect(keywords).not.toContain('the')
    expect(keywords).not.toContain('please')
  })
})

describe('contextEngine - keyword scoring', () => {
  it('scores documents by keyword overlap', () => {
    const keywords = ['auth', 'login', 'token']
    expect(scoreAgainstKeywords('handle auth login with token', keywords)).toBe(3)
    expect(scoreAgainstKeywords('unrelated file', keywords)).toBe(0)
  })
})

describe('contextEngine - .ourcodeignore', () => {
  it('default state ignores nothing', () => {
    // isIgnoredPath works on the empty default (nothing ignored)
    expect(isIgnoredPath('/project/src/app.ts')).toBe(false)
    expect(isIgnoredPath('any/path/at/all')).toBe(false)
  })
})

describe('contextEngine - cross-tool rules files', () => {
  it('picks up AGENTS.md from the workspace root', async () => {
    stubWorkspace({ 'E:/repo/AGENTS.md': '只用 pnpm，不要 npm' })
    const text = await loadWorkspaceKnowledge('E:/repo')
    expect(text).toContain('只用 pnpm，不要 npm')
    expect(text).toContain('<workspace_knowledge>')
  })

  it('picks up Cursor and Windsurf rule files unchanged', async () => {
    stubWorkspace({ 'E:/repo6/.cursorrules': 'cursor 规则', 'E:/repo6/.windsurfrules': 'windsurf 规则' })
    const text = await loadWorkspaceKnowledge('E:/repo6')
    expect(text).toContain('cursor 规则')
    expect(text).toContain('windsurf 规则')
  })

  it('returns nothing for a workspace without rules', async () => {
    stubWorkspace({ 'E:/repo5/README.md': 'no rules here' })
    expect(await loadWorkspaceKnowledge('E:/repo5')).toBe('')
  })

  it('caps an oversized rules file instead of flooding the stable prefix', async () => {
    stubWorkspace({ 'E:/repo4/AGENTS.md': 'x'.repeat(30000) })
    const text = await loadWorkspaceKnowledge('E:/repo4')
    expect(text).toContain('已截断')
    expect(text.length).toBeLessThan(21000)
  })

  it('keeps directory-level rules out of the stable block and in the per-turn block', async () => {
    // A monorepo package's AGENTS.md follows the active tab, so it must not
    // enter the cached prefix — that would invalidate prompt caching on every
    // file switch.
    stubWorkspace({
      'E:/repo2/AGENTS.md': '根规则',
      'E:/repo2/packages/api/AGENTS.md': 'api 包规则',
    })
    expect(await loadWorkspaceKnowledge('E:/repo2')).not.toContain('api 包规则')
    const dyn = await buildActiveFileRulesBlock('E:/repo2', 'E:/repo2/packages/api/src/x.ts')
    expect(dyn).toContain('api 包规则')
    expect(dyn).toContain('packages/api/AGENTS.md')
    expect(dyn).toContain('<directory_rules>')
  })

  it('ignores an active file outside the workspace', async () => {
    stubWorkspace({ 'E:/repo2/AGENTS.md': '根规则' })
    expect(await buildActiveFileRulesBlock('E:/repo7', 'C:/somewhere/else/x.ts')).toBe('')
  })
})

describe('agent-control tools', () => {
  it('registers plan/todo/question/web tools without approval', () => {
    const tools = createToolRegistry()
    const names = new Set(tools.map((t) => t.name))
    expect(names.has('manage_todo')).toBe(true)
    expect(names.has('submit_plan')).toBe(true)
    expect(names.has('ask_user_question')).toBe(true)
    expect(names.has('web_search')).toBe(true)
    expect(names.has('read_url')).toBe(true)

    for (const name of ['manage_todo', 'submit_plan', 'ask_user_question', 'web_search', 'read_url']) {
      const tool = tools.find((t) => t.name === name)
      expect(tool!.requiresApproval).toBeFalsy()
    }
  })

  it('exposes definitions for the new tools with correct schema', () => {
    const defs = toToolDefinitions(createToolRegistry())
    const plan = defs.find((d) => d.function.name === 'submit_plan')
    expect(plan).toBeTruthy()
    const props = plan!.function.parameters.properties
    expect(props.title).toBeTruthy()
    expect(props.steps).toBeTruthy()
  })

  it('filters tool definitions by name (plan mode)', () => {
    const executor = new ToolExecutor()
    const planDefs = executor.getToolDefinitions((name) => name !== 'write_file')
    expect(planDefs.some((d) => d.function.name === 'write_file')).toBe(false)
    expect(planDefs.some((d) => d.function.name === 'read_file')).toBe(true)
  })

  it('previews the new tools', () => {
    const executor = new ToolExecutor()
    expect(executor.getPreview({ id: '1', name: 'web_search', arguments: { query: 'electron docs' } })).toContain('electron docs')
    expect(executor.getPreview({ id: '1', name: 'submit_plan', arguments: { title: '重构' } })).toContain('重构')
    expect(executor.getPreview({ id: '1', name: 'read_url', arguments: { url: 'https://example.com' } })).toContain('example.com')
    // MCP tools preview
    expect(executor.getPreview({ id: '1', name: 'mcp__github__createIssue', arguments: { title: 'x' } })).toContain('MCP 工具')
  })
})

import { describe, it, expect } from 'vitest'
import { subagentStatusLabel, mergeWriteScopes, resolveSubagentModel, sanitizeModelName } from '@/services/subagents/subagentReport'
import { SubagentGuard } from '@/services/subagents/subagentDefinitions'

describe('subagentStatusLabel (v2 §11.3 — report first line from the runner state machine)', () => {
  const base = {
    aborted: false,
    finalText: '完成了',
    lastError: '',
    hitTokenBudget: false,
    iterationsLeft: 5,
  }

  it('labels a normal completion 完成', () => {
    expect(subagentStatusLabel(base)).toBe('完成')
  })

  it('labels a user-stopped run 阻塞 even with partial output', () => {
    expect(subagentStatusLabel({ ...base, aborted: true, finalText: '' })).toBe('阻塞')
    expect(subagentStatusLabel({ ...base, aborted: true, lastError: 'x' })).toBe('阻塞')
  })

  it('labels a hard error (no final text) 失败', () => {
    expect(subagentStatusLabel({ ...base, finalText: '', lastError: 'network timeout' })).toBe('失败')
  })

  it('labels budget-hit / iterations-exhausted 部分完成', () => {
    expect(subagentStatusLabel({ ...base, finalText: '', hitTokenBudget: true })).toBe('部分完成')
    expect(subagentStatusLabel({ ...base, finalText: '', iterationsLeft: 0 })).toBe('部分完成')
  })

  it('does NOT downgrade a recovered run (final text present despite tool errors)', () => {
    // A tool-result error sets lastError but the agent recovered and produced output
    expect(subagentStatusLabel({ ...base, lastError: 'tool failed' })).toBe('完成')
    // Normal completion exactly at the last allowed iteration is still 完成
    expect(subagentStatusLabel({ ...base, iterationsLeft: 0 })).toBe('完成')
  })
})

describe('mergeWriteScopes (v2 §11.2 — envelope files_to_modify → run write scope)', () => {
  it('returns the definition scope unchanged when the envelope has no paths', () => {
    expect(mergeWriteScopes(undefined, undefined)).toBeUndefined()
    expect(mergeWriteScopes(['src'], undefined)).toEqual(['src'])
    expect(mergeWriteScopes(['src'], [])).toEqual(['src'])
  })

  it('appends envelope paths to the definition scope', () => {
    expect(mergeWriteScopes(['.ourcode/targemode'], ['src/a.ts', 'src/b.ts']))
      .toEqual(['.ourcode/targemode', 'src/a.ts', 'src/b.ts'])
    expect(mergeWriteScopes(undefined, ['src/a.ts'])).toEqual(['src/a.ts'])
  })
})

describe('resolveSubagentModel (v2 §10.5 — override > session > default)', () => {
  it('prefers the envelope override, then session, then default', () => {
    expect(resolveSubagentModel('gpt-4o', 'claude', 'gemini', ['gpt-4o', 'claude', 'gemini'])).toBe('gpt-4o')
    expect(resolveSubagentModel(undefined, 'claude', 'gemini')).toBe('claude')
    expect(resolveSubagentModel(undefined, undefined, 'gemini')).toBe('gemini')
    expect(resolveSubagentModel(undefined, undefined, undefined)).toBe('')
  })

  it('plain runs pass no override → resolution is unchanged', () => {
    expect(resolveSubagentModel(undefined, 'session-model', undefined)).toBe('session-model')
  })

  it('drops junk override values (template placeholder / undefined / none / blank)', () => {
    // 监管 LLM 常照抄信封模板或写占位值——这些绝不能被当作模型名发给 API。
    expect(resolveSubagentModel('<可选，该角色使用的模型>', 'session-model', undefined)).toBe('session-model')
    expect(resolveSubagentModel('undefined', 'session-model', undefined)).toBe('session-model')
    expect(resolveSubagentModel('none', undefined, 'default-model')).toBe('default-model')
    expect(resolveSubagentModel('  ', undefined, undefined)).toBe('')
    expect(resolveSubagentModel('deepseek-chat', undefined, undefined, ['deepseek-chat'])).toBe('deepseek-chat')
    // session/default 同样清洗：junk 不参与回退
    expect(resolveSubagentModel(undefined, 'null', undefined)).toBe('')
  })

  it('strips trailing YAML comments and rejects default', () => {
    expect(resolveSubagentModel('deepseek-chat  # 用这个', undefined, undefined, ['deepseek-chat'])).toBe('deepseek-chat')
    expect(resolveSubagentModel('default', 'session-model', undefined)).toBe('session-model')
  })

  it('skips candidates not in the known-models list (wrong envelope model falls back)', () => {
    const known = ['deepseek-chat', 'gpt-4o']
    // 信封写错 → 回退会话模型
    expect(resolveSubagentModel('gpt-4', 'deepseek-chat', undefined, known)).toBe('deepseek-chat')
    // 信封正确 → 优先信封
    expect(resolveSubagentModel('gpt-4o', 'deepseek-chat', undefined, known)).toBe('gpt-4o')
    // 全都不在列表 → ''
    expect(resolveSubagentModel('claude', undefined, undefined, known)).toBe('')
    // 列表为空 → 信封覆盖无法验证、一律忽略（监管 LLM 编的模型名不能直达 API，
    // 否则正是 400 "Unsupported model" 的主要来源），只用会话/默认模型
    expect(resolveSubagentModel('anything', 'session-model', undefined, [])).toBe('session-model')
    expect(resolveSubagentModel('anything', undefined, 'default-model', [])).toBe('default-model')
    expect(resolveSubagentModel('anything', undefined, undefined, [])).toBe('')
    expect(resolveSubagentModel(undefined, undefined, undefined, [])).toBe('')
  })

  it('strips surrounding quotes from model names', () => {
    // 监管在信封里写 model: "deepseek-chat" 时引号是 YAML 装饰，不是名字的一部分
    expect(sanitizeModelName('"deepseek-chat"')).toBe('deepseek-chat')
    expect(sanitizeModelName("'gpt-4o'")).toBe('gpt-4o')
    expect(sanitizeModelName('`deepseek-chat`')).toBe('deepseek-chat')
    // 剥完引号后照常参与已知列表校验
    expect(resolveSubagentModel('"deepseek-chat"', undefined, undefined, ['deepseek-chat'])).toBe('deepseek-chat')
    expect(resolveSubagentModel('"gpt-4"', 'session-model', undefined, ['deepseek-chat', 'session-model'])).toBe('session-model')
    // 无已知列表时即使清洗后是合法 id，覆盖也不可信 → 回退会话/默认模型
    expect(resolveSubagentModel('"deepseek-chat"', 'session-model', undefined)).toBe('session-model')
  })

  it('rejects names with whitespace / non-ASCII / junk words (never a real model id)', () => {
    expect(resolveSubagentModel('gpt 4o', 'session-model', undefined)).toBe('session-model')
    expect(resolveSubagentModel('深度求索', 'session-model', undefined)).toBe('session-model')
    expect(resolveSubagentModel('optional', 'session-model', undefined)).toBe('session-model')
    expect(resolveSubagentModel('auto', 'session-model', undefined)).toBe('session-model')
  })
})

describe('envelope hard isolation end-to-end (guard + merged write scope)', () => {
  // tm-developer has NO write scope (full access) — the envelope's
  // files_to_modify must narrow it to exactly the declared files.
  const developerDef = {
    name: 'tm-developer', description: '', systemPrompt: 'x', source: 'builtin' as const,
  }

  it('a full-access role becomes write-restricted to files_to_modify; reads stay open', () => {
    const writePaths = mergeWriteScopes(developerDef.allowedWritePaths, ['src/api/todo.ts'])
    const guard = new SubagentGuard({ ...developerDef, allowedWritePaths: writePaths }, 'C:/workspace')

    // declared file → allowed
    expect(guard.checkCall('write_file', { path: 'C:/workspace/src/api/todo.ts' })).toBeNull()
    // anything else → blocked
    expect(guard.checkCall('write_file', { path: 'C:/workspace/src/api/user.ts' })).toContain('超出')
    expect(guard.checkCall('edit_file', { path: 'C:/workspace/README.md' })).toContain('超出')
    // reads stay unrestricted (read scope = allowedReadPaths ?? allowedPaths)
    expect(guard.checkCall('read_file', { path: 'C:/workspace/src/api/user.ts' })).toBeNull()
    // batch write paths are checked too
    expect(guard.checkCall('multi_edit_file', {
      edits: [{ path: 'C:/workspace/src/api/todo.ts' }, { path: 'C:/workspace/README.md' }],
    })).toContain('超出')
  })

  it('a strong-boundary role keeps its own scope plus the envelope paths', () => {
    const writePaths = mergeWriteScopes(['.ourcode/targemode', 'tests'], ['tests/foo.test.ts'])
    const guard = new SubagentGuard({
      ...developerDef, name: 'tm-tester', tools: ['read_file', 'write_file'], allowedWritePaths: writePaths,
    }, 'C:/workspace')

    expect(guard.checkCall('write_file', { path: 'C:/workspace/tests/foo.test.ts' })).toBeNull()
    expect(guard.checkCall('write_file', { path: 'C:/workspace/tests/bar.test.ts' })).toBeNull() // own scope kept
    expect(guard.checkCall('write_file', { path: 'C:/workspace/src/business.ts' })).toContain('超出')
  })
})

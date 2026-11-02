import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/editor/monacoSetup', () => ({ monaco: {} }))
vi.mock('@/editor/modelRegistry', () => ({
  getFileContent: (_p: string, fallback: string) => fallback,
}))

import {
  isPathInsideProject,
  gitSnapshotKey,
  getGitSnapshot,
  buildSystemPrompt,
} from '@/stores/chatStore'
import { useEditorStore } from '@/stores/editorStore'
import { hasExplicitReference } from '@/services/tools/context'

const searchFiles = vi.fn(async (): Promise<string[]> => [])
const searchInFiles = vi.fn(async (): Promise<Array<{ filePath: string; lineNumber: number; lineContent: string }>> => [])

beforeEach(() => {
  searchFiles.mockClear()
  searchInFiles.mockClear()
  vi.stubGlobal('navigator', { platform: 'test' })
  vi.stubGlobal('window', {
    electronAPI: {
      searchFiles,
      searchInFiles,
      stat: async () => null,
      readFile: async () => ({ content: '', encoding: 'utf-8' }),
    },
  })
})

describe('会话即上下文边界', () => {
  it('编辑器标签页按会话项目过滤', () => {
    expect(isPathInsideProject('E:\\ls\\ideUtil\\a.ts', 'E:\\ls\\ideUtil')).toBe(true)
    expect(isPathInsideProject('e:/ls/ideutil/src/a.ts', 'E:\\ls\\ideUtil')).toBe(true)
    expect(isPathInsideProject('D:\\攻防\\笔记.md', 'E:\\ls\\ideUtil')).toBe(false)
    expect(isPathInsideProject('/e:/ls/ideUtil/a.ts', 'E:\\ls\\ideUtil')).toBe(true)
    expect(isPathInsideProject('E:\\ls\\ideUtil-other\\a.ts', 'E:\\ls\\ideUtil')).toBe(false)
    expect(isPathInsideProject('', 'E:\\ls\\ideUtil')).toBe(false)
    expect(isPathInsideProject('E:\\ls\\ideUtil\\a.ts', '')).toBe(false)
  })

  it('git 快照按项目 key 隔离，不会串到别的项目', () => {
    expect(gitSnapshotKey('E:\\ls\\ideUtil\\')).toBe('e:/ls/ideutil')
    expect(gitSnapshotKey('E:/ls/ideUtil')).toBe('e:/ls/ideutil')
    expect(getGitSnapshot('E:\\ls\\does-not-exist')).toBeNull()
    expect(getGitSnapshot(undefined)).toBeNull()
  })

  it('任何一轮都不带工作区改动 / 最近提交（项目历史不是本会话上下文）', async () => {
    const { dynamic } = await buildSystemPrompt('sys', '继续', [], 'E:/proj', false)
    expect(dynamic).toContain('<environment>')
    expect(dynamic).toContain('工作区路径: E:/proj')
    expect(dynamic).not.toContain('工作区改动')
    expect(dynamic).not.toContain('最近提交')
  })

  it('没有明确指代的消息不触发全项目检索', async () => {
    await buildSystemPrompt('sys', '继续', [], 'E:/proj', false)
    await buildSystemPrompt('sys', '这个项目怎么样，帮我看看', [], 'E:/proj', false)
    expect(searchFiles).not.toHaveBeenCalled()
    expect(searchInFiles).not.toHaveBeenCalled()
  })

  it('笔记/文档不会被自动检索带进来，代码文件才可以', async () => {
    searchFiles.mockResolvedValue(['E:/proj/notes/10.66.1.13.md', 'E:/proj/src/a.ts'])
    searchInFiles.mockResolvedValue([
      { filePath: 'E:/proj/notes/10.66.1.13.md', lineNumber: 3, lineContent: '继续：停在等指令状态' },
      { filePath: 'E:/proj/src/a.ts', lineNumber: 12, lineContent: 'export function getUserById() {}' },
    ])
    const { dynamic } = await buildSystemPrompt('sys', '看下 getUserById 的实现', [], 'E:/proj', false)
    expect(dynamic).toContain('<retrieved_context>')
    expect(dynamic).toContain('src/a.ts')
    expect(dynamic).not.toContain('10.66.1.13.md')
    expect(dynamic).not.toContain('等指令')
  })

  it('任何用户消息都走同一套组装（客户端不识别「继续/啥情况/怎么不写了」）', async () => {
    // 同样的历史 + 同样的项目状态，不同措辞必须产出字节相同的动态上下文：
    // 客户端不按消息内容分类，也就不存在「这句话算继续、那句话不算」。
    const a = await buildSystemPrompt('sys', '继续', [], 'E:/proj', false)
    const b = await buildSystemPrompt('sys', '啥情况，咋不写了', [], 'E:/proj', false)
    const c = await buildSystemPrompt('sys', '继续跑', [], 'E:/proj', false)
    expect(a.dynamic).toBe(b.dynamic)
    expect(b.dynamic).toBe(c.dynamic)
  })
})

describe('hasExplicitReference', () => {
  it('只有点名了具体对象才视为明确指代', () => {
    expect(hasExplicitReference('看下 getUserById')).toBe(true)
    expect(hasExplicitReference('改一下 src/a.ts')).toBe(true)
    expect(hasExplicitReference('这个函数 `parseArgs` 有问题')).toBe(true)
    expect(hasExplicitReference('继续')).toBe(false)
    expect(hasExplicitReference('好的')).toBe(false)
    expect(hasExplicitReference('这个项目是做什么的')).toBe(false)
  })
})

describe('提示词只带本会话项目的打开文件', () => {
  it('同项目文件带、别的项目文件不带', async () => {
    useEditorStore.setState({
      openFiles: [
        {
          path: 'E:/proj/src/a.ts',
          content: 'export const a = 1',
          language: 'typescript',
          encoding: 'utf-8',
          lineEnding: 'lf',
          isDirty: false,
        },
        {
          path: 'D:/other/notes.md',
          content: '别的项目的笔记',
          language: 'markdown',
          encoding: 'utf-8',
          lineEnding: 'lf',
          isDirty: false,
        },
      ] as any,
      activeFilePath: 'D:/other/notes.md',
    })
    const { dynamic } = await buildSystemPrompt('sys', '继续', [], 'E:/proj', false)
    expect(dynamic).toContain('E:/proj/src/a.ts')
    expect(dynamic).not.toContain('D:/other/notes.md')
    expect(dynamic).not.toContain('<current_file')
  })
})

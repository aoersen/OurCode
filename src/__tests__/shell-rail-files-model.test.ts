import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileEntry } from '@shared/types'
import {
  attachLoadedChildren,
  compareFileEntries,
  fileBaseName,
  fileExtension,
  fileOpenMode,
  filterFileTree,
  flattenFileTree,
  isHiddenEntry,
  isHiddenFileName,
  joinPath,
  parentDirOf,
  previewKindOf,
  sortFileEntries,
} from '@/shell/agent/rail/railFiles'
import {
  RAIL_STORAGE_PREFIX,
  parseRailMode,
  railStorageKey,
  readRailMode,
  readShowHiddenFiles,
  writeRailMode,
  writeShowHiddenFiles,
} from '@/shell/agent/rail/railMode'

/**
 * 文件模式的纯逻辑：排序 / 隐藏 / 过滤 / 扁平化 / 路径 → 打开方式 / 模式持久化。
 * 组件（FileTreeRail）只做渲染与 IPC，契约都在这里锁住。
 */

const ROOT = 'C:\\work\\demo'

function file(path: string): FileEntry {
  return {
    name: path.split(/[\\/]+/).filter(Boolean).pop() ?? path,
    path,
    isDirectory: false,
    isHidden: false,
  }
}

function dir(path: string, children?: FileEntry[]): FileEntry {
  return {
    name: path.split(/[\\/]+/).filter(Boolean).pop() ?? path,
    path,
    isDirectory: true,
    isHidden: false,
    children,
  }
}

/** 一棵已加载两层的小树：docs / src（含 util/helper.ts）/ 根文件 / 隐藏项。 */
function sampleTree(): FileEntry[] {
  return [
    file(`${ROOT}\\README.md`),
    dir(`${ROOT}\\src`, [
      file(`${ROOT}\\src\\index.ts`),
      dir(`${ROOT}\\src\\util`, [file(`${ROOT}\\src\\util\\helper.ts`)]),
    ]),
    dir(`${ROOT}\\docs`, [file(`${ROOT}\\docs\\guide.md`)]),
    file(`${ROOT}\\logo.png`),
    dir(`${ROOT}\\node_modules`, [file(`${ROOT}\\node_modules\\pkg.js`)]),
    file(`${ROOT}\\.env`),
  ]
}

describe('排序：目录在前，然后按名字（大小写不敏感、稳定）', () => {
  it('目录优先于文件，各层按名字升序', () => {
    const list = [file('b.ts'), dir('z'), file('a.ts'), dir('A-dir'), file('B.ts')]
    expect(sortFileEntries(list).map((entry) => entry.name)).toEqual([
      'A-dir',
      'z',
      'a.ts',
      'B.ts',
      'b.ts',
    ])
  })

  it('同名时用路径兜底，排序不随输入顺序抖动', () => {
    const a = file(`${ROOT}\\a\\same.ts`)
    const b = file(`${ROOT}\\b\\same.ts`)
    expect(compareFileEntries(a, b)).toBeLessThan(0)
    expect(compareFileEntries(b, a)).toBeGreaterThan(0)
    expect(compareFileEntries(a, a)).toBe(0)
  })

  it('不改入参', () => {
    const list = [file('b.ts'), file('a.ts')]
    const sorted = sortFileEntries(list)
    expect(sorted).not.toBe(list)
    expect(list.map((entry) => entry.name)).toEqual(['b.ts', 'a.ts'])
  })
})

describe('可见性：点开头与常见构建目录默认隐藏', () => {
  it('dot 文件 / node_modules / .git / dist / build', () => {
    expect(isHiddenEntry(file('C:\\p\\.env'))).toBe(true)
    expect(isHiddenEntry(dir('C:\\p\\node_modules'))).toBe(true)
    expect(isHiddenEntry(dir('C:\\p\\.git'))).toBe(true)
    expect(isHiddenEntry(dir('C:\\p\\dist'))).toBe(true)
    expect(isHiddenEntry(dir('C:\\p\\build'))).toBe(true)
    expect(isHiddenEntry(dir('C:\\p\\DIST'))).toBe(true)
    expect(isHiddenEntry(file('C:\\p\\README.md'))).toBe(false)
    expect(isHiddenEntry(dir('C:\\p\\src'))).toBe(false)
  })

  it('主进程标了 isHidden 的条目也算隐藏', () => {
    expect(isHiddenEntry({ name: 'secret', isHidden: true })).toBe(true)
    expect(isHiddenFileName('')).toBe(true)
  })
})

describe('过滤：命中项保留层级，隐藏项先剪掉', () => {
  it('未搜索时只按隐藏规则过滤并排序', () => {
    const { entries, forceOpen } = filterFileTree(sampleTree(), '')
    expect(entries.map((entry) => entry.name)).toEqual([
      'docs',
      'src',
      'logo.png',
      'README.md',
    ])
    expect(forceOpen.size).toBe(0)
  })

  it('命中深层文件 → 祖先目录折叠成只剩命中的副本，并标记必须展开', () => {
    const { entries, forceOpen } = filterFileTree(sampleTree(), 'helper')
    expect(entries.map((entry) => entry.name)).toEqual(['src'])
    expect(entries[0].children?.map((entry) => entry.name)).toEqual(['util'])
    expect(entries[0].children?.[0].children?.map((entry) => entry.name)).toEqual(['helper.ts'])
    expect([...forceOpen].sort()).toEqual([`${ROOT}\\src`, `${ROOT}\\src\\util`].sort())
  })

  it('命中文件名：大小写不敏感，只留自己', () => {
    const { entries, forceOpen } = filterFileTree(sampleTree(), 'readme')
    expect(entries.map((entry) => entry.name)).toEqual(['README.md'])
    expect(forceOpen.size).toBe(0)
  })

  it('目录自己命中：保留整棵子树（不强制展开，展开与否由用户决定）', () => {
    const { entries, forceOpen } = filterFileTree(sampleTree(), 'src')
    expect(entries.map((entry) => entry.name)).toEqual(['src'])
    expect(entries[0].children).toHaveLength(2)
    expect(forceOpen.size).toBe(0)
  })

  it('隐藏目录里的命中在默认视图中不存在，打开开关后才出现', () => {
    expect(filterFileTree(sampleTree(), 'pkg').entries).toEqual([])
    expect(filterFileTree(sampleTree(), 'node_modules').entries).toEqual([])
    const shown = filterFileTree(sampleTree(), 'pkg', true)
    expect(shown.entries.map((entry) => entry.name)).toEqual(['node_modules'])
    expect(shown.forceOpen.has(`${ROOT}\\node_modules`)).toBe(true)
  })

  it('没有命中 → 空数组', () => {
    expect(filterFileTree(sampleTree(), 'zzz').entries).toEqual([])
  })
})

describe('扁平化：只下钻展开的目录，占位行跟着加载状态走', () => {
  it('全部收起：只有根层，目录排在文件前', () => {
    const rows = flattenFileTree(sampleTree())
    expect(rows.map((row) => [row.entry.name, row.depth, row.kind])).toEqual([
      ['docs', 0, 'entry'],
      ['src', 0, 'entry'],
      ['logo.png', 0, 'entry'],
      ['README.md', 0, 'entry'],
    ])
  })

  it('展开 src：先出子目录 util，再出 index.ts，深度 +1', () => {
    const rows = flattenFileTree(sampleTree(), { expanded: new Set([`${ROOT}\\src`]) })
    expect(rows.map((row) => [row.entry.name, row.depth])).toEqual([
      ['docs', 0],
      ['src', 0],
      ['util', 1],
      ['index.ts', 1],
      ['logo.png', 0],
      ['README.md', 0],
    ])
  })

  it('展开两层：深层文件 depth=2', () => {
    const rows = flattenFileTree(sampleTree(), {
      expanded: new Set([`${ROOT}\\src`, `${ROOT}\\src\\util`]),
    })
    const helper = rows.find((row) => row.entry.name === 'helper.ts')
    expect(helper).toMatchObject({ depth: 2, kind: 'entry' })
  })

  it('展开中但子项未回来 → loading 占位行（深度 +1，不冒充 treeitem）', () => {
    const src = dir(`${ROOT}\\src`)
    const rows = flattenFileTree([src], {
      expanded: new Set([src.path]),
      loading: new Set([src.path]),
    })
    expect(rows.map((row) => row.kind)).toEqual(['entry', 'loading'])
    expect(rows[1]).toMatchObject({ depth: 1 })
  })

  it('读取失败 → error 占位行（界面给它一行灰字 + 重试）', () => {
    const docs = dir(`${ROOT}\\docs`)
    const rows = flattenFileTree([docs], {
      expanded: new Set([docs.path]),
      errors: new Set([docs.path]),
    })
    expect(rows.map((row) => row.kind)).toEqual(['entry', 'error'])
  })

  it('搜索时强制展开命中路径的祖先，不受 expanded 影响', () => {
    const rows = flattenFileTree(sampleTree(), { query: 'helper' })
    expect(rows.map((row) => [row.entry.name, row.depth])).toEqual([
      ['src', 0],
      ['util', 1],
      ['helper.ts', 2],
    ])
  })

  it('目录名命中但没有展开时，子项不出现（不是强制展开）', () => {
    const rows = flattenFileTree(sampleTree(), { query: 'src' })
    expect(rows.map((row) => row.entry.name)).toEqual(['src'])
  })

  it('隐藏项默认不出现，打开 showHidden 后出现', () => {
    expect(flattenFileTree(sampleTree()).some((row) => row.entry.name === '.env')).toBe(false)
    expect(
      flattenFileTree(sampleTree(), { showHidden: true }).some((row) => row.entry.name === '.env'),
    ).toBe(true)
  })

  it('展开目录里的隐藏项同样默认不可见（懒加载层也要过同一套可见性）', () => {
    const src = dir(`${ROOT}\\src`, [
      file(`${ROOT}\\src\\.env`),
      file(`${ROOT}\\src\\index.ts`),
    ])
    const rows = flattenFileTree([src], { expanded: new Set([src.path]) })
    expect(rows.map((row) => row.entry.name)).toEqual(['src', 'index.ts'])
  })
})

describe('attachLoadedChildren：把懒加载结果贴回树，未变化的节点保持引用', () => {
  it('只替换有子项的那一支，源码树不被修改', () => {
    const child = file(`${ROOT}\\src\\index.ts`)
    const src = dir(`${ROOT}\\src`)
    const root = [src, file(`${ROOT}\\README.md`)]
    const next = attachLoadedChildren(root, new Map([[src.path, [child]]]))
    expect(next).not.toBe(root)
    expect(next[0].children).toEqual([child])
    expect(src.children).toBeUndefined()
    expect(next[1]).toBe(root[1])
  })

  it('没有新数据时原样返回（memo 的引用稳定性）', () => {
    const root = [dir(`${ROOT}\\src`), file(`${ROOT}\\README.md`)]
    expect(attachLoadedChildren(root, new Map())).toBe(root)
  })
})

describe('路径 → 打开方式', () => {
  it('可预览：md/markdown/html/htm/图片 → 产物面板', () => {
    for (const name of ['a.md', 'README.MARKDOWN', 'index.html', 'page.HTM']) {
      expect(previewKindOf(`${ROOT}\\${name}`)).not.toBeNull()
      expect(fileOpenMode(`${ROOT}\\${name}`)).toBe('preview')
    }
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']) {
      expect(previewKindOf(`${ROOT}\\pic.${ext}`)).toBe('image')
    }
    expect(previewKindOf(`${ROOT}\\a.md`)).toBe('markdown')
    expect(previewKindOf(`${ROOT}\\a.markdown`)).toBe('markdown')
    expect(previewKindOf(`${ROOT}\\a.html`)).toBe('html')
    expect(previewKindOf(`${ROOT}\\a.svg`)).toBe('image')
  })

  it('其余（含无扩展名 / 点开头文件 / mdx）只开编辑器', () => {
    for (const path of [`${ROOT}\\app.ts`, `${ROOT}\\README`, `${ROOT}\\.env`, `${ROOT}\\a.mdx`]) {
      expect(previewKindOf(path)).toBeNull()
      expect(fileOpenMode(path)).toBe('editor')
    }
    expect(fileExtension('weird.')).toBe('')
    expect(fileExtension('.env')).toBe('')
  })
})

describe('路径小工具', () => {
  it('fileBaseName 两种分隔符都认', () => {
    expect(fileBaseName('C:\\a\\b.ts')).toBe('b.ts')
    expect(fileBaseName('/x/y.md')).toBe('y.md')
    expect(fileBaseName('a.ts')).toBe('a.ts')
  })

  it('parentDirOf：Windows 盘符根与 POSIX 根都保留', () => {
    expect(parentDirOf(`${ROOT}\\a.ts`)).toBe(ROOT)
    expect(parentDirOf('C:\\a.ts')).toBe('C:\\')
    expect(parentDirOf('/home/yg/a.ts')).toBe('/home/yg')
    expect(parentDirOf('/a.ts')).toBe('/')
    expect(parentDirOf('a.ts')).toBeNull()
  })

  it('joinPath 跟着目录自己的分隔符', () => {
    expect(joinPath('C:\\work', 'a.ts')).toBe('C:\\work\\a.ts')
    expect(joinPath('C:\\work\\', 'a.ts')).toBe('C:\\work\\a.ts')
    expect(joinPath('/home', 'a.ts')).toBe('/home/a.ts')
    expect(joinPath('', 'a.ts')).toBe('a.ts')
  })
})

describe('会话栏模式：解析与按窗口持久化', () => {
  const disk = new Map<string, string>()

  beforeEach(() => {
    disk.clear()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => disk.get(key) ?? null,
      setItem: (key: string, value: string) => {
        disk.set(key, value)
      },
      removeItem: (key: string) => {
        disk.delete(key)
      },
      clear: () => disk.clear(),
      key: (index: number) => [...disk.keys()][index] ?? null,
      get length() {
        return disk.size
      },
    })
  })

  it('默认会话，非法值回退会话', () => {
    expect(parseRailMode('files')).toBe('files')
    expect(parseRailMode('sessions')).toBe('sessions')
    expect(parseRailMode(null)).toBe('sessions')
    expect(parseRailMode('')).toBe('sessions')
  })

  it('key 前缀固定，办公室窗口用独立后缀', () => {
    expect(railStorageKey('mode')).toBe(`${RAIL_STORAGE_PREFIX}mode`)
    expect(railStorageKey('mode', true)).toBe(`${RAIL_STORAGE_PREFIX}mode:office`)
    expect(railStorageKey('mode')).not.toBe(railStorageKey('mode', true))
  })

  it('读不到 / 没写过 → 会话', () => {
    expect(readRailMode()).toBe('sessions')
    expect(readShowHiddenFiles()).toBe(false)
  })

  it('写模式与隐藏开关后能读回来', () => {
    writeRailMode('files')
    expect(disk.get(`${RAIL_STORAGE_PREFIX}mode`)).toBe('files')
    expect(readRailMode()).toBe('files')

    writeShowHiddenFiles(true)
    expect(readShowHiddenFiles()).toBe(true)
    writeShowHiddenFiles(false)
    expect(readShowHiddenFiles()).toBe(false)
  })
})

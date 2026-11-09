import { describe, expect, it } from 'vitest'
import {
  MAX_FILE_DOCS,
  baseName,
  buildDocTabs,
  buildFileDocs,
  buildViewDocs,
  detectFileType,
  docIdAfterClose,
  docIdForNavKey,
  docIdOfFile,
  docSummary,
  fileExtension,
  isTransientBuffer,
  pathOfDocId,
  resolveActiveDocId,
} from '@/shell/agent/artifact/docModel'

describe('docModel · 路径与 id', () => {
  it('baseName 取最后一段（两种分隔符）', () => {
    expect(baseName('C:\\proj\\src\\a.ts')).toBe('a.ts')
    expect(baseName('/home/me/a.ts')).toBe('a.ts')
    expect(baseName('C:\\')).toBe('C:')
    expect(baseName('')).toBe('')
  })

  it('fileExtension 不看点开头的隐藏文件名', () => {
    expect(fileExtension('C:\\a\\b.TSX')).toBe('tsx')
    expect(fileExtension('.gitignore')).toBe('')
    expect(fileExtension('Makefile')).toBe('')
  })

  it('docId 与路径互转', () => {
    expect(docIdOfFile('C:\\a\\b.ts')).toBe('file:C:\\a\\b.ts')
    expect(pathOfDocId('file:C:\\a\\b.ts')).toBe('C:\\a\\b.ts')
    expect(pathOfDocId('plan')).toBeNull()
  })

  it('未命名缓冲区不参与标签', () => {
    expect(isTransientBuffer('/untitled/untitled-1')).toBe(true)
    expect(isTransientBuffer('C:\\a.ts')).toBe(false)
  })
})

describe('docModel · 类型自动识别', () => {
  it('代码 / 样式 / 数据 / 文档各归一类', () => {
    expect(detectFileType('C:\\a\\b.ts')).toMatchObject({ label: 'TS', tone: 'code', view: 'text' })
    expect(detectFileType('C:\\a\\b.tsx').label).toBe('TSX')
    expect(detectFileType('C:\\a\\b.py')).toMatchObject({ tone: 'code', view: 'text' })
    expect(detectFileType('C:\\a\\b.css')).toMatchObject({ tone: 'style', view: 'text' })
    expect(detectFileType('C:\\a\\b.json')).toMatchObject({ tone: 'data', view: 'text' })
    expect(detectFileType('C:\\a\\README.md')).toMatchObject({ label: 'MD', tone: 'doc' })
    expect(detectFileType('C:\\a\\index.html')).toMatchObject({ tone: 'markup' })
  })

  it('图片与二进制分开，不假装能编辑', () => {
    expect(detectFileType('C:\\a\\logo.PNG')).toMatchObject({ tone: 'image', view: 'image' })
    expect(detectFileType('C:\\a\\icon.svg')).toMatchObject({ tone: 'image', view: 'image' })
    expect(detectFileType('C:\\a\\setup.exe')).toMatchObject({ tone: 'binary', view: 'binary' })
    expect(detectFileType('C:\\a\\doc.pdf')).toMatchObject({ tone: 'binary', view: 'binary' })
  })

  it('特殊文件名优先于扩展名', () => {
    expect(detectFileType('C:\\proj\\Dockerfile')).toMatchObject({ label: 'DKR', tone: 'code' })
    expect(detectFileType('C:\\proj\\.gitignore')).toMatchObject({ label: 'GIT', tone: 'data' })
    expect(detectFileType('C:\\proj\\.env')).toMatchObject({ label: 'ENV' })
  })

  it('不认识的扩展名退回短标签，不抛异常', () => {
    const info = detectFileType('C:\\a\\weird.zzz')
    expect(info.label).toBe('ZZZ')
    expect(info.view).toBe('text')
  })
})

describe('docModel · 标签组装', () => {
  const files = (...paths: string[]) => paths.map((path) => ({ path, isDirty: false }))

  it('按打开顺序排列，不把活动文件提到最前（避免标签横跳）', () => {
    const docs = buildFileDocs(files('C:\\a.ts', 'C:\\b.ts', 'C:\\c.ts'))
    expect(docs.map((doc) => doc.label)).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  it('跳过未命名缓冲区与重复路径', () => {
    const docs = buildFileDocs([
      { path: '/untitled/untitled-1' },
      { path: 'C:\\a.ts', isDirty: true },
      { path: 'C:\\a.ts', isDirty: true },
    ])
    expect(docs).toHaveLength(1)
    expect(docs[0].dirty).toBe(true)
    expect(docs[0].closable).toBe(true)
  })

  it('超出上限时保留最近打开的若干个', () => {
    const many = Array.from({ length: MAX_FILE_DOCS + 3 }, (_, i) => ({ path: `C:\\f${i}.ts` }))
    const docs = buildFileDocs(many)
    expect(docs).toHaveLength(MAX_FILE_DOCS)
    expect(docs[docs.length - 1].label).toBe(`f${MAX_FILE_DOCS + 2}.ts`)
  })

  it('会话视图常驻且不可关闭', () => {
    const views = buildViewDocs({ hasPlan: true })
    expect(views.map((doc) => doc.id)).toEqual(['plan', 'changes', 'browser'])
    expect(views.every((doc) => doc.closable === false)).toBe(true)
  })

  it('文件在前、会话视图在后', () => {
    const { all, fileDocs, viewDocs } = buildDocTabs(files('C:\\a.ts', 'C:\\b.md'), { hasPlan: false })
    expect(fileDocs.map((doc) => doc.kind)).toEqual(['file', 'file'])
    expect(viewDocs).toHaveLength(3)
    expect(all.slice(0, 2).every((doc) => doc.kind === 'file')).toBe(true)
    expect(all[2].kind).toBe('plan')
  })

  it('docSummary 报告文件数与未保存数', () => {
    expect(docSummary(buildViewDocs({ hasPlan: false }))).toBe('还没有打开文件')
    const docs = buildFileDocs([{ path: 'C:\\a.ts', isDirty: true }, { path: 'C:\\b.ts' }])
    expect(docSummary(docs)).toBe('2 个文件 · 1 个未保存')
  })
})

describe('docModel · 选中与导航', () => {
  const { all } = buildDocTabs([{ path: 'C:\\a.ts' }, { path: 'C:\\b.md' }], { hasPlan: true })

  it('关闭后落到左侧邻居，越界时退到末尾', () => {
    expect(docIdAfterClose(all, docIdOfFile('C:\\b.md'))).toBe(docIdOfFile('C:\\a.ts'))
    expect(docIdAfterClose(all, docIdOfFile('C:\\a.ts'))).toBe(docIdOfFile('C:\\b.md'))
    expect(docIdAfterClose(all, '不存在')).toBe(all[0].id)
  })

  it('方向键循环、Home/End 跳首尾', () => {
    const first = all[0].id
    const last = all[all.length - 1].id
    expect(docIdForNavKey(all, last, 'ArrowRight')).toBe(first)
    expect(docIdForNavKey(all, first, 'ArrowLeft')).toBe(last)
    expect(docIdForNavKey(all, first, 'End')).toBe(last)
    expect(docIdForNavKey(all, last, 'Home')).toBe(first)
    expect(docIdForNavKey(all, first, 'x')).toBeNull()
  })

  it('活动标签回退链：本地选中 → 编辑器活动文件 → 文件 → 计划', () => {
    expect(resolveActiveDocId(all, docIdOfFile('C:\\b.md'), 'C:\\a.ts')).toBe(docIdOfFile('C:\\b.md'))
    expect(resolveActiveDocId(all, 'gone', 'C:\\a.ts')).toBe(docIdOfFile('C:\\a.ts'))
    expect(resolveActiveDocId(all, null, null)).toBe(docIdOfFile('C:\\a.ts'))
    expect(resolveActiveDocId(buildViewDocs({ hasPlan: true }), null, null)).toBe('plan')
  })
})

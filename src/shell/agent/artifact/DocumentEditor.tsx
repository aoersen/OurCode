import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ensureLanguageService,
  monaco,
  OURCODE_DARK_THEME,
  OURCODE_LIGHT_THEME,
} from '@/editor/monacoSetup'
import {
  fileUri,
  getModel,
  registerModel,
  takeLoader,
  trackLoad,
} from '@/editor/modelRegistry'
import { useEditorStore } from '@/stores/editorStore'
import { useUIStore } from '@/stores/uiStore'
import { detectFileType } from './docModel'
import type { OpenFile } from '@shared/types'

/** 只有「文本类」文件才进得来；图片 / 二进制由调用方拦住。 */

function isDarkTheme(): boolean {
  return document.documentElement.classList.contains('dark')
}

/**
 * 给一个路径拿到（必要时创建）Monaco 模型。
 *
 * 和 EditorContainer 的做法保持一致，这样两条渲染路径不会各自建一份模型：
 *  - 模型已经在注册表里 → 直接用（面板与编辑器共享同一份文本与撤销栈）；
 *  - 创建后注册 + 监听内容变化标脏；
 *  - openFile 预留的流式 loader 在这里消费（大文件分块灌入，不冻结 UI）。
 */
function ensureModel(path: string, file: OpenFile): monaco.editor.ITextModel {
  const existing = getModel(path)
  if (existing && !existing.isDisposed()) return existing

  // openFile 会预留一个流式 loader（大文件分块灌入）；没有 loader 的路径
  // （会话恢复、热退出恢复）直接用 store 里的内容建模型，否则会开出一个空文档。
  const loader = takeLoader(path)
  const model = monaco.editor.createModel(
    loader ? '' : file.content ?? '',
    file.plainText ? 'plaintext' : file.language,
    fileUri(path),
  )
  registerModel(path, model)

  model.onDidChangeContent(() => {
    const current = useEditorStore.getState().openFiles.find((item) => item.path === path)
    // 流式加载期间的变更是程序写入，不是用户编辑 —— 加载完成前不标脏
    if (current && !current.isLoading) useEditorStore.getState().markDirty(path, true)
  })

  if (loader) trackLoad(path, loader(model))

  return model
}

interface DocumentEditorProps {
  path: string
}

/**
 * 面板内的文件编辑器（右侧 400px 栏里真正能改字的那块）。
 *
 * 为什么要有它：agent 壳里没有 IDE 的中央编辑区，旧实现点开一个代码文件只会
 * 调 `editorStore.openFile`，然后把「在编辑器中打开」指向一个不存在的面板 ——
 * 用户看到的是「点了没反应」。这里把 Monaco 直接挂进右栏，Ctrl+S 落盘，
 * 未保存状态由 editorStore 的 isDirty 表达（标签上的圆点来自同一个字段）。
 *
 * 键盘：Ctrl+S 保存；Ctrl+W 由面板标签条接管关闭。
 */
export default function DocumentEditor({ path }: DocumentEditorProps) {
  const file = useEditorStore((s) => s.openFiles.find((item) => item.path === path))
  const theme = useUIStore((s) => s.theme)
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const saveRef = useRef<() => void>(() => {})
  const [position, setPosition] = useState<{ line: number; column: number }>({ line: 1, column: 1 })
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimer = useRef<number | undefined>(undefined)

  const type = detectFileType(path)

  const flashNotice = useCallback((text: string) => {
    setNotice(text)
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 1800)
  }, [])

  const save = useCallback(async () => {
    const state = useEditorStore.getState()
    const target = state.openFiles.find((item) => item.path === path)
    if (!target || target.readOnly) return
    if (!target.isDirty) {
      flashNotice('没有需要保存的修改')
      return
    }
    try {
      const saved = await state.saveFile(path)
      flashNotice(saved ? '已保存' : '保存失败：文件无法写入')
    } catch {
      flashNotice('保存失败：文件无法写入')
    }
  }, [flashNotice, path])

  saveRef.current = () => {
    void save()
  }

  // 建编辑器：每条路径一个实例（路径是 key，切换文件时整体重建）
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const editor = monaco.editor.create(host, {
      automaticLayout: true,
      fontSize: 12.5,
      lineHeight: 20,
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontLigatures: false,
      theme: isDarkTheme() ? OURCODE_DARK_THEME : OURCODE_LIGHT_THEME,
      padding: { top: 10, bottom: 24 },
      minimap: { enabled: false },
      lineNumbersMinChars: 3,
      glyphMargin: false,
      folding: true,
      wordWrap: 'on',
      wrappingIndent: 'same',
      renderLineHighlight: 'line',
      renderWhitespace: 'none',
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      stickyScroll: { enabled: false },
      occurrencesHighlight: 'off',
      selectionHighlight: false,
      quickSuggestions: { other: true, comments: false, strings: false },
      suggestOnTriggerCharacters: true,
      contextmenu: true,
      tabSize: 2,
    })
    editorRef.current = editor

    const cursorSub = editor.onDidChangeCursorPosition((event) => {
      setPosition({ line: event.position.lineNumber, column: event.position.column })
    })
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current())

    let cancelled = false
    void (async () => {
      const current = useEditorStore.getState().openFiles.find((item) => item.path === path)
      if (!current) return
      await ensureLanguageService(current.language)
      if (cancelled || !editorRef.current) return
      const latest = useEditorStore.getState().openFiles.find((item) => item.path === path)
      if (!latest) return
      editor.setModel(ensureModel(path, latest))
      if (latest.readOnly) editor.updateOptions({ readOnly: true })
    })()

    return () => {
      cancelled = true
      cursorSub.dispose()
      // 模型保留在注册表里（未保存内容不能因为换标签就丢），只销毁视图
      editor.setModel(null)
      editor.dispose()
      editorRef.current = null
    }
  }, [path])

  // 主题跟随：uiStore 里可能是 'system'，真正的深浅由 <html class="dark"> 决定，
  // 两处取并集 —— 这样设置面板切换主题后，面板里的 Monaco 不会留在另一套配色。
  useEffect(() => {
    if (!editorRef.current) return
    const dark = theme === 'dark' || isDarkTheme()
    monaco.editor.setTheme(dark ? OURCODE_DARK_THEME : OURCODE_LIGHT_THEME)
  }, [theme])

  useEffect(() => {
    return () => {
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    }
  }, [])

  if (!file) {
    return (
      <div className="h-full px-5 py-6 text-[12.5px] leading-[20px] text-[var(--pure-muted)]">
        这个文件已经关闭。
      </div>
    )
  }

  const loading = file.isLoading === true
  const readOnly = file.readOnly === true

  return (
    <div className="h-full min-h-0 flex flex-col">
      {/* 工具条：类型 + 保存状态 + 动作。它是编辑器与上方标签条之间的边界。 */}
      <div className="shrink-0 h-8 px-3 flex items-center gap-2 border-b border-[var(--pure-border)]">
        <span className="shrink-0 font-mono text-[10px] text-[var(--pure-muted)]">{type.label}</span>
        <span className="min-w-0 truncate text-[11.5px] text-[var(--pure-muted)]" title={path}>
          {type.name}
          {readOnly ? ' · 只读' : ''}
        </span>

        <span className="ml-auto shrink-0 flex items-center gap-2 text-[11.5px]">
          {notice ? (
            <span
              role="status"
              className={`tabular-nums ${
                notice.startsWith('保存失败') ? 'text-[var(--pure-danger)]' : 'text-[var(--pure-ink)]'
              }`}
            >
              {notice}
            </span>
          ) : (
            <span className="tabular-nums text-[var(--pure-muted)]">
              {file.isDirty ? '未保存' : '已保存'}
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              void save()
            }}
            disabled={readOnly || loading || !file.isDirty}
            title="保存（Ctrl+S）"
            className="pure-focus h-6 px-2 rounded-md text-[11.5px] transition-colors text-[var(--pure-ink)] hover:bg-[var(--pure-hover)] disabled:text-[var(--pure-muted)] disabled:hover:bg-transparent"
          >
            保存
          </button>
        </span>
      </div>

      <div className="relative flex-1 min-h-0">
        <div ref={hostRef} className="absolute inset-0" data-document-editor={path} />
        {loading && (
          <div className="absolute inset-x-0 top-0 px-3 py-1.5 text-[11.5px] text-[var(--pure-muted)] bg-[var(--pure-canvas)]">
            正在读取文件{typeof file.loadProgress === 'number' ? ` · ${file.loadProgress}%` : '…'}
          </div>
        )}
      </div>

      <div className="shrink-0 h-7 px-3 flex items-center gap-3 border-t border-[var(--pure-border)] text-[11px] tabular-nums text-[var(--pure-muted)]">
        <span className="truncate font-mono">{file.language || 'text'}</span>
        <span className="ml-auto shrink-0">
          行 {position.line}，列 {position.column}
        </span>
        <span className="shrink-0 uppercase">{file.encoding || 'utf-8'}</span>
        <span className="shrink-0">{file.lineEnding === 'crlf' ? 'CRLF' : 'LF'}</span>
      </div>
    </div>
  )
}

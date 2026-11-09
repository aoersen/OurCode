import { useEffect, useState } from 'react'
import MarkdownRenderer from '@/components/Common/MarkdownRenderer'
import PreviewPane from '@/components/Editor/PreviewPane'
import { getFileViewMode } from '@/editor/fileViews'
import { getModel } from '@/editor/modelRegistry'
import { readDiskContent } from './artifactActions'
import DocumentEditor from './DocumentEditor'
import { detectFileType } from './docModel'

type FileView = 'preview' | 'edit'

interface FileArtifactViewProps {
  path: string
}

/** Markdown 模型可能还在异步创建（懒加载语言服务）——短暂轮询几次。 */
function useModelReady(path: string): boolean {
  const [ready, setReady] = useState(() => !!getModel(path))
  useEffect(() => {
    setReady(!!getModel(path))
    if (getModel(path)) return
    const timer = window.setInterval(() => {
      if (getModel(path)) {
        setReady(true)
        window.clearInterval(timer)
      }
    }, 250)
    return () => window.clearInterval(timer)
  }, [path])
  return ready
}

/** 预览但模型还没建好时的兜底：直接读磁盘内容渲染。 */
function DiskMarkdownPreview({ path }: { path: string }) {
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setText(null)
    setFailed(false)
    void readDiskContent(path).then((result) => {
      if (cancelled) return
      if (result.missing) setFailed(true)
      else setText(result.content)
    })
    return () => {
      cancelled = true
    }
  }, [path])

  if (failed) {
    return (
      <div className="px-4 py-5 text-[12.5px] leading-[20px] text-[var(--pure-muted)]">
        读不到这个文件（可能已被删除或没有权限）。
      </div>
    )
  }
  if (text === null) {
    return <div className="px-4 py-5 text-[12.5px] leading-[20px] text-[var(--pure-muted)]">读取中…</div>
  }
  return (
    <div className="h-full min-h-0 overflow-y-auto pure-scroll px-4 py-4">
      <div className="pure-prose text-[13px] leading-[22px]">
        <MarkdownRenderer content={text} />
      </div>
    </div>
  )
}

/**
 * 「文件文档」视图（右侧面板里一条文件标签的内容区）。
 *
 * 类型由 `detectFileType` 自动判定，不需要用户选：
 *  - 代码 / 文本 → 直接进 Monaco 编辑器（Ctrl+S 落盘，标签上有未保存圆点）；
 *  - Markdown / HTML → 预览 ⇄ 编辑 切换（预览读 Monaco 活模型，没有模型时退回磁盘）；
 *  - 图片 → 只读预览；
 *  - 二进制 → 一行说明（不假装能编辑）。
 */
export default function FileArtifactView({ path }: FileArtifactViewProps) {
  const type = detectFileType(path)
  const mode = getFileViewMode(path)
  const [view, setView] = useState<FileView>('preview')
  const modelReady = useModelReady(path)

  // 换文件回到默认视图（预览 / 编辑器）
  useEffect(() => {
    setView('preview')
  }, [path])

  if (type.view === 'binary') {
    return (
      <div className="h-full px-4 py-5 text-[12.5px] leading-[20px] text-[var(--pure-muted)]">
        <div className="text-[13px] text-[var(--pure-ink)]">{type.name}</div>
        <p className="mt-1.5">
          二进制文件不在面板里解码预览。要在系统里打开，用左栏文件树右键 →「复制路径」后到资源管理器打开。
        </p>
      </div>
    )
  }

  if (type.view === 'image' || mode === 'image') {
    return <PreviewPane path={path} mode="image" />
  }

  if (mode === 'code') {
    return <DocumentEditor key={path} path={path} />
  }

  // markdown / html：预览与编辑两个视角
  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="shrink-0 h-8 px-3 flex items-center gap-3 border-b border-[var(--pure-border)]">
        <span className="min-w-0 truncate text-[11.5px] text-[var(--pure-muted)]" title={path}>
          {type.name}
        </span>
        <div className="ml-auto shrink-0 flex items-center gap-3" role="group" aria-label="视图切换">
          {(['preview', 'edit'] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setView(item)}
              aria-pressed={view === item}
              className={`pure-focus text-[11.5px] leading-[18px] transition-colors ${
                view === item
                  ? 'pure-tab-underline text-[var(--pure-ink)]'
                  : 'text-[var(--pure-muted)] hover:text-[var(--pure-ink)]'
              }`}
            >
              {item === 'preview' ? '预览' : '编辑'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {view === 'edit' ? (
          <DocumentEditor key={`${path}:edit`} path={path} />
        ) : mode === 'markdown' ? (
          modelReady ? (
            <PreviewPane path={path} mode="markdown" />
          ) : (
            <DiskMarkdownPreview path={path} />
          )
        ) : (
          <PreviewPane path={path} mode={mode} />
        )}
      </div>
    </div>
  )
}

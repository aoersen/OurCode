/**
 * useComposer —— 「发送这一条消息」的全部行为。
 *
 * 从 `src/components/ChatPanel/ChatInput.tsx`（1098 行，逻辑 + 六种控件视觉混在一起）
 * 里把行为整块抽出来，视觉交给 `Composer.tsx`。抽取原则：
 *
 *  - 行为一字不改地搬：拖拽文件/目录、语音录音 + STT 转写、@ 引用、slash 命令、
 *    附件 chip、粘贴图片、Enter/Shift+Enter、运行中排队、token 上下文环；
 *  - 不碰运行时：只调用 chatStore / configStore / uiStore 已有 action
 *    （sendMessage / queueMessage / stopGeneration / cycleEditMode / setProjectEditMode…）；
 *  - 草稿存到 `composerDraft` store：hero ↔ inline 两次挂载、切会话、切壳都不丢字。
 *
 * 返回值是「给视觉层用的状态 + 处理器」，不含任何 className 决策。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { useChatStore, type QueuedMessage } from '@/stores/chatStore'
import { useConfigStore } from '@/stores/configStore'
import { useUIStore } from '@/stores/uiStore'
import { useContextUsage } from '@/hooks/useContextUsage'
import { useComposerDraft } from './composerDraft'
import { isCompanySession } from '@/services/permissions/companyGuard'
import type { MessageAttachment } from '@/types'
import {
  SLASH_COMMANDS,
  buildSlashPrompt,
  filterSlashCommands,
  getEditorSlashContext,
  getAllSlashCommands,
  type SlashCommand,
} from '@/services/commands/slashCommands'
import { takePendingVibeReplace } from '@/services/vibeReplace'
import { dragSource } from '@/components/Sidebar/FileTreeNode'
import { basename, extractPathsFromUriList, isPathInside, makeFileLink } from '@/utils/fileRefs'
import { isComposingEvent } from '@/utils/composition'
import {
  DEFAULT_STT_CONFIG,
  isRecordingSupported,
  isSttConfigured,
  loadSttConfig,
  resolveSttConfig,
  saveSttConfig,
  transcribeRecording,
  VoiceRecorder,
  type SttConfig,
  type SttSource,
} from '@/services/speech/stt'
import {
  MAX_IMAGES_PER_MESSAGE,
  fileToImageAttachment,
  isImageFile,
} from '@/utils/imageAttach'
import { useI18n } from '@/i18n/useI18n'
import { v4 as uuidv4 } from 'uuid'

/** 稳定空数组：选择器每次返回新 [] 会让 composer 在每次 store 更新时重渲染 */
const EMPTY_QUEUE: QueuedMessage[] = []

/** 把拖入的 File 解析成绝对路径（preload 桥 → Electron 旧版 File.path） */
function resolveFilePath(file: File): string {
  const api = (window as any).electronAPI
  if (api?.getPathForFile) {
    try {
      const p: unknown = api.getPathForFile(file)
      if (typeof p === 'string' && p) return p
    } catch {
      /* 桥不可用 —— 走下面的旧字段 */
    }
  }
  const legacy = (file as any).path
  return typeof legacy === 'string' ? legacy : ''
}

/**
 * 从 DataTransfer 的每条通道里榨出绝对路径：files → items(webkitGetAsEntry) → uri-list。
 * 某些拖拽源不填 dataTransfer.files，只有 items 或 text/uri-list。
 */
function extractDroppedPaths(dt: DataTransfer | null): string[] {
  if (!dt) return []
  const paths: string[] = []

  for (const file of Array.from(dt.files)) {
    const p = resolveFilePath(file)
    if (p) paths.push(p)
  }

  if (paths.length === 0) {
    for (const item of Array.from(dt.items)) {
      if (item.kind !== 'file') continue
      const entry = (item as any).webkitGetAsEntry?.()
      if (entry) {
        const rootName = String(entry.filesystem?.name || '')
        const fullPath = String(entry.fullPath || '')
        if (rootName && fullPath) {
          const drive = rootName.endsWith(':') ? rootName : rootName + ':'
          paths.push(drive + fullPath.replace(/\//g, '\\'))
          continue
        }
      }
      const f = item.getAsFile()
      if (!f) continue
      const p = resolveFilePath(f)
      if (p) paths.push(p)
    }
  }

  if (paths.length === 0) {
    const uris = dt.getData('text/uri-list') || dt.getData('text/plain') || ''
    for (const p of extractPathsFromUriList(uris)) paths.push(p)
  }
  return paths
}

/** 这次拖拽到底带没带文件（决定了「解析失败」要不要提示，还是纯文字拖拽直接忽略） */
function dragHasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false
  return (
    Array.from(dt.types).includes('Files') ||
    dt.files.length > 0 ||
    Array.from(dt.items).some((i) => i.kind === 'file')
  )
}

export interface ComposerFileSearchState {
  open: boolean
  results: Array<{ name: string; path: string }>
  index: number
  pick: (path: string) => void
  hover: (index: number) => void
}

export interface ComposerSlashState {
  open: boolean
  items: SlashCommand[]
  index: number
  pick: (command: SlashCommand) => void
  hover: (index: number) => void
}

export interface ComposerVoiceState {
  listening: boolean
  busy: boolean
  source: SttSource | null
  setupOpen: boolean
  draft: SttConfig
  setDraft: (next: SttConfig) => void
  toggle: () => void
  closeSetup: () => void
  save: () => void
  reset: () => void
  configured: boolean
}

export interface ComposerController {
  // ── 草稿 ──
  text: string
  contextFiles: string[]
  images: MessageAttachment[]
  dirMap: Record<string, boolean>
  hasDraft: boolean
  canSend: boolean
  placeholder: string
  heroPlaceholder: string
  configReady: boolean

  // ── 运行态 ──
  isRunning: boolean
  queuedMessages: QueuedMessage[]
  queuedHint: boolean
  contextUsage: ReturnType<typeof useContextUsage>

  // ── 文本框 ──
  textareaRef: React.RefObject<HTMLTextAreaElement>
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void

  // ── 动作 ──
  submit: () => void
  stop: () => void
  addFile: () => void
  pickImages: (files: FileList | File[] | null) => void
  removeContextFile: (path: string) => void
  removeImage: (id: string) => void
  sendQueuedNow: (index: number) => void
  removeQueued: (index: number) => void
  clearQueue: () => void

  // ── 拖拽 ──
  isDragOver: boolean
  dragHandlers: {
    onDragOver: (e: React.DragEvent) => void
    onDragLeave: (e: React.DragEvent) => void
    onDrop: (e: React.DragEvent) => void
  }

  // ── 浮层 ──
  fileSearch: ComposerFileSearchState
  slash: ComposerSlashState
  voice: ComposerVoiceState
  closeMenus: () => void
}

export function useComposer(): ComposerController {
  const t = useI18n()

  // 草稿走共享 store：hero ↔ inline 重挂载不丢字
  const text = useComposerDraft((s) => s.text)
  const contextFiles = useComposerDraft((s) => s.contextFiles)
  const images = useComposerDraft((s) => s.images)
  const dirMap = useComposerDraft((s) => s.dirMap)
  const setText = useComposerDraft((s) => s.setText)
  const appendText = useComposerDraft((s) => s.appendText)
  const addDraftFiles = useComposerDraft((s) => s.addContextFiles)
  const markDirectory = useComposerDraft((s) => s.markDirectory)
  const removeDraftFile = useComposerDraft((s) => s.removeContextFile)
  const addDraftImages = useComposerDraft((s) => s.addImages)
  const removeDraftImage = useComposerDraft((s) => s.removeImage)
  const clearDraft = useComposerDraft((s) => s.clear)

  // ── store 读取 ──
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const session = useChatStore((s) =>
    s.activeSessionId ? (s.sessions.find((x) => x.id === s.activeSessionId) ?? null) : null,
  )
  const isRunning = useChatStore(
    (s) => !!s.activeSessionId && s.runningSessionIds.includes(s.activeSessionId),
  )
  const queuedMessages = useChatStore((s) =>
    s.activeSessionId ? (s.queuedMessagesBySession[s.activeSessionId] ?? EMPTY_QUEUE) : EMPTY_QUEUE,
  )
  const sendMessage = useChatStore((s) => s.sendMessage)
  const stopGeneration = useChatStore((s) => s.stopGeneration)
  const queueMessage = useChatStore((s) => s.queueMessage)
  const removeQueuedMessage = useChatStore((s) => s.removeQueuedMessage)
  const sendQueuedNowAction = useChatStore((s) => s.sendQueuedNow)
  const clearQueueAction = useChatStore((s) => s.clearQueue)
  const cycleEditMode = useChatStore((s) => s.cycleEditMode)
  const createSession = useChatStore((s) => s.createSession)

  const activeConfigGroupId = useConfigStore((s) => s.activeConfigGroupId)
  const rootPath = useUIStore((s) => s.rootPath)
  const contextUsage = useContextUsage()

  // ── 局部瞬时状态 ──
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const [showFileSearch, setShowFileSearch] = useState(false)
  const [fileSearchResults, setFileSearchResults] = useState<Array<{ name: string; path: string }>>([])
  const [selectedFileIndex, setSelectedFileIndex] = useState(0)
  const [showSlashMenu, setShowSlashMenu] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0)
  const [allSlashCommands, setAllSlashCommands] = useState<SlashCommand[]>(SLASH_COMMANDS)
  const [queuedHint, setQueuedHint] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)

  // 语音
  const recorderRef = useRef<VoiceRecorder | null>(null)
  const activeCfgRef = useRef<SttConfig | null>(null)
  const [listening, setListening] = useState(false)
  const [voiceBusy, setVoiceBusy] = useState(false)
  const [voiceSource, setVoiceSource] = useState<SttSource | null>(null)
  const [showVoiceSetup, setShowVoiceSetup] = useState(false)
  const [sttDraft, setSttDraft] = useState<SttConfig>(() => loadSttConfig())

  /** 工作区根：store 优先，file-tree 的 data 属性兜底（旧面板布局里存在） */
  const effectiveRoot = useCallback(
    () => rootPath || document.getElementById('file-tree-root')?.getAttribute('data-root-path') || '',
    [rootPath],
  )

  // ── 外部事件：空态建议卡 / 用量面板「运行技能」都靠事件把文本灌进来 ──
  useEffect(() => {
    const onFill = (e: Event) => {
      const value = (e as CustomEvent<{ text?: string }>).detail?.text
      if (!value) return
      setText(value)
      requestAnimationFrame(() => {
        textareaRef.current?.focus()
        textareaRef.current?.setSelectionRange(value.length, value.length)
      })
    }
    const onSet = (e: Event) => {
      const value = (e as CustomEvent<string>).detail
      if (typeof value !== 'string') return
      setText(value)
      textareaRef.current?.focus()
    }
    window.addEventListener('ourcode:fill-input', onFill)
    window.addEventListener('ourcode:set-chat-input', onSet)
    return () => {
      window.removeEventListener('ourcode:fill-input', onFill)
      window.removeEventListener('ourcode:set-chat-input', onSet)
    }
  }, [setText])

  // ── slash 命令表（静态模板 + 工作区技能）──
  useEffect(() => {
    let cancelled = false
    const projectPath = useChatStore.getState().getActiveSession()?.projectPath
    getAllSlashCommands(projectPath)
      .then((cmds) => {
        if (!cancelled) setAllSlashCommands(cmds)
      })
      .catch(() => {
        if (!cancelled) setAllSlashCommands([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  // ── 附件 ──
  /** 附件 chip：工作区外路径先过一次原生读权限（拒绝的永不成为 chip） */
  const addContextFiles = useCallback(
    async (paths: string[]) => {
      const unique = [...new Set(paths)]
      const root = effectiveRoot()
      const editMode =
        useChatStore.getState().getActiveSession()?.projectEditMode || 'confirm_before_change'
      const external = unique.filter((p) => p && !isPathInside(p, root))
      const granted = new Set<string>()
      for (const p of external) {
        let ok = false
        try {
          ok = await window.electronAPI.requestFileTrust(p, editMode)
        } catch {
          ok = false
        }
        if (!ok) {
          useUIStore.getState().showNotification(t('chat.fileTrustDenied', { name: basename(p) }), 'warning')
          continue
        }
        granted.add(p)
      }
      const keep = unique.filter((p) => isPathInside(p, root) || granted.has(p))
      if (keep.length === 0) return
      addDraftFiles(keep)
      for (const p of keep) {
        if (!isPathInside(p, root)) continue
        window.electronAPI
          .stat(p)
          .then((s) => {
            if (s?.isDirectory) markDirectory(p)
          })
          .catch(() => {
            /* 读不了就按文件 chip 显示 */
          })
      }
    },
    [addDraftFiles, effectiveRoot, markDirectory, t],
  )

  /** 图片附件（按钮 / 粘贴 / 拖入）：走渲染进程 FileReader，不碰 fs IPC */
  const attachImageFiles = useCallback(
    async (files: File[]): Promise<MessageAttachment[]> => {
      const picked = files.filter(isImageFile)
      if (picked.length === 0) return []
      const attached: MessageAttachment[] = []
      for (const file of picked) {
        try {
          attached.push(await fileToImageAttachment(file, uuidv4()))
        } catch {
          useUIStore
            .getState()
            .showNotification(t('chat.imageReadFailed', { name: file.name || 'image' }), 'error')
        }
      }
      if (attached.length === 0) return []
      const room = Math.max(0, MAX_IMAGES_PER_MESSAGE - useComposerDraft.getState().images.length)
      if (attached.length > room) {
        useUIStore
          .getState()
          .showNotification(t('chat.imageTooMany', { max: MAX_IMAGES_PER_MESSAGE }), 'warning')
      }
      const keep = attached.slice(0, room)
      if (keep.length > 0) addDraftImages(keep)
      return keep
    },
    [addDraftImages, t],
  )

  const pickImages = useCallback(
    (files: FileList | File[] | null) => {
      if (!files) return
      const list = Array.from(files)
      if (list.length === 0) return
      void attachImageFiles(list)
    },
    [attachImageFiles],
  )

  /** 拖入的图片转成附件，返回文件名集合（调用方把它们从路径引用里排除） */
  const absorbDroppedImages = useCallback(
    async (dt: DataTransfer | null): Promise<Set<string>> => {
      const files = Array.from(dt?.files || []).filter(isImageFile)
      if (files.length === 0) return new Set()
      const attached = await attachImageFiles(files)
      return new Set(attached.map((a) => a.name))
    },
    [attachImageFiles],
  )

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(e.clipboardData?.files || []).filter(isImageFile)
      if (files.length === 0) return
      e.preventDefault()
      void attachImageFiles(files)
    },
    [attachImageFiles],
  )

  const removeContextFile = useCallback((path: string) => removeDraftFile(path), [removeDraftFile])
  const removeImage = useCallback((id: string) => removeDraftImage(id), [removeDraftImage])

  // ── 输入框事件 ──
  const searchFiles = useCallback(
    async (query: string) => {
      const root =
        rootPath || document.getElementById('file-tree-root')?.getAttribute('data-root-path') || ''
      if (!root) {
        setFileSearchResults([])
        return
      }
      try {
        const results = await window.electronAPI.searchFiles(root, query)
        setFileSearchResults(
          results.slice(0, 10).map((path) => ({ name: path.split(/[/\\]/).pop() || path, path })),
        )
      } catch {
        setFileSearchResults([])
      }
    },
    [rootPath],
  )

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value
      setText(value)

      const cursorPos = e.target.selectionStart
      const textBeforeCursor = value.slice(0, cursorPos)
      const atMatch = textBeforeCursor.match(/@(\S*)$/)
      const slashMatch = textBeforeCursor.match(/(^|\n)\/(\S*)$/)

      if (atMatch) {
        setShowFileSearch(true)
        setSelectedFileIndex(0)
        void searchFiles(atMatch[1])
        setShowSlashMenu(false)
      } else {
        setShowFileSearch(false)
        if (slashMatch) {
          setShowSlashMenu(true)
          setSlashQuery(slashMatch[2])
          setSelectedSlashIndex(0)
        } else {
          setShowSlashMenu(false)
        }
      }
    },
    [searchFiles, setText],
  )

  const insertSlashCommand = useCallback(
    (command: SlashCommand) => {
      const cursorPos = textareaRef.current?.selectionStart || text.length
      const textBeforeCursor = text.slice(0, cursorPos)
      const slashMatch = textBeforeCursor.match(/(^|\n)\/(\S*)$/)
      const slashStart = slashMatch ? cursorPos - slashMatch[2].length - 1 : 0
      const textAfter = text.slice(cursorPos)
      const prompt = buildSlashPrompt(command, getEditorSlashContext())
      setText(text.slice(0, slashStart) + prompt + textAfter)
      setShowSlashMenu(false)
      requestAnimationFrame(() => {
        textareaRef.current?.focus()
        const pos = slashStart + prompt.length
        textareaRef.current?.setSelectionRange(pos, pos)
      })
    },
    [setText, text],
  )

  /** @ 选择：删掉悬空的 "@query"，文件以 chip 形式附加（不往正文塞 @path） */
  const insertFileReference = useCallback(
    (filePath: string) => {
      const textarea = textareaRef.current
      const cursorPos = textarea?.selectionStart ?? text.length
      const textBeforeCursor = text.slice(0, cursorPos)
      const atMatch = textBeforeCursor.match(/@(\S*)$/)
      const atIndex = atMatch ? cursorPos - atMatch[1].length - 1 : cursorPos
      setText(text.slice(0, atIndex) + text.slice(cursorPos))
      void addContextFiles([filePath])
      setShowFileSearch(false)
      requestAnimationFrame(() => {
        textarea?.focus()
        textarea?.setSelectionRange(atIndex, atIndex)
      })
    },
    [addContextFiles, setText, text],
  )

  // ── 发送 / 停止 ──
  const hasDraft = !!text.trim() || images.length > 0 || contextFiles.length > 0

  const submit = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed && contextFiles.length === 0 && images.length === 0) return

    const vibe = takePendingVibeReplace()
    const base = vibe
      ? `（Vibe 替换）请按我的要求改写下面的代码，直接输出替换后的完整新代码（单个代码块，不要解释）：\n\n要求: ${trimmed}\n\n--- 当前选中代码 (${vibe.filePath}) ---\n\`\`\`${vibe.language}\n${vibe.text}\n\`\`\``
      : trimmed
    const root = effectiveRoot()
    const links = contextFiles.map((f) => makeFileLink(f, root, dirMap[f] === true))
    const content = [base, links.join('  ')].filter(Boolean).join('  ')

    // 运行中：Enter 变成排队（按会话隔离，不影响其它并行会话）
    if (isRunning && activeSessionId) {
      queueMessage(activeSessionId, content, images)
      clearDraft()
      setQueuedHint(true)
      window.setTimeout(() => setQueuedHint(false), 2000)
      return
    }

    // 没有活动会话（刚启动 / 全部关掉）时，发送即开一个新对话
    let targetId = activeSessionId
    if (!targetId) {
      if (!activeConfigGroupId) {
        useUIStore.getState().openSettings()
        return
      }
      targetId = createSession(activeConfigGroupId, rootPath ?? undefined)
    }

    clearDraft()
    void sendMessage(targetId, content, contextFiles, images)
  }, [
    activeConfigGroupId,
    activeSessionId,
    clearDraft,
    contextFiles,
    createSession,
    dirMap,
    effectiveRoot,
    images,
    isRunning,
    queueMessage,
    rootPath,
    sendMessage,
    text,
  ])

  const stop = useCallback(() => {
    if (activeSessionId) stopGeneration(activeSessionId)
  }, [activeSessionId, stopGeneration])

  const addFile = useCallback(() => {
    const api = window.electronAPI
    if (!api?.openFile) return
    void api
      .openFile()
      .then((filePath) => {
        if (filePath) void addContextFiles([filePath])
      })
      .catch(() => {
        /* 取消 / 桥不可用 */
      })
  }, [addContextFiles])

  // ── 键盘 ──
  const slashItems = useMemo(
    () => filterSlashCommands(slashQuery, allSlashCommands),
    [allSlashCommands, slashQuery],
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // IME 组合期间（拼音候选词未确认）按的键属于输入法：Enter 是「确认候选词」
      if (isComposingEvent(e)) return

      // Ctrl/Cmd + B / I / ` ：包一层 markdown
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const wrap = (before: string, after: string) => {
          const textarea = textareaRef.current
          if (!textarea) return
          const start = textarea.selectionStart
          const end = textarea.selectionEnd
          const selected = text.slice(start, end)
          setText(text.slice(0, start) + before + selected + after + text.slice(end))
          requestAnimationFrame(() => {
            textarea.focus()
            const cursorStart = start + before.length
            textarea.setSelectionRange(cursorStart, cursorStart + selected.length)
          })
        }
        if (e.key === 'b') {
          e.preventDefault()
          wrap('**', '**')
          return
        }
        if (e.key === 'i') {
          e.preventDefault()
          wrap('*', '*')
          return
        }
        if (e.key === '`') {
          e.preventDefault()
          wrap('`', '`')
          return
        }
      }

      // Shift+Tab 循环权限模式（菜单没收 Tab 时）
      if (e.key === 'Tab' && e.shiftKey && !showSlashMenu && !showFileSearch) {
        e.preventDefault()
        const current = activeSessionId
          ? useChatStore.getState().sessions.find((s) => s.id === activeSessionId)
          : undefined
        if (isCompanySession(current)) {
          useUIStore.getState().showNotification(t('chat.companyModeNoSwitch'), 'info')
          return
        }
        if (activeSessionId) void cycleEditMode(activeSessionId)
        return
      }

      if (showSlashMenu && slashItems.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSelectedSlashIndex((prev) => Math.min(prev + 1, slashItems.length - 1))
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSelectedSlashIndex((prev) => Math.max(prev - 1, 0))
          return
        }
        if (e.key === 'Tab' || e.key === 'Enter') {
          e.preventDefault()
          const target = slashItems[selectedSlashIndex] ?? slashItems[0]
          if (target) insertSlashCommand(target)
          return
        }
        if (e.key === 'Escape') {
          setShowSlashMenu(false)
          return
        }
      }

      if (showFileSearch && fileSearchResults.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSelectedFileIndex((prev) => Math.min(prev + 1, fileSearchResults.length - 1))
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSelectedFileIndex((prev) => Math.max(prev - 1, 0))
          return
        }
        if (e.key === 'Tab' || e.key === 'Enter') {
          e.preventDefault()
          const picked = fileSearchResults[selectedFileIndex] ?? fileSearchResults[0]
          if (picked) insertFileReference(picked.path)
          return
        }
        if (e.key === 'Escape') {
          setShowFileSearch(false)
          return
        }
      }

      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        submit()
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        submit()
      }
    },
    [
      activeSessionId,
      cycleEditMode,
      fileSearchResults,
      insertFileReference,
      insertSlashCommand,
      selectedFileIndex,
      selectedSlashIndex,
      setText,
      showFileSearch,
      showSlashMenu,
      slashItems,
      submit,
      t,
      text,
    ],
  )

  // ── 语音 ──
  const voiceErrorText = useCallback(
    (err: unknown): string => {
      const code = err instanceof Error ? err.message : String(err)
      if (code === 'empty-recording') return t('chat.voiceEmpty')
      if (code === 'stt-not-configured') return t('chat.voiceNotConfigured')
      if (code === 'empty-transcript') return t('chat.voiceNoSpeech')
      if (code === 'speech-bridge-missing') return t('chat.voiceBridgeMissing')
      return t('chat.voiceTranscribeFailed', { error: code })
    },
    [t],
  )

  const toggleVoice = useCallback(async () => {
    if (voiceBusy) return
    const notify = useUIStore.getState().showNotification

    if (listening) {
      const rec = recorderRef.current
      const cfg = activeCfgRef.current ?? loadSttConfig()
      recorderRef.current = null
      activeCfgRef.current = null
      setListening(false)
      if (!rec) return
      setVoiceBusy(true)
      try {
        const recording = await rec.stop()
        const transcript = await transcribeRecording(recording, cfg)
        appendText(transcript)
        requestAnimationFrame(() => textareaRef.current?.focus())
      } catch (err) {
        notify(voiceErrorText(err), 'error')
      } finally {
        setVoiceBusy(false)
      }
      return
    }

    if (!isRecordingSupported()) {
      notify(t('chat.voiceUnsupported'), 'warning')
      return
    }

    const { config, source } = await resolveSttConfig(loadSttConfig())
    setVoiceSource(source)
    if (source === 'none') {
      notify(t('chat.voiceNoEndpoint'), 'warning')
      setSttDraft(loadSttConfig())
      setShowVoiceSetup(true)
      return
    }

    const rec = new VoiceRecorder()
    try {
      await rec.start()
      activeCfgRef.current = config
      recorderRef.current = rec
      setListening(true)
    } catch (err) {
      rec.cancel()
      const code = err instanceof Error ? err.message : String(err)
      notify(
        code === 'recording-unsupported' ? t('chat.voiceUnsupported') : t('chat.voiceStartFailed'),
        'error',
      )
    }
  }, [appendText, listening, t, voiceBusy, voiceErrorText])

  // 卸载 / 切会话时松掉麦克风，否则系统录音指示灯一直亮
  useEffect(
    () => () => {
      recorderRef.current?.cancel()
      recorderRef.current = null
    },
    [],
  )

  // ── 拖拽 ──
  const onDragOver = (e: React.DragEvent) => {
    const types = Array.from(e.dataTransfer.types)
    const hasOsFiles =
      e.dataTransfer.files.length > 0 || types.includes('Files') || types.includes('text/uri-list')
    const hasTreeFile = types.includes('application/x-ourcode-path') || !!dragSource.path
    if (!hasOsFiles && !hasTreeFile) return
    e.preventDefault()
    // 文件树拖拽的 effectAllowed 是 move，dropEffect 必须兼容，否则 Chromium 拒收 drop
    e.dataTransfer.dropEffect = e.dataTransfer.effectAllowed === 'move' ? 'move' : 'copy'
    setIsDragOver(true)
  }

  const onDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setIsDragOver(false)
  }

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    const dt = e.dataTransfer

    const imageNames = await absorbDroppedImages(dt)
    const paths = extractDroppedPaths(dt).filter(
      (p) => !imageNames.has(p.split(/[/\\]/).pop() || ''),
    )
    if (paths.length === 0) {
      const treePath = dt.getData('application/x-ourcode-path')
      if (treePath) paths.push(treePath)
    }
    if (paths.length === 0 && dragSource.path) paths.push(dragSource.path)
    if (paths.length === 0) {
      if (imageNames.size === 0 && dragHasFiles(dt)) {
        useUIStore.getState().showNotification(t('chat.dropPathUnavailable'), 'warning')
      }
      return
    }
    void addContextFiles([...new Set(paths)])
    // 清掉用户拖拽前打了一半的 "@"
    const textarea = textareaRef.current
    const cursorPos = textarea?.selectionStart ?? text.length
    const atMatch = text.slice(0, cursorPos).match(/@(\S*)$/)
    if (atMatch) {
      const start = cursorPos - atMatch[1].length - 1
      setText(text.slice(0, start) + text.slice(cursorPos))
    }
    setShowFileSearch(false)
  }

  // 窗口级拖拽兜底：真实 OS 拖拽只有在某处 preventDefault 过 dragover 才会派发 drop，
  // 落点不在输入框里也要能接住（否则用户会以为拖拽被忽略）。
  useEffect(() => {
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault()
      if (dragHasFiles(e.dataTransfer) && e.dataTransfer) {
        e.dataTransfer.dropEffect = e.dataTransfer.effectAllowed === 'move' ? 'move' : 'copy'
      }
    }
    const handleDrop = (e: DragEvent) => {
      const dt = e.dataTransfer
      if ((e.target as HTMLElement)?.closest?.('[data-chat-drop]')) return
      e.preventDefault()
      void absorbDroppedImages(dt).then((imageNames) => {
        const paths = extractDroppedPaths(dt).filter(
          (p) => !imageNames.has(p.split(/[/\\]/).pop() || ''),
        )
        if (paths.length === 0) {
          const treePath = dt?.getData('application/x-ourcode-path')
          if (treePath) paths.push(treePath)
        }
        if (paths.length === 0) {
          if (imageNames.size === 0 && dragHasFiles(dt)) {
            useUIStore.getState().showNotification(t('chat.dropPathUnavailable'), 'warning')
          }
          return
        }
        void addContextFiles([...new Set(paths)])
      })
    }
    document.addEventListener('dragover', handleDragOver, true)
    document.addEventListener('drop', handleDrop, true)
    return () => {
      document.removeEventListener('dragover', handleDragOver, true)
      document.removeEventListener('drop', handleDrop, true)
    }
  }, [absorbDroppedImages, addContextFiles, t])

  // ── 排队 ──
  const sendQueuedNow = useCallback(
    (index: number) => {
      if (activeSessionId) sendQueuedNowAction(activeSessionId, index)
    },
    [activeSessionId, sendQueuedNowAction],
  )
  const removeQueued = useCallback(
    (index: number) => {
      if (activeSessionId) removeQueuedMessage(activeSessionId, index)
    },
    [activeSessionId, removeQueuedMessage],
  )
  const clearQueue = useCallback(() => {
    if (activeSessionId) clearQueueAction(activeSessionId)
  }, [activeSessionId, clearQueueAction])

  const closeMenus = useCallback(() => {
    setShowFileSearch(false)
    setShowSlashMenu(false)
  }, [])

  const placeholder = session?.targetMode
    ? t('chat.targetModePlaceholder')
    : t('chat.composerInlinePlaceholder')
  const heroPlaceholder = session?.targetMode
    ? t('chat.targetModePlaceholder')
    : t('chat.composerHeroPlaceholder')

  return {
    text,
    contextFiles,
    images,
    dirMap,
    hasDraft,
    canSend: hasDraft && !!activeConfigGroupId,
    placeholder,
    heroPlaceholder,
    configReady: !!activeConfigGroupId,

    isRunning,
    queuedMessages,
    queuedHint,
    contextUsage,

    textareaRef,
    onChange,
    onKeyDown,
    onPaste,

    submit,
    stop,
    addFile,
    pickImages,
    removeContextFile,
    removeImage,
    sendQueuedNow,
    removeQueued,
    clearQueue,

    isDragOver,
    dragHandlers: { onDragOver, onDragLeave, onDrop },

    fileSearch: {
      open: showFileSearch,
      results: fileSearchResults,
      index: selectedFileIndex,
      pick: insertFileReference,
      hover: setSelectedFileIndex,
    },
    slash: {
      open: showSlashMenu,
      items: slashItems,
      index: selectedSlashIndex,
      pick: insertSlashCommand,
      hover: setSelectedSlashIndex,
    },
    voice: {
      listening,
      busy: voiceBusy,
      source: voiceSource,
      setupOpen: showVoiceSetup,
      draft: sttDraft,
      setDraft: setSttDraft,
      toggle: () => void toggleVoice(),
      closeSetup: () => setShowVoiceSetup(false),
      save: () => {
        saveSttConfig(sttDraft)
        setShowVoiceSetup(false)
      },
      reset: () => {
        setSttDraft({ ...DEFAULT_STT_CONFIG })
        saveSttConfig({ ...DEFAULT_STT_CONFIG })
        setShowVoiceSetup(false)
      },
      configured: isSttConfigured(sttDraft),
    },
    closeMenus,
  }
}

export default useComposer

/** 空会话判定：空态用 hero composer，有内容用 inline composer。
 *  条件必须和 `ConversationView` 空态渲染完全一致（非 tool 消息为空 + 没有流式正文），
 *  否则会同时挂载两个 composer。 */
export function useIsEmptyConversation(): boolean {
  return useChatStore((s) => {
    if (!s.activeSessionId) return true
    const sess = s.sessions.find((x) => x.id === s.activeSessionId)
    if (!sess) return true
    if (s.streamingBySession[s.activeSessionId]?.content) return false
    return !sess.messages.some((m) => m.role !== 'tool')
  })
}

export type { MessageAttachment }

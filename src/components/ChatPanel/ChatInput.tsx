import { useState, useRef, useEffect, useCallback } from 'react'
import { useChatStore, QueuedMessage } from '@/stores/chatStore'
import { MessageAttachment } from '@/types'
import { useConfigStore } from '@/stores/configStore'
import { useUIStore } from '@/stores/uiStore'
import { filterSlashCommands, buildSlashPrompt, getEditorSlashContext, getAllSlashCommands, SLASH_COMMANDS, SlashCommand } from '@/services/commands/slashCommands'
import { takePendingVibeReplace } from '@/services/vibeReplace'
import { useI18n } from '@/i18n/useI18n'
import type { TranslationKey } from '@/i18n'
import { dragSource } from '../Sidebar/FileTreeNode'
import FileChip from './FileChip'
import { isPathInside, makeFileLink, extractPathsFromUriList, basename } from '@/utils/fileRefs'
import { isComposingEvent } from '@/utils/composition'
import { fileToImageAttachment, imageAttachmentDataUrl, isImageFile, MAX_IMAGES_PER_MESSAGE } from '@/utils/imageAttach'
import { v4 as uuidv4 } from 'uuid'

/** Localized description for a slash command (falls back to the stored text). */
const slashDescription = (cmd: SlashCommand, t: (key: TranslationKey, vars?: Record<string, string | number>) => string) =>
  t(('slashCommands.' + cmd.id) as TranslationKey)

/** Stable empty-queue reference — a fresh [] from the selector would re-render
 *  ChatInput on every store update (e.g. each streaming chunk of a parallel
 *  conversation), since zustand compares with Object.is. */
const EMPTY_QUEUE: QueuedMessage[] = []

/**
 * Resolve the absolute path of a dropped File. Prefers the preload's
 * webUtils.getPathForFile bridge, then falls back to the legacy File.path
 * that Electron ≤ 31 still exposes. Without the fallback, a stale preload
 * (app started before the bridge was added) makes every OS drop silently
 * no-op. Returns '' when the file has no resolvable path.
 */
function resolveFilePath(file: File): string {
  const api = (window as any).electronAPI
  if (api?.getPathForFile) {
    try {
      const p: unknown = api.getPathForFile(file)
      if (typeof p === 'string' && p) return p
    } catch {
      /* bridge unavailable/throws — try the legacy path below */
    }
  }
  const legacy = (file as any).path
  return typeof legacy === 'string' ? legacy : ''
}

/**
 * Extract absolute paths from a drop's DataTransfer through every channel that
 * can carry them. Some drag sources / environments don't populate
 * `dataTransfer.files` on drop even though the drag was accepted (dragover
 * showed the hint); the files may still be reachable via `items` or the
 * `text/uri-list` payload (file:// URLs). Returns [] when nothing resolved.
 */
function extractDroppedPaths(dt: DataTransfer | null): string[] {
  if (!dt) return []
  const paths: string[] = []

  // 1) dataTransfer.files (standard OS file drags)
  for (const file of Array.from(dt.files)) {
    const p = resolveFilePath(file)
    if (p) paths.push(p)
  }

  // 2) dataTransfer.items — file-kind items when .files came up empty. Prefer
  //    webkitGetAsEntry(): it reports the real absolute path (drive + fullPath)
  //    for BOTH files and folders, and works even when the File objects carry
  //    no path (files:0 is common on some drag sources / sandboxed renderers).
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

  // 3) text/uri-list → file:// URLs (last resort; some drag sources send only
  //    URI data and no File objects — e.g. browsers / virtual file items)
  if (paths.length === 0) {
    const uris = dt.getData('text/uri-list') || dt.getData('text/plain') || ''
    for (const p of extractPathsFromUriList(uris)) paths.push(p)
  }
  return paths
}

/** Whether a drag payload carries file data at all (used to decide whether an
 *  empty result is an error worth surfacing vs. a plain text drag). */
function dragHasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false
  return Array.from(dt.types).includes('Files') || dt.files.length > 0 || Array.from(dt.items).some((i) => i.kind === 'file')
}

export default function ChatInput({
  // Office 模式专用按钮文案覆盖：默认空字符串时沿用 i18n 默认（发送/结束）。
  // OfficeChatPane 在 IS_OFFICE=true 时传「发布任务 / 终止任务」，与一人公司
  // 的"派活"语义对齐；agent 模式不传 → 行为完全保持不变。
  idleLabelOverride,
  runningLabelOverride,
}: {
  idleLabelOverride?: string
  runningLabelOverride?: string
} = {}) {
  const [input, setInput] = useState('')
  const [contextFiles, setContextFiles] = useState<string[]>([])
  /** path → isDirectory, resolved lazily via fs:stat (in-workspace only) so
   *  chips can show a folder icon and links get a trailing slash. */
  const [dirMap, setDirMap] = useState<Record<string, boolean>>({})
  const [showFileSearch, setShowFileSearch] = useState(false)
  const [fileSearchResults, setFileSearchResults] = useState<{ name: string; path: string }[]>([])
  const [selectedFileIndex, setSelectedFileIndex] = useState(0)
  const [showSlashMenu, setShowSlashMenu] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0)
  /** Static templates + skill-derived commands (skills loaded once on mount). */
  const [allSlashCommands, setAllSlashCommands] = useState<SlashCommand[]>(SLASH_COMMANDS)
  const [queuedHint, setQueuedHint] = useState(false)
  const [listening, setListening] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  /** 随消息发送的图片（视觉输入）。与 contextFiles 不同：附件是路径引用，
   *  图片是真正的多模态内容，会编码进 LLM 请求。 */
  const [images, setImages] = useState<MessageAttachment[]>([])
  const imageInputRef = useRef<HTMLInputElement>(null)
  const recognitionRef = useRef<{ stop: () => void } | null>(null)
  const t = useI18n()

  // Voice input via the Web Speech API (Ctrl+Shift+M is taken by the Problems panel)
  const toggleVoiceInput = () => {
    const SR = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition
    if (!SR) {
      alert(t('chat.voiceUnsupported'))
      return
    }
    if (listening) {
      recognitionRef.current?.stop()
      setListening(false)
      return
    }
    try {
      const rec = new SR()
      rec.lang = 'zh-CN'
      rec.interimResults = false
      rec.continuous = false
      rec.onresult = (e: any) => {
        const text = e?.results?.[0]?.[0]?.transcript
        if (text) {
          setInput((prev) => (prev ? prev + ' ' : '') + text)
          textareaRef.current?.focus()
        }
      }
      rec.onend = () => setListening(false)
      rec.onerror = () => setListening(false)
      recognitionRef.current = rec
      rec.start()
      setListening(true)
    } catch {
      alert(t('chat.voiceStartFailed'))
      setListening(false)
    }
  }

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileSearchRef = useRef<HTMLDivElement>(null)

  const sendMessage = useChatStore((s) => s.sendMessage)
  const stopGeneration = useChatStore((s) => s.stopGeneration)
  const queueMessage = useChatStore((s) => s.queueMessage)
  const removeQueuedMessage = useChatStore((s) => s.removeQueuedMessage)
  const sendQueuedNow = useChatStore((s) => s.sendQueuedNow)
  const clearQueue = useChatStore((s) => s.clearQueue)
  // Loading/stop state is per session: while THIS conversation generates the
  // send button turns into stop; other conversations running in parallel keep
  // their own buttons (and stopping here must never abort them).
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const isThisSessionLoading = useChatStore((s) => !!s.activeSessionId && s.runningSessionIds.includes(s.activeSessionId))
  const queuedMessages = useChatStore((s) => (s.activeSessionId ? (s.queuedMessagesBySession[s.activeSessionId] ?? EMPTY_QUEUE) : EMPTY_QUEUE))
  const targetMode = useChatStore((s) => {
    const sess = s.sessions.find((x) => x.id === s.activeSessionId)
    return sess?.targetMode === true
  })
  const activeConfigGroupId = useConfigStore((s) => s.activeConfigGroupId)
  const rootPath = useUIStore((s) => s.rootPath)

  // Auto-resize textarea
  useEffect(() => {
    const resize = () => {
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
        textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px'
      }
    }
    resize()
    // 面板宽度变化会改变换行数 —— 不重算的话，变窄时内容被裁进滚动条，
    // 变宽时盒子里留下多余空行。
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [input])

  // Listen for "run skill" actions from the usage panel: inject the skill
  // instructions into the input so the user can review before sending.
  useEffect(() => {
    const onSetInput = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail
      if (typeof detail === 'string') {
        setInput(detail)
        textareaRef.current?.focus()
      }
    }
    window.addEventListener('ourcode:set-chat-input', onSetInput)
    return () => window.removeEventListener('ourcode:set-chat-input', onSetInput)
  }, [])

  // Load slash commands (static templates + workspace skills). Skill-derived
  // commands only carry name/description — the body stays on demand. Skill
  // commands scope to the active session's project (global skills always listed).
  useEffect(() => {
    let cancelled = false
    const projectPath = useChatStore.getState().getActiveSession()?.projectPath
    getAllSlashCommands(projectPath)
      .then((cmds) => { if (!cancelled) setAllSlashCommands(cmds) })
      .catch(() => { if (!cancelled) setAllSlashCommands([]) })
    return () => { cancelled = true }
  }, [])

  // Detect @ trigger
  const searchFiles = useCallback(async (query: string) => {
    try {
      // Get root path from file tree
      const rootEl = document.getElementById('file-tree-root')
      const rootPath = rootEl?.getAttribute('data-root-path')
      if (!rootPath) return

      // Match by file NAME (not content) — searchInFiles searches contents,
      // which made @foo return files whose *contents* mention "foo".
      const results = await window.electronAPI.searchFiles(rootPath, query)
      setFileSearchResults(results.slice(0, 10).map((path) => ({ name: path.split(/[/\\]/).pop() || path, path })))
    } catch {
      setFileSearchResults([])
    }
  }, [])

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setInput(value)

    // Check for @ trigger
    const cursorPos = e.target.selectionStart
    const textBeforeCursor = value.slice(0, cursorPos)
    const atMatch = textBeforeCursor.match(/@(\S*)$/)
    // Check for slash-command trigger ("/" at the start of a line)
    const slashMatch = textBeforeCursor.match(/(^|\n)\/(\S*)$/)

    if (atMatch) {
      setShowFileSearch(true)
      setSelectedFileIndex(0)
      searchFiles(atMatch[1])
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
  }, [searchFiles])

  const insertSlashCommand = useCallback((command: SlashCommand) => {
    const cursorPos = textareaRef.current?.selectionStart || input.length
    const textBeforeCursor = input.slice(0, cursorPos)
    const slashMatch = textBeforeCursor.match(/(^|\n)\/(\S*)$/)
    const slashStart = slashMatch ? cursorPos - slashMatch[2].length - 1 : 0
    const textAfter = input.slice(cursorPos)

    const prompt = buildSlashPrompt(command, getEditorSlashContext())
    const newInput = input.slice(0, slashStart) + prompt + textAfter
    setInput(newInput)
    setShowSlashMenu(false)
    // Place the cursor after the inserted prompt
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      const pos = slashStart + prompt.length
      textareaRef.current?.setSelectionRange(pos, pos)
    })
  }, [input])

  /** Workspace root — store value first, file-tree attr as fallback. */
  const effectiveRoot = useCallback(
    () => rootPath || document.getElementById('file-tree-root')?.getAttribute('data-root-path') || '',
    [rootPath],
  )

  /** Attach files as chips. Folder-ness is resolved lazily via fs:stat so
   *  chips can show a folder icon and links get a trailing slash. Files
   *  outside the workspace first need a one-time read permission (native
   *  dialog) — refused files never become chips, so the AI never gets an
   *  attachment it is not allowed to read. */
  const addContextFiles = useCallback(async (paths: string[]) => {
    const unique = [...new Set(paths)]
    const root = effectiveRoot()
    // The session's project edit mode shapes the native permission dialog
    // (per-file vs. with a session-wide option); it never grants anything.
    const editMode = useChatStore.getState().getActiveSession()?.projectEditMode || 'confirm_before_change'
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
    setContextFiles((prev) => [...new Set([...prev, ...keep])])
    for (const p of keep) {
      if (!isPathInside(p, root)) continue
      window.electronAPI
        .stat(p)
        .then((s) => {
          if (!s?.isDirectory) return
          setDirMap((m) => (m[p] ? m : { ...m, [p]: true }))
        })
        .catch(() => { /* unreadable — stays a file chip */ })
    }
  }, [effectiveRoot, t])

  /** Read image files (button / paste / drop) into `images`. Oversized or
   *  undecodable files are reported instead of silently vanishing; the count is
   *  capped so one message can't carry a megabyte-per-image slideshow. */
  const attachImageFiles = useCallback(async (files: File[]): Promise<MessageAttachment[]> => {
    const picked = files.filter(isImageFile)
    if (picked.length === 0) return []
    const attached: MessageAttachment[] = []
    for (const file of picked) {
      try {
        attached.push(await fileToImageAttachment(file, uuidv4()))
      } catch {
        useUIStore.getState().showNotification(t('chat.imageReadFailed', { name: file.name || 'image' }), 'error')
      }
    }
    if (attached.length === 0) return []
    setImages((prev) => {
      const next = [...prev, ...attached]
      if (next.length > MAX_IMAGES_PER_MESSAGE) {
        useUIStore.getState().showNotification(t('chat.imageTooMany', { max: MAX_IMAGES_PER_MESSAGE }), 'warning')
        return next.slice(0, MAX_IMAGES_PER_MESSAGE)
      }
      return next
    })
    return attached
  }, [t])

  const handleAddImages = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return
    await attachImageFiles(Array.from(files))
  }, [attachImageFiles])

  /** Take the images out of a drop into the attachment row, returning their
   *  names so the caller can keep them out of the path-reference list. */
  const absorbDroppedImages = useCallback(async (dt: DataTransfer | null): Promise<Set<string>> => {
    const files = Array.from(dt?.files || []).filter(isImageFile)
    if (files.length === 0) return new Set()
    const attached = await attachImageFiles(files)
    return new Set(attached.map((a) => a.name))
  }, [attachImageFiles])

  /** Ctrl/Cmd+V with a screenshot on the clipboard attaches it as an image. */
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files || []).filter(isImageFile)
    if (files.length === 0) return
    e.preventDefault()
    void attachImageFiles(files)
  }, [attachImageFiles])

  const insertFileReference = useCallback((filePath: string) => {
    // @-picker selection: drop the dangling "@query" and attach the file as a
    // chip — no @path text goes into the message.
    const textarea = textareaRef.current
    const cursorPos = textarea?.selectionStart ?? input.length
    const textBeforeCursor = input.slice(0, cursorPos)
    const atMatch = textBeforeCursor.match(/@(\S*)$/)
    const atIndex = atMatch ? cursorPos - atMatch[1].length - 1 : cursorPos
    setInput(input.slice(0, atIndex) + input.slice(cursorPos))
    void addContextFiles([filePath])
    setShowFileSearch(false)
    requestAnimationFrame(() => {
      textarea?.focus()
      textarea?.setSelectionRange(atIndex, atIndex)
    })
  }, [input, addContextFiles])

  const removeContextFile = useCallback((filePath: string) => {
    setContextFiles((prev) => prev.filter((f) => f !== filePath))
    setDirMap((m) => {
      const { [filePath]: _drop, ...rest } = m
      return rest
    })
  }, [])

  // --- Drag & drop: OS files or file-tree nodes land here as chips ---

  const handleDragOver = (e: React.DragEvent) => {
    // Accept OS file drags and internal file-tree drags (the tree stores the
    // dragged path in the module-level dragSource AND a custom MIME type so
    // HMR module-replacement doesn't break the reference). A drag counts as a
    // file drag when it carries File objects, the 'Files' type, OR a uri-list
    // payload — Explorer delivers some files/folders as ['text/plain',
    // 'text/uri-list'] with no 'Files' type and an empty dataTransfer.files.
    const types = Array.from(e.dataTransfer.types)
    const hasOsFiles =
      e.dataTransfer.files.length > 0 || types.includes('Files') || types.includes('text/uri-list')
    const hasTreeFile =
      types.includes('application/x-ourcode-path') || !!dragSource.path
    if (!hasOsFiles && !hasTreeFile) return
    e.preventDefault()
    // Drop only fires when dropEffect is compatible with the source's
    // effectAllowed — the file tree drags with 'move', so force 'move' there,
    // otherwise Chromium rejects the drop (dragend without drop).
    e.dataTransfer.dropEffect = e.dataTransfer.effectAllowed === 'move' ? 'move' : 'copy'
    setIsDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    // Only clear when leaving the container itself (children bubble dragleave)
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setIsDragOver(false)
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    const dt = e.dataTransfer

    const imageNames = await absorbDroppedImages(dt)
    // 1) External drag from the OS file manager — resolve paths through every
    //    DataTransfer channel (files / items / uri-list). Images that just went
    //    into the attachment row are excluded: they travel as content, not path.
    const paths = extractDroppedPaths(dt).filter((p) => !imageNames.has(p.split(/[/\\]/).pop() || ''))
    // 2) Internal drag from the file tree via custom MIME type (more reliable
    //    than the module-level dragSource which can get stale after HMR).
    if (paths.length === 0) {
      const treePath = dt.getData('application/x-ourcode-path')
      if (treePath) paths.push(treePath)
    }
    // 3) Fallback: module-level dragSource (kept for backward compatibility)
    if (paths.length === 0 && dragSource.path) {
      paths.push(dragSource.path)
    }
    if (paths.length === 0) {
      // Never fail silently: if the drop carried file data we couldn't resolve
      // (empty dataTransfer.files, stale preload, exotic drag source), tell the
      // user instead of looking like the input ignored the drag.
      if (imageNames.size === 0 && dragHasFiles(dt)) {
        useUIStore.getState().showNotification(t('chat.dropPathUnavailable'), 'warning')
      }
      return
    }

    // Attach every dropped path as a chip — nothing goes into the textarea.
    void addContextFiles([...new Set(paths)])
    // Clear a dangling "@" (in-progress query) the user typed before the drop.
    const textarea = textareaRef.current
    const cursorPos = textarea?.selectionStart ?? input.length
    const atMatch = input.slice(0, cursorPos).match(/@(\S*)$/)
    if (atMatch) {
      const start = cursorPos - atMatch[1].length - 1
      setInput((prev) => prev.slice(0, start) + prev.slice(cursorPos))
    }
    setShowFileSearch(false)
  }

  // Window-level file-drop safety net. A real OS drag is only delivered as a
  // `drop` when some dragover handler calls preventDefault() along the way; if
  // that gate fails for any reason (platform, drag source, stale build), the
  // input's own onDrop never fires and the drag silently does nothing. Accept
  // file drags at the document level and forward any file drop that lands
  // outside the input box into it, so attaching a file always works no matter
  // where on the window it is released.
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      // Accept the drag so the drop is delivered instead of rejected. dropEffect
      // must stay compatible with the source's effectAllowed (file tree drags
      // use 'move'), otherwise Chromium rejects the drop (dragend, no drop).
      e.preventDefault()
      if (dragHasFiles(e.dataTransfer) && e.dataTransfer) {
        e.dataTransfer.dropEffect = e.dataTransfer.effectAllowed === 'move' ? 'move' : 'copy'
      }
    }
    const onDrop = (e: DragEvent) => {
      const dt = e.dataTransfer
      // The input box handles drops on itself; other zones (file tree move, tab
      // reorder) carry no OS files, so a file drop anywhere else in the window
      // safely lands in the chat input.
      if ((e.target as HTMLElement)?.closest?.('[data-chat-drop]')) return
      e.preventDefault()
      void absorbDroppedImages(dt).then((imageNames) => {
        const paths = extractDroppedPaths(dt).filter((p) => !imageNames.has(p.split(/[/\\]/).pop() || ''))
        // Internal file-tree drags carry the path in a custom MIME type.
        if (paths.length === 0) {
          const treePath = dt?.getData('application/x-ourcode-path')
          if (treePath) paths.push(treePath)
        }
        if (paths.length === 0) {
          // Files arrived but none resolved to a path — say so instead of making
          // the drop look like it was ignored.
          if (imageNames.size === 0 && dragHasFiles(dt)) {
            useUIStore.getState().showNotification(t('chat.dropPathUnavailable'), 'warning')
          }
          return
        }
        void addContextFiles([...new Set(paths)])
      })
    }
    document.addEventListener('dragover', onDragOver, true)
    document.addEventListener('drop', onDrop, true)
    return () => {
      document.removeEventListener('dragover', onDragOver, true)
      document.removeEventListener('drop', onDrop, true)
    }
  }, [t, addContextFiles, absorbDroppedImages])

  const handleSubmit = async () => {
    const text = input.trim()
    // Sending is allowed with only attached files/images (no typed text).
    if (!text && contextFiles.length === 0 && images.length === 0) return

    // Vibe-and-Replace: combine the user's description with the stashed selection
    const vibe = takePendingVibeReplace()
    const base = vibe
      ? `（Vibe 替换）请按我的要求改写下面的代码，直接输出替换后的完整新代码（单个代码块，不要解释）：\n\n要求: ${text}\n\n--- 当前选中代码 (${vibe.filePath}) ---\n\`\`\`${vibe.language}\n${vibe.text}\n\`\`\``
      : text
    // Attached files travel as markdown links: [name](./relative/path) for
    // in-workspace paths (folders get a trailing slash), [name](abs) outside.
    const root = effectiveRoot()
    const links = contextFiles.map((f) => makeFileLink(f, root, dirMap[f] === true))
    const content = [base, links.join('  ')].filter(Boolean).join('  ')

    // While the agent is working, Enter queues the message (type-ahead) —
    // scoped to the active session, so parallel conversations are unaffected.
    if (isThisSessionLoading && activeSessionId) {
      queueMessage(activeSessionId, content, images)
      setInput('')
      setContextFiles([])
      setImages([])
      setDirMap({})
      setQueuedHint(true)
      setTimeout(() => setQueuedHint(false), 2000)
      return
    }

    setInput('')
    setContextFiles([])
    setImages([])
    setDirMap({})

    if (activeSessionId) {
      await sendMessage(activeSessionId, content, contextFiles, images)
    }
  }

  // Apply markdown formatting to selected text
  const applyMarkdown = useCallback((before: string, after: string) => {
    const textarea = textareaRef.current
    if (!textarea) return
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const selected = input.slice(start, end)
    const newInput = input.slice(0, start) + before + selected + after + input.slice(end)
    setInput(newInput)
    // Restore cursor: place it after the wrapped text
    requestAnimationFrame(() => {
      textarea.focus()
      const cursorStart = start + before.length
      const cursorEnd = cursorStart + selected.length
      textarea.setSelectionRange(cursorStart, cursorEnd)
    })
  }, [input])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // IME 组合期间（拼音候选词未确认）的按键属于输入法 —— 尤其是 Enter 确认
    // 候选词，绝不能当作发送/菜单选择。提前放行，让浏览器正常提交组合文本。
    if (isComposingEvent(e)) return

    // Markdown shortcuts (Ctrl+B, Ctrl+I, Ctrl+`)
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      if (e.key === 'b') {
        e.preventDefault()
        applyMarkdown('**', '**')
        return
      }
      if (e.key === 'i') {
        e.preventDefault()
        applyMarkdown('*', '*')
        return
      }
      if (e.key === '`') {
        e.preventDefault()
        applyMarkdown('`', '`')
        return
      }
    }

    // Slash-command menu navigation
    const slashCommands = filterSlashCommands(slashQuery, allSlashCommands)
    if (showSlashMenu && slashCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedSlashIndex((prev) => Math.min(prev + 1, slashCommands.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedSlashIndex((prev) => Math.max(prev - 1, 0))
        return
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault()
        insertSlashCommand(slashCommands[selectedSlashIndex])
        return
      }
      if (e.key === 'Escape') {
        setShowSlashMenu(false)
        return
      }
    }

    // File search navigation
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
        insertFileReference(fileSearchResults[selectedFileIndex].path)
        return
      }
      if (e.key === 'Escape') {
        setShowFileSearch(false)
        return
      }
    }

    // Cmd/Ctrl + Enter also submits (Cursor/Claude-style shortcut); plain
    // Enter keeps sending as before and Shift+Enter stays a newline.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      handleSubmit()
      return
    }

    // Submit on Enter (without Shift)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const handleAddFile = async () => {
    try {
      const filePath = await window.electronAPI.openFile()
      if (filePath) {
        void addContextFiles([filePath])
      }
    } catch (error) {
      console.error('打开文件失败:', error)
    }
  }

  // 有内容可发（文本 / 附件 / 上下文文件）—— 运行中决定是否同时显示「发送」
  const hasDraft = !!input.trim() || images.length > 0 || contextFiles.length > 0

  return (
    <div className="border-t border-nova-border p-3">
      {/* 附加文件 —— 输入框上方一行紧凑标签（仅用户主动附加的文件，随消息发送） */}
      {contextFiles.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-2">
          {contextFiles.map((file) => (
            <FileChip
              key={file}
              path={file}
              rootPath={rootPath || ''}
              removable
              onRemove={removeContextFile}
              removeLabel={t('chat.removeFile')}
            />
          ))}
        </div>
      )}

      {/* 图片附件 —— 缩略图一行，随消息以多模态内容发送（不是路径引用） */}
      {images.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-2">
          {images.map((img) => (
            <div key={img.id} className="relative group">
              <img
                src={imageAttachmentDataUrl(img)}
                alt={img.name}
                title={img.name}
                className="h-12 w-12 object-cover rounded border border-nova-border"
              />
              <button
                onClick={() => setImages((prev) => prev.filter((x) => x.id !== img.id))}
                title={t('chat.removeImage')}
                className="absolute -top-1.5 -right-1.5 hidden group-hover:flex w-4 h-4 items-center justify-center rounded-full bg-nova-surface border border-nova-border text-nova-text-muted hover:text-nova-text-primary text-[10px] leading-none"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Queued messages (typed while the agent is working) — shown above the
          input so each one can be sent now or deleted before it fires. */}
      {activeSessionId && queuedMessages.length > 0 && (
        <div className="banner-queue rounded-lg mb-2 overflow-hidden">
          <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
              <path d="M5 22h14M5 2h14" />
              <path d="M17 2v4a5 5 0 0 1-5 5 5 5 0 0 1-5-5V2" />
              <path d="M17 22v-4a5 5 0 0 0-5-5 5 5 0 0 0-5 5v4" />
            </svg>
            <span>{t('chat.queueTitle')} · {queuedMessages.length}</span>
            <button
              onClick={() => clearQueue(activeSessionId)}
              className="ml-auto font-semibold transition-colors hover:text-nova-text-primary"
            >
              {t('chat.queueClearAll')}
            </button>
          </div>
          <div className="max-h-32 overflow-y-auto px-2 pb-2 space-y-1">
            {queuedMessages.map((msg, i) => (
              <div key={i} className="flex items-center gap-1.5 text-xs rounded px-2 py-1 hover:bg-nova-hover transition-colors">
                <span className="flex-1 min-w-0 truncate">{msg.content || t('chat.imageOnly')}</span>
                {msg.attachments?.length ? (
                  <span className="shrink-0 text-[10px] text-nova-text-muted">🖼 {msg.attachments.length}</span>
                ) : null}
                <button
                  onClick={() => sendQueuedNow(activeSessionId, i)}
                  title={t('chat.queueSendNow')}
                  className="shrink-0 opacity-70 hover:opacity-100 transition-opacity"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" stroke="none" />
                  </svg>
                </button>
                <button
                  onClick={() => removeQueuedMessage(activeSessionId, i)}
                  title={t('chat.queueDelete')}
                  className="shrink-0 opacity-70 hover:opacity-100 transition-opacity"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Input Area — also a drop target for files (OS or file tree) */}
      <div
        className={`relative ${isDragOver ? 'ring-2 ring-nova-accent/70 rounded-lg' : ''}`}
        data-chat-drop
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drag-over hint: tells the user a file/folder drop will attach it as
            a chip (sent as a [name](./path) link). pointer-events-none so it
            never steals the drop from the handlers on this container. */}
        {isDragOver && (
          <div
            className="absolute inset-0 z-40 flex items-center justify-center pointer-events-none rounded-lg"
            style={{ background: 'color-mix(in srgb, var(--accent) 16%, transparent)', border: '1.5px dashed var(--accent)' }}
          >
            <div
              className="px-3 py-1.5 rounded-full text-xs font-medium text-white shadow-sm"
              style={{ background: 'var(--accent)' }}
            >
              {t('chat.dropHint')}
            </div>
          </div>
        )}
        {/* Slash-command menu ("/" at the start of a line) */}
        {showSlashMenu && filterSlashCommands(slashQuery, allSlashCommands).length > 0 && (
          <div
            className="absolute bottom-full left-0 right-0 mb-1 bg-nova-surface border border-nova-border rounded shadow-xl max-h-48 overflow-y-auto z-50"
          >
            {filterSlashCommands(slashQuery, allSlashCommands).map((cmd, index) => (
              <div
                key={cmd.id}
                className={`px-3 py-2 cursor-pointer text-sm flex items-center gap-2 ${
                  index === selectedSlashIndex
                    ? 'bg-nova-accent/15 text-nova-text-primary'
                    : 'text-nova-text-secondary hover:bg-nova-hover'
                }`}
                onClick={() => insertSlashCommand(cmd)}
                onMouseEnter={() => setSelectedSlashIndex(index)}
              >
                <span className="text-nova-accent font-medium shrink-0">/{cmd.name}</span>
                <span className="text-nova-text-muted text-xs truncate">{slashDescription(cmd, t)}</span>
              </div>
            ))}
          </div>
        )}

        {/* @file search dropdown */}
        {showFileSearch && fileSearchResults.length > 0 && (
          <div
            ref={fileSearchRef}
            className="absolute bottom-full left-0 right-0 mb-1 bg-nova-surface border border-nova-border rounded shadow-xl max-h-48 overflow-y-auto z-50"
          >
            {fileSearchResults.map((file, index) => (
              <div
                key={file.path}
                className={`px-3 py-2 cursor-pointer text-sm flex items-center gap-2 ${
                  index === selectedFileIndex
                    ? 'bg-nova-accent/15 text-nova-text-primary'
                    : 'text-nova-text-secondary hover:bg-nova-hover'
                }`}
                onClick={() => insertFileReference(file.path)}
              >
                <span className="text-nova-text-muted text-xs">{file.path}</span>
                <span className="ml-auto">{file.name}</span>
              </div>
            ))}
          </div>
        )}

        <div className="chat-input-box overflow-hidden">
          {/* Attachment / context buttons row (above textarea) */}
          <div className="flex gap-0.5 px-2 pt-2">
            <button
              onClick={handleAddFile}
              className="p-1 text-nova-text-muted hover:text-nova-text-primary rounded transition-colors hover:bg-nova-hover shrink-0"
              title={t('chat.addFile')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            <button
              onClick={() => imageInputRef.current?.click()}
              className="p-1 text-nova-text-muted hover:text-nova-text-primary rounded transition-colors hover:bg-nova-hover shrink-0"
              title={t('chat.attachImage')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
            </button>
            {/* 图片选择走渲染进程的 File（FileReader），不用 fs IPC：那条路径
                经 iconv 文本解码，二进制会被破坏。 */}
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                void handleAddImages(e.target.files)
                e.target.value = ''
              }}
            />
          </div>

          {/* Auto-grow textarea */}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={targetMode ? t('chat.targetModePlaceholder') : t('chat.inputPlaceholder')}
            rows={1}
            disabled={!activeConfigGroupId}
            data-ai-input
            className="w-full bg-transparent resize-none text-nova-text-primary text-sm outline-none max-h-[200px] placeholder:text-nova-text-muted disabled:opacity-50 px-3 pt-2 pb-1"
          />

          {/* Footer: hints left, voice + send/stop right */}
          <div className="flex items-center justify-between px-2 pb-2 pt-1">
            <div className="flex items-center gap-1.5 text-[10px] text-nova-text-muted">
              {queuedHint && (
                <>
                  <span className="w-px h-3 bg-nova-border" />
                  <span className="text-nova-accent">{t('chat.queuedHint')}</span>
                </>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={toggleVoiceInput}
                className={`w-7 h-7 rounded-full flex items-center justify-center transition-colors ${listening ? 'bg-red-500/20 text-red-400' : 'bg-nova-hover text-nova-text-muted hover:bg-nova-border hover:text-nova-text-primary'}`}
                title={t('chat.voiceInput')}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                </svg>
              </button>
              {/* 运行中「结束」常驻：之前一打字它就变成「发送」，等于把中止能力
                  藏起来了（想停手必须先清空输入框）。现在两者并存 —— 有草稿时
                  「发送」同时出现，Enter/点击走排队。 */}
              {isThisSessionLoading && (
                <button
                  onClick={() => activeSessionId && stopGeneration(activeSessionId)}
                  className="px-3.5 py-1.5 text-xs text-white font-medium rounded-md transition-colors bg-error hover:opacity-90"
                >
                  {runningLabelOverride || t('chat.stop')}
                </button>
              )}
              {(!isThisSessionLoading || hasDraft) && (
                <button
                  onClick={handleSubmit}
                  disabled={(!input.trim() && contextFiles.length === 0 && images.length === 0) || !activeConfigGroupId}
                  className="text-white text-xs font-medium px-4 py-1.5 rounded-md transition-all hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed bg-nova-accent"
                >
                  {idleLabelOverride || t('chat.send')}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

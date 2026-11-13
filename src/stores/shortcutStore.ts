import { create } from 'zustand'

export interface ShortcutBinding {
  id: string
  action: string
  description: string
  keys: string
  category: 'file' | 'edit' | 'view' | 'chat' | 'ai' | 'terminal'
}

export type ShortcutPreset = 'vscode' | 'jetbrains' | 'custom'

/**
 * Match a KeyboardEvent against a "Ctrl+Shift+S" style binding string.
 * - "Ctrl" also matches Cmd (meta) so the same bindings work on macOS.
 * - Shift is compared exactly so "Ctrl+N" does NOT fire on Ctrl+Shift+N.
 */
export function matchesShortcut(e: KeyboardEvent, keys: string): boolean {
  if (!keys) return false
  const parts = keys.split('+').map((p) => p.trim())
  const keyPart = parts[parts.length - 1]
  const hasCtrl = parts.includes('Ctrl')
  const hasShift = parts.includes('Shift')
  const hasAlt = parts.includes('Alt')

  const ctrlPressed = e.ctrlKey || e.metaKey
  if (ctrlPressed !== hasCtrl) return false
  if (e.altKey !== hasAlt) return false
  if (e.key.toLowerCase() !== keyPart.toLowerCase()) return false
  if (e.shiftKey !== hasShift) return false
  return true
}

// VS Code preset (default)
const VSCODE_SHORTCUTS: ShortcutBinding[] = [
  { id: 'file.new', action: 'newFile', description: '新建文件', keys: 'Ctrl+N', category: 'file' },
  { id: 'file.open', action: 'openFolder', description: '打开文件夹', keys: 'Ctrl+O', category: 'file' },
  { id: 'file.save', action: 'saveFile', description: '保存文件', keys: 'Ctrl+S', category: 'file' },
  { id: 'file.saveAll', action: 'saveAll', description: '保存所有文件', keys: 'Ctrl+Shift+S', category: 'file' },
  { id: 'file.close', action: 'closeTab', description: '关闭当前标签', keys: 'Ctrl+W', category: 'file' },
  { id: 'file.quickOpen', action: 'quickOpen', description: '快速打开文件', keys: 'Ctrl+P', category: 'file' },
  { id: 'file.recentFiles', action: 'recentFiles', description: '最近打开的文件', keys: 'Ctrl+R', category: 'file' },
  { id: 'edit.undo', action: 'undo', description: '撤销', keys: 'Ctrl+Z', category: 'edit' },
  { id: 'edit.redo', action: 'redo', description: '重做', keys: 'Ctrl+Shift+Z', category: 'edit' },
  { id: 'edit.find', action: 'find', description: '查找', keys: 'Ctrl+F', category: 'edit' },
  { id: 'edit.replace', action: 'replace', description: '替换', keys: 'Ctrl+H', category: 'edit' },
  { id: 'view.terminal', action: 'toggleTerminal', description: '切换终端面板', keys: 'Ctrl+J', category: 'view' },
  { id: 'view.chat', action: 'toggleChat', description: '切换 AI 面板', keys: 'Ctrl+L', category: 'view' },
  { id: 'view.commandPalette', action: 'commandPalette', description: '命令面板', keys: 'Ctrl+Shift+P', category: 'view' },
  { id: 'view.problems', action: 'toggleProblems', description: '切换问题面板', keys: 'Ctrl+Shift+M', category: 'view' },
  { id: 'view.debug', action: 'toggleDebugPanel', description: '切换调试面板', keys: 'Ctrl+Shift+D', category: 'view' },
  { id: 'view.zoomIn', action: 'zoomIn', description: '放大', keys: 'Ctrl+=', category: 'view' },
  { id: 'view.zoomOut', action: 'zoomOut', description: '缩小', keys: 'Ctrl+-', category: 'view' },
  { id: 'chat.sendSelection', action: 'sendSelectionToAI', description: '发送选中文本给AI', keys: 'Ctrl+Shift+L', category: 'chat' },
  { id: 'chat.newSession', action: 'newChatSession', description: '新建对话', keys: 'Ctrl+Shift+N', category: 'chat' },
  { id: 'ai.explain', action: 'aiExplain', description: 'AI: 解释代码', keys: 'Ctrl+Shift+E', category: 'ai' },
  { id: 'ai.inlineEdit', action: 'aiInlineEdit', description: 'AI: 内联编辑', keys: 'Ctrl+I', category: 'ai' },
]

// JetBrains preset
const JETBRAINS_SHORTCUTS: ShortcutBinding[] = [
  { id: 'file.new', action: 'newFile', description: '新建文件', keys: 'Ctrl+Alt+Insert', category: 'file' },
  { id: 'file.open', action: 'openFolder', description: '打开文件夹', keys: 'Ctrl+Shift+O', category: 'file' },
  { id: 'file.save', action: 'saveFile', description: '保存文件', keys: 'Ctrl+S', category: 'file' },
  { id: 'file.saveAll', action: 'saveAll', description: '保存所有文件', keys: 'Ctrl+Shift+S', category: 'file' },
  { id: 'file.close', action: 'closeTab', description: '关闭当前标签', keys: 'Ctrl+F4', category: 'file' },
  { id: 'file.quickOpen', action: 'quickOpen', description: '快速打开文件', keys: 'Ctrl+Shift+N', category: 'file' },
  { id: 'file.recentFiles', action: 'recentFiles', description: '最近打开的文件', keys: 'Ctrl+R', category: 'file' },
  { id: 'edit.undo', action: 'undo', description: '撤销', keys: 'Ctrl+Z', category: 'edit' },
  { id: 'edit.redo', action: 'redo', description: '重做', keys: 'Ctrl+Shift+Z', category: 'edit' },
  { id: 'edit.find', action: 'find', description: '查找', keys: 'Ctrl+F', category: 'edit' },
  { id: 'edit.replace', action: 'replace', description: '替换', keys: 'Ctrl+R', category: 'edit' },
  { id: 'view.terminal', action: 'toggleTerminal', description: '切换终端面板', keys: 'Alt+F12', category: 'view' },
  { id: 'view.chat', action: 'toggleChat', description: '切换 AI 面板', keys: 'Ctrl+L', category: 'view' },
  { id: 'view.commandPalette', action: 'commandPalette', description: '命令面板', keys: 'Ctrl+Shift+A', category: 'view' },
  { id: 'view.problems', action: 'toggleProblems', description: '切换问题面板', keys: 'Ctrl+Shift+M', category: 'view' },
  { id: 'view.zoomIn', action: 'zoomIn', description: '放大', keys: 'Ctrl+=', category: 'view' },
  { id: 'view.zoomOut', action: 'zoomOut', description: '缩小', keys: 'Ctrl+-', category: 'view' },
  { id: 'chat.sendSelection', action: 'sendSelectionToAI', description: '发送选中文本给AI', keys: 'Ctrl+Shift+L', category: 'chat' },
  { id: 'chat.newSession', action: 'newChatSession', description: '新建对话', keys: 'Ctrl+Shift+N', category: 'chat' },
  { id: 'ai.explain', action: 'aiExplain', description: 'AI: 解释代码', keys: 'Ctrl+Shift+E', category: 'ai' },
  { id: 'ai.inlineEdit', action: 'aiInlineEdit', description: 'AI: 内联编辑', keys: 'Alt+Enter', category: 'ai' },
]

interface ShortcutState {
  preset: ShortcutPreset
  shortcuts: ShortcutBinding[]
  customShortcuts: ShortcutBinding[]

  setPreset: (preset: ShortcutPreset) => void
  updateShortcut: (id: string, keys: string) => void
  getShortcut: (action: string) => string
  resetToPreset: (preset: ShortcutPreset) => void
  loadShortcuts: () => void
  saveShortcuts: () => void
}

const PRESET_MAP: Record<ShortcutPreset, ShortcutBinding[]> = {
  vscode: VSCODE_SHORTCUTS,
  jetbrains: JETBRAINS_SHORTCUTS,
  custom: VSCODE_SHORTCUTS, // Default custom starts from VS Code
}

export const useShortcutStore = create<ShortcutState>((set, get) => ({
  preset: 'vscode',
  shortcuts: VSCODE_SHORTCUTS,
  customShortcuts: [...VSCODE_SHORTCUTS],

  setPreset: (preset) => {
    const shortcuts = preset === 'custom' ? get().customShortcuts : PRESET_MAP[preset]
    set({ preset, shortcuts })
    get().saveShortcuts()
  },

  updateShortcut: (id, keys) => {
    const newShortcuts = get().shortcuts.map((s) =>
      s.id === id ? { ...s, keys } : s
    )
    set({
      shortcuts: newShortcuts,
      customShortcuts: newShortcuts,
      preset: 'custom',
    })
    get().saveShortcuts()
  },

  getShortcut: (action) => {
    const shortcut = get().shortcuts.find((s) => s.action === action)
    return shortcut?.keys || ''
  },

  resetToPreset: (preset) => {
    const shortcuts = [...PRESET_MAP[preset]]
    set({ preset, shortcuts, customShortcuts: shortcuts })
    get().saveShortcuts()
  },

  loadShortcuts: () => {
    try {
      const saved = localStorage.getItem('shortcutPreset')
      const custom = localStorage.getItem('customShortcuts')
      if (saved) {
        const preset = saved as ShortcutPreset
        const customShortcuts = custom ? JSON.parse(custom) : [...PRESET_MAP[preset]]
        const shortcuts = preset === 'custom' ? customShortcuts : PRESET_MAP[preset]
        set({ preset, shortcuts, customShortcuts })
      }
    } catch {
      // Use defaults
    }
  },

  saveShortcuts: () => {
    const { preset, customShortcuts } = get()
    localStorage.setItem('shortcutPreset', preset)
    localStorage.setItem('customShortcuts', JSON.stringify(customShortcuts))
  },
}))

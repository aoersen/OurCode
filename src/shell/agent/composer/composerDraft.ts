/**
 * composer 草稿的共享状态。
 *
 * 为什么是 store 而不是组件内 useState：
 *  - 空态时 composer 是 hero（渲染在阅读列里），首条消息之后变成 inline（dock 里），
 *    两次挂载是两个组件实例，本地 state 会把没发出去的草稿丢掉；
 *  - 切会话时 composer 也会重新挂载（旧 ChatInput 是常驻单实例，草稿不会丢）；
 *  - 切壳（Ctrl+Alt+M）来回一趟同样会重挂载。
 *
 * 这里只放「用户可见的草稿」：文本 / 附件路径 / 图片 / 目录标记。
 * 任何一层菜单开合、语音录音、@ 搜索都是瞬时状态，留在 useComposer 的局部 state。
 */
import { create } from 'zustand'
import type { MessageAttachment } from '@/types'

interface ComposerDraftState {
  text: string
  contextFiles: string[]
  images: MessageAttachment[]
  /** path → isDirectory，由 fs:stat 懒解析（仅工作区内），chip 用它换文件夹图标 */
  dirMap: Record<string, boolean>
  setText: (value: string) => void
  appendText: (value: string) => void
  addContextFiles: (paths: string[]) => void
  markDirectory: (path: string) => void
  removeContextFile: (path: string) => void
  addImages: (images: MessageAttachment[]) => void
  removeImage: (id: string) => void
  clear: () => void
}

export const useComposerDraft = create<ComposerDraftState>((set, get) => ({
  text: '',
  contextFiles: [],
  images: [],
  dirMap: {},

  setText: (value) => set({ text: value }),

  /** 语音转写结果追加到末尾：中英混排时仅在英文/数字结尾补一个空格 */
  appendText: (value) => {
    if (!value) return
    const prev = get().text
    const needsSpace = prev.length > 0 && !/\s$/.test(prev) && /[A-Za-z0-9]$/.test(prev)
    set({ text: prev + (needsSpace ? ' ' : '') + value })
  },

  addContextFiles: (paths) =>
    set((s) => ({ contextFiles: [...new Set([...s.contextFiles, ...paths])] })),

  markDirectory: (path) =>
    set((s) => (s.dirMap[path] ? s : { dirMap: { ...s.dirMap, [path]: true } })),

  removeContextFile: (path) =>
    set((s) => {
      const { [path]: _drop, ...rest } = s.dirMap
      return { contextFiles: s.contextFiles.filter((f) => f !== path), dirMap: rest }
    }),

  addImages: (incoming) => set((s) => ({ images: [...s.images, ...incoming] })),

  removeImage: (id) => set((s) => ({ images: s.images.filter((x) => x.id !== id) })),

  clear: () => set({ text: '', contextFiles: [], images: [], dirMap: {} }),
}))

export default useComposerDraft

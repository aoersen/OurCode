import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileEntry } from '@/types'
import { attachLoadedChildren } from './railFiles'

/**
 * 文件模式的懒加载数据源。
 *
 * 只做三件事：
 *  1. 读项目根（先 authorize，再 listDir——主进程没注册过的路径会被拒绝）；
 *  2. 展开目录时按需读它这一层，读到就缓存；
 *  3. 读失败留下错误标记，交给界面显示一行灰字 + 「重试」，不弹窗。
 *
 * 竞态：每次切根把 seq 加一，迟到的 IPC 结果直接丢弃（快速切项目时旧项目的
 * 目录不能糊到新项目上）。展开状态 / 已加载目录按根重置，不跨项目串味。
 */

export type RailRootStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface RailFilesState {
  /** 根 + 已加载子项拼好的树（引用在无变化时保持稳定）。 */
  tree: FileEntry[]
  rootStatus: RailRootStatus
  expanded: ReadonlySet<string>
  loadingDirs: ReadonlySet<string>
  errorDirs: ReadonlySet<string>
  toggleDir: (entry: FileEntry) => void
  expandDir: (entry: FileEntry) => void
  collapseDir: (entry: FileEntry) => void
  /** 展开时子项还没加载 → 读一层（已加载 / 正在读 / 出错的目录跳过）。 */
  ensureDir: (path: string) => void
  retryRoot: () => void
  retryDir: (path: string) => void
  /** 重新读某一层（重命名 / 删除后用；读根不清空展开状态）。 */
  reloadDir: (path: string) => Promise<void>
}

export function useRailFiles(rootPath: string | null): RailFilesState {
  const [rootStatus, setRootStatus] = useState<RailRootStatus>(rootPath ? 'loading' : 'idle')
  const [rootEntries, setRootEntries] = useState<FileEntry[]>([])
  const [children, setChildren] = useState<Map<string, FileEntry[]>>(() => new Map())
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set())
  const [errorDirs, setErrorDirs] = useState<Set<string>>(() => new Set())

  const seqRef = useRef(0)
  const loadingRef = useRef<Set<string>>(new Set())
  /** 已加载 / 出错 / 正在读 —— ensureDir 用它在同步阶段就短路，避免重复 IPC。 */
  const childrenRef = useRef<Map<string, FileEntry[]>>(new Map())
  const errorRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    childrenRef.current = children
  }, [children])
  useEffect(() => {
    errorRef.current = new Set(errorDirs)
  }, [errorDirs])

  const loadRoot = useCallback(async () => {
    seqRef.current += 1
    const seq = seqRef.current
    loadingRef.current = new Set()
    childrenRef.current = new Map()
    errorRef.current = new Set()
    setChildren(new Map())
    setExpanded(new Set())
    setLoadingDirs(new Set())
    setErrorDirs(new Set())
    setRootEntries([])

    if (!rootPath) {
      setRootStatus('idle')
      return
    }
    setRootStatus('loading')
    try {
      await window.electronAPI?.authorize?.(rootPath)
    } catch {
      /* 授权失败留给 listDir 报错，这里不抢先下结论 */
    }
    if (seq !== seqRef.current) return
    try {
      const entries = await window.electronAPI.listDir(rootPath)
      if (seq !== seqRef.current) return
      setRootEntries(Array.isArray(entries) ? entries : [])
      setRootStatus('ready')
    } catch {
      if (seq !== seqRef.current) return
      setRootStatus('error')
    }
  }, [rootPath])

  useEffect(() => {
    void loadRoot()
    return () => {
      // 卸载 / 换根：让所有在途结果失效
      seqRef.current += 1
    }
  }, [loadRoot])

  const loadDir = useCallback(async (dirPath: string) => {
    if (!dirPath || loadingRef.current.has(dirPath)) return
    const seq = seqRef.current
    loadingRef.current.add(dirPath)
    setLoadingDirs(new Set(loadingRef.current))
    // 重试：先把旧的失败标记拿掉，占位行会换成 loading
    setErrorDirs((prev) => {
      if (!prev.has(dirPath)) return prev
      const next = new Set(prev)
      next.delete(dirPath)
      errorRef.current = next
      return next
    })
    try {
      const entries = await window.electronAPI.listDir(dirPath)
      if (seq !== seqRef.current) return
      const list = Array.isArray(entries) ? entries : []
      childrenRef.current = new Map(childrenRef.current).set(dirPath, list)
      setChildren((prev) => new Map(prev).set(dirPath, list))
    } catch {
      if (seq !== seqRef.current) return
      errorRef.current = new Set(errorRef.current).add(dirPath)
      setErrorDirs((prev) => new Set(prev).add(dirPath))
    } finally {
      loadingRef.current.delete(dirPath)
      if (seq === seqRef.current) setLoadingDirs(new Set(loadingRef.current))
    }
  }, [])

  const ensureDir = useCallback(
    (dirPath: string) => {
      if (!dirPath) return
      if (childrenRef.current.has(dirPath)) return
      if (errorRef.current.has(dirPath)) return
      if (loadingRef.current.has(dirPath)) return
      void loadDir(dirPath)
    },
    [loadDir],
  )

  const toggleDir = useCallback((entry: FileEntry) => {
    if (!entry.isDirectory) return
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(entry.path)) next.delete(entry.path)
      else next.add(entry.path)
      return next
    })
  }, [])

  const expandDir = useCallback((entry: FileEntry) => {
    if (!entry.isDirectory) return
    setExpanded((prev) => (prev.has(entry.path) ? prev : new Set(prev).add(entry.path)))
  }, [])

  const collapseDir = useCallback((entry: FileEntry) => {
    if (!entry.isDirectory) return
    setExpanded((prev) => {
      if (!prev.has(entry.path)) return prev
      const next = new Set(prev)
      next.delete(entry.path)
      return next
    })
  }, [])

  const retryRoot = useCallback(() => {
    void loadRoot()
  }, [loadRoot])

  const retryDir = useCallback(
    (dirPath: string) => {
      if (!dirPath) return
      setErrorDirs((prev) => {
        if (!prev.has(dirPath)) return prev
        const next = new Set(prev)
        next.delete(dirPath)
        errorRef.current = next
        return next
      })
      void loadDir(dirPath)
    },
    [loadDir],
  )

  const reloadDir = useCallback(
    async (dirPath: string) => {
      if (!rootPath || !dirPath) return
      if (dirPath === rootPath) {
        const seq = seqRef.current
        try {
          const entries = await window.electronAPI.listDir(rootPath)
          if (seq !== seqRef.current) return
          setRootEntries(Array.isArray(entries) ? entries : [])
          setRootStatus('ready')
        } catch {
          /* 保留现有树，等下一次刷新 */
        }
        return
      }
      await loadDir(dirPath)
    },
    [rootPath, loadDir],
  )

  const tree = useMemo(() => attachLoadedChildren(rootEntries, children), [rootEntries, children])

  return {
    tree,
    rootStatus,
    expanded,
    loadingDirs,
    errorDirs,
    toggleDir,
    expandDir,
    collapseDir,
    ensureDir,
    retryRoot,
    retryDir,
    reloadDir,
  }
}

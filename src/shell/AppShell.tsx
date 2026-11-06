import { useEffect } from 'react'
import MainLayout from '@/components/Layout/MainLayout'
import AgentShell from './agent/AgentShell'
import { useUIStore } from '@/stores/uiStore'
import './pure.css'

/**
 * 顶层壳切换（P0）：
 *  - `agent`     → 对话优先的 AgentShell（本次重写目标）
 *  - `workbench` → 现有 IDE 布局，MainLayout 原样保留，行为零变更
 *
 * 两套壳并存、flag 可回滚；Ctrl+Alt+M 随时切换，方便对比验收。
 */
export default function AppShell() {
  const uiMode = useUIStore((s) => s.uiMode)
  const setUiMode = useUIStore((s) => s.setUiMode)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'm') {
        e.preventDefault()
        setUiMode(useUIStore.getState().uiMode === 'agent' ? 'workbench' : 'agent')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [setUiMode])

  return uiMode === 'agent' ? <AgentShell /> : <MainLayout />
}

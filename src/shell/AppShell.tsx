import AgentShell from './agent/AgentShell'
import './pure.css'

/**
 * 顶层壳：只有对话优先的 AgentShell。
 *
 * new-ui 分支不保留旧的 IDE 布局（MainLayout）作为并列模式 —— 没有 uiMode、
 * 没有切换快捷键、没有第二条渲染路径。旧的 ChatPanel / MainLayout 组件文件
 * 仍留在仓库里供其它入口复用，但它们不再构成「另一种界面」。
 */
export default function AppShell() {
  return <AgentShell />
}

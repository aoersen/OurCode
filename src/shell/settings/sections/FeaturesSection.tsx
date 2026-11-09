import { useEditorStore } from '@/stores/editorStore'
import { useUIStore } from '@/stores/uiStore'
import { GroupLabel, Row, SectionHeading, TextAction } from '../settingsParts'
import ComputerUseSettings from './features/ComputerUseSettings'
import NoLimitsSettings from './features/NoLimitsSettings'
import PluginSettings from './features/PluginSettings'
import UpdateSettings from './features/UpdateSettings'

interface FeaturesSectionProps {
  onClose: () => void
}

/**
 * 「功能」：软件更新 / 渠道接入入口 / 插件 / 电脑操控 / 无限制模式 + 管理入口。
 *
 * 渠道接入在新壳里是右栏「管理 › 渠道」的一面，不是设置里的表单；这里只给
 * 只读状态与一个跳转，不重复造一套渠道开关（网关启停仍由渠道面板负责）。
 */
export default function FeaturesSection({ onClose }: FeaturesSectionProps) {
  const clawEnabled = useEditorStore((state) => state.preferences.clawEnabled)
  const clawApprovalMode = useEditorStore((state) => state.preferences.clawApprovalMode)
  const setArtifactPanelOpen = useUIStore((state) => state.setArtifactPanelOpen)
  const openSkillRegistry = useUIStore((state) => state.openSkillRegistry)
  const openMemoryManager = useUIStore((state) => state.openMemoryManager)

  const openChannelSurface = () => {
    setArtifactPanelOpen(true)
    onClose()
  }

  return (
    <div>
      <SectionHeading
        title="功能"
        hint="更新、渠道、插件、电脑操控与无限制模式；危险项默认关闭。"
      />

      <UpdateSettings />

      <GroupLabel trailing={clawEnabled === false ? '已关闭' : '已开启'}>渠道接入</GroupLabel>
      <Row
        label="渠道总开关"
        description={
          clawEnabled === false
            ? '全部渠道网关都不启动，渠道消息不处理'
            : '渠道网关随应用启动；具体渠道的扫码与状态在右栏「管理 › 渠道」查看'
        }
      />
      <Row
        label="会话审批模式"
        description={clawApprovalMode === 'full_access' ? '免审批（渠道任务直接执行）' : '逐条审批（默认）'}
      />
      <Row label="打开渠道面" description="关闭设置后在右栏查看渠道连接状态与最近消息">
        <TextAction onClick={openChannelSurface} label="打开右栏渠道面">
          打开右栏
        </TextAction>
      </Row>

      <PluginSettings />

      <ComputerUseSettings />

      <NoLimitsSettings />

      <GroupLabel>管理入口</GroupLabel>
      <Row label="技能管理" description="查看和启用 AI 技能（Slash 命令）">
        <TextAction
          onClick={() => {
            onClose()
            openSkillRegistry()
          }}
          label="打开技能管理"
        >
          打开
        </TextAction>
      </Row>
      <Row label="记忆管理" description="查看、搜索和删除长期记忆">
        <TextAction
          onClick={() => {
            onClose()
            openMemoryManager()
          }}
          label="打开记忆管理"
        >
          打开
        </TextAction>
      </Row>
    </div>
  )
}

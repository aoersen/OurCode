import { useEffect, useState } from 'react'

import { useEditorStore } from '@/stores/editorStore'
import { useUIStore } from '@/stores/uiStore'
import type { UserPreferences } from '@/types'
import { errorText } from '../errorText'
import {
  AUTO_SAVE_NOTE,
  countLanguageServers,
  formatLanguageServersText,
  parseLanguageServersText,
} from '../editorAiModel'
import { GroupLabel, Row, SectionHeading, Segmented, StatusLine, Switch, TextAction, TextArea } from '../settingsParts'

const TAB_SIZE_OPTIONS = [
  { value: '2', label: '2' },
  { value: '4', label: '4' },
  { value: '8', label: '8' },
]

/**
 * 「编辑器与 AI」：编辑器行为、AI 助手开关、语言服务（LSP）、请求日志。
 *
 * 除「自动保存」（本版本没有该偏好，见 editorAiModel.AUTO_SAVE_NOTE）外，
 * 每一行都直接写 editorStore 的 preferences，与旧面板同一批 key。
 */
export default function EditorAiSection() {
  const preferences = useEditorStore((state) => state.preferences)
  const savePreferences = useEditorStore((state) => state.savePreferences)
  const notify = useUIStore((state) => state.showNotification)

  const [lspText, setLspText] = useState(() => formatLanguageServersText(preferences.lspServers))
  const [logError, setLogError] = useState<string | null>(null)

  // 偏好被外部改动（例如另一处保存）时同步一次文本域，但不打断正在输入的内容
  useEffect(() => {
    setLspText(formatLanguageServersText(preferences.lspServers))
  }, [preferences.lspServers])

  const lspCount = countLanguageServers(preferences.lspServers)

  /** 写偏好；失败时给一次 toast（旧面板在界面上留错误行，这里统一成浮层）。 */
  const save = async (patch: Partial<UserPreferences>) => {
    try {
      await savePreferences(patch)
    } catch (error) {
      notify(errorText(error, '保存偏好失败'), 'error')
    }
  }

  const openLogDir = async () => {
    setLogError(null)
    try {
      const ok = await window.electronAPI.wireLogOpenDir()
      if (!ok) setLogError('未能打开日志目录（当前系统不支持）')
    } catch (error) {
      setLogError(errorText(error, '打开日志目录失败'))
    }
  }

  return (
    <div>
      <SectionHeading title="编辑器与 AI" hint="这些开关直接写本地偏好，无需重启。" />

      <GroupLabel>编辑器</GroupLabel>
      <Row label="显示缩略图" description="在编辑器右侧显示代码缩略导航图">
        <Switch
          label="显示缩略图"
          checked={preferences.showMinimap}
          onChange={(next) => void save({ showMinimap: next })}
        />
      </Row>
      <Row label="制表符大小" description="Tab 键对应的空格数">
        <Segmented
          label="制表符大小"
          value={String(preferences.tabSize)}
          options={TAB_SIZE_OPTIONS}
          onChange={(next) => void save({ tabSize: Number(next) })}
        />
      </Row>
      <Row label="对话历史编辑" description="开启后支持编辑消息、拖动排序和批量删除">
        <Switch
          label="对话历史编辑"
          checked={preferences.chatHistoryEditMode}
          onChange={(next) => void save({ chatHistoryEditMode: next })}
        />
      </Row>
      <Row label="显示隐藏文件" description="文件树里显示 . 开头的隐藏项">
        <Switch
          label="显示隐藏文件"
          checked={preferences.showHiddenFiles}
          onChange={(next) => void save({ showHiddenFiles: next })}
        />
      </Row>

      <GroupLabel>保存</GroupLabel>
      <Row label="自动保存" description={AUTO_SAVE_NOTE} />

      <GroupLabel>AI 助手</GroupLabel>
      <Row label="允许自动记忆" description="AI 可以把对话里值得沉淀的信息写入长期记忆">
        <Switch
          label="允许自动记忆"
          checked={preferences.aiAutoMemory}
          onChange={(next) => void save({ aiAutoMemory: next })}
        />
      </Row>
      <Row label="LLM 响应缓存" description="相同请求复用上次结果，不再调用 API（仅确定性请求）">
        <Switch
          label="LLM 响应缓存"
          checked={preferences.llmResponseCache}
          onChange={(next) => void save({ llmResponseCache: next })}
        />
      </Row>
      <Row label="Anthropic 提示词缓存" description="重复的历史内容按缓存价计费（约 1/10）">
        <Switch
          label="Anthropic 提示词缓存"
          checked={preferences.anthropicPromptCache}
          onChange={(next) => void save({ anthropicPromptCache: next })}
        />
      </Row>
      <Row label="上下文压缩" description="接近窗口上限时把较早历史压成摘要（原始消息不删除）">
        <Switch
          label="上下文压缩"
          checked={preferences.contextCompaction !== false}
          onChange={(next) => void save({ contextCompaction: next })}
        />
      </Row>
      <Row label="提问自动继续" description="提问默认 5 分钟倒计时；超时后 AI 按自己的判断继续">
        <Switch
          label="提问自动继续"
          checked={preferences.questionAutoContinue !== false}
          onChange={(next) => void save({ questionAutoContinue: next })}
        />
      </Row>
      <Row label="请求自动重试" description="瞬时失败（超时 / 网络 / 限流 / 5xx）自动重试">
        <Switch
          label="请求自动重试"
          checked={preferences.llmRetryEnabled !== false}
          onChange={(next) => void save({ llmRetryEnabled: next })}
        />
      </Row>

      <GroupLabel trailing={lspCount > 0 ? `已配置 ${lspCount} 个` : undefined}>语言服务</GroupLabel>
      <Row
        label="LSP 服务器"
        description="每行一条「语言ID: 启动命令」，失焦即保存；留空则关闭该语言的语言服务"
        stacked
      >
        <TextArea
          label="LSP 服务器"
          mono
          rows={4}
          value={lspText}
          onChange={(event) => setLspText(event.target.value)}
          onBlur={() => void save({ lspServers: parseLanguageServersText(lspText) })}
          placeholder={'python: pylsp\ngo: gopls -mode stdio\nrust: rust-analyzer'}
        />
      </Row>

      <GroupLabel>日志</GroupLabel>
      <Row
        label="模型请求日志"
        description="把每次模型请求（脱敏）写进本地日志；内容是明文，排查完建议关闭"
      >
        <TextAction onClick={() => void openLogDir()} label="打开日志目录">
          打开日志目录
        </TextAction>
        <Switch
          label="模型请求日志"
          checked={preferences.wireLogEnabled !== false}
          onChange={(next) => void save({ wireLogEnabled: next })}
        />
      </Row>
      {logError ? (
        <div className="pt-1">
          <StatusLine tone="error">{logError}</StatusLine>
        </div>
      ) : null}
    </div>
  )
}

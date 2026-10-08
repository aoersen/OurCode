/**
 * 微信 Agent 模型切换（跨组全局解析）。
 *
 * 用户说「切换到 XXX」时，模型可能在任何配置组里——切换逻辑在所有组中查找：
 * 当前组优先，否则切到第一个包含该模型的组（同时更新 configGroupId + modelId，
 * 避免旧组模型绑新组密钥 401 的问题）。工具（wechat_models）与 /model 命令共用。
 */
import { useConfigStore } from '@/stores/configStore'
import { useWechatStore } from '@/stores/wechatStore'
import type { ApiConfigGroup } from '@/types'

/** 拉取某组可用模型 id 列表（含默认模型；拉取失败时退化为默认模型）。 */
export async function listGroupModelIds(group: ApiConfigGroup): Promise<string[]> {
  try {
    const ids = (await useConfigStore.getState().fetchModelsForGroup(group)).map((m) => m.id)
    return Array.from(new Set([...(group.defaultModel ? [group.defaultModel] : []), ...ids]))
  } catch {
    return group.defaultModel ? [group.defaultModel] : []
  }
}

/** 当前组 id（AgentState → IDE 当前组 → 第一个组）。 */
export function currentGroupId(): string {
  const st = useWechatStore.getState().agentState
  const cfg = useConfigStore.getState()
  const groups = cfg.configGroups ?? []
  return st?.configGroupId?.trim() || cfg.activeConfigGroupId || groups[0]?.id || ''
}

/**
 * 跨组切换模型：返回给用户的结果文本。未找到时列出全部组的可用模型。
 */
export async function switchWechatModel(modelId: string): Promise<string> {
  const cfg = useConfigStore.getState()
  const groups = cfg.configGroups ?? []
  if (groups.length === 0) return '没有可用的 API 配置组，无法切换模型'
  const activeGroup = currentGroupId()
  const hits: Array<{ group: ApiConfigGroup; ids: string[] }> = []
  for (const g of groups) {
    const ids = await listGroupModelIds(g)
    if (ids.includes(modelId)) hits.push({ group: g, ids })
  }
  if (hits.length === 0) {
    const all: string[] = []
    for (const g of groups) {
      const ids = await listGroupModelIds(g)
      all.push(`${g.name}：${ids.join('、') || '（获取失败）'}`)
    }
    return `模型 ${modelId} 不在任何配置组中。可用：\n${all.join('\n')}`
  }
  const hit = hits.find((h) => h.group.id === activeGroup) ?? hits[0]
  await useWechatStore.getState().saveAgentState({ configGroupId: hit.group.id, modelId })
  return hit.group.id === activeGroup
    ? `已切换模型：${modelId}（${hit.group.name}）`
    : `已切换到「${hit.group.name}」组的模型：${modelId}`
}

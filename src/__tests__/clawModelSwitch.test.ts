import { describe, it, expect, beforeEach, vi } from 'vitest'

import { switchClawModel } from '@/services/claw/modelSwitch'
import { useConfigStore } from '@/stores/configStore'
import { useClawStore } from '@/stores/clawStore'
import type { ApiConfigGroup, ClawAgentState } from '@/types'

vi.stubGlobal('window', {
  electronAPI: {
    saveClawAgentState: vi.fn(async () => ({ ok: true })),
  },
})

const AGENT_STATE: ClawAgentState = {
  sandboxPath: 'C:\\sandbox',
  currentWorkspace: null,
  approvalMode: 'approve',
  configGroupId: 'g-longcat',
  modelId: 'longcat-2',
  memory: [],
  updatedAt: 0,
}

function makeGroup(id: string, name: string, defaultModel: string): ApiConfigGroup {
  return {
    id,
    name,
    baseUrl: 'https://api.example.com',
    apiKey: 'sk-test',
    systemPrompt: '',
    defaultModel,
    provider: 'custom',
    customHeaders: {},
    createdAt: 0,
    updatedAt: 0,
  }
}

beforeEach(() => {
  useClawStore.setState({ agentState: AGENT_STATE })
  useConfigStore.setState({
    configGroups: [
      makeGroup('g-longcat', 'longcat', 'longcat-2'),
      makeGroup('g-deepseek', '公司DeepSeek', 'deepseek-v3'),
    ],
    activeConfigGroupId: 'g-longcat',
    fetchModelsForGroup: vi.fn(async (g: ApiConfigGroup) =>
      g.id === 'g-deepseek'
        ? [{ id: 'deepseek-flash', name: 'deepseek-flash', isFree: false, isFavorite: false }, { id: 'deepseek-v3', name: 'deepseek-v3', isFree: false, isFavorite: false }]
        : [{ id: 'longcat-2', name: 'longcat-2', isFree: false, isFavorite: false }],
    ),
  })
})

describe('clawModelSwitch 跨组切换（AgentState 全渠道共享）', () => {
  it('模型在另一个组：自动切组并绑定模型', async () => {
    const result = await switchClawModel('deepseek-flash')
    expect(result).toContain('公司DeepSeek')
    const st = useClawStore.getState().agentState
    expect(st?.configGroupId).toBe('g-deepseek')
    expect(st?.modelId).toBe('deepseek-flash')
  })

  it('模型在当前组：保持组不变', async () => {
    const result = await switchClawModel('longcat-2')
    expect(result).toContain('已切换模型')
    const st = useClawStore.getState().agentState
    expect(st?.configGroupId).toBe('g-longcat')
  })

  it('模型不存在：报错并列出全部组的可用模型', async () => {
    const result = await switchClawModel('no-such-model')
    expect(result).toContain('不在任何配置组中')
    expect(result).toContain('deepseek-flash')
    expect(result).toContain('longcat-2')
  })
})

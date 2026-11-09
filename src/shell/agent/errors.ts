/**
 * 错误分类：把 provider / 网络 / 上下文这几类最常见的失败翻译成
 * 「一句人话 + 一个能做的事」，供消息流里的错误卡使用。
 *
 * 纯函数，不依赖 React / store，方便单测。
 */

export type ErrorKind = 'auth' | 'context' | 'network' | 'rate' | 'other'

export interface ErrorView {
  kind: ErrorKind
  /** 一句话说明（中文，面向用户，不提 provider 内部细节） */
  hint: string
  /** 建议动作：无 = 只展示 */
  action: 'settings' | 'retry' | 'newSession' | null
  actionLabel: string | null
}

const AUTH = /(401|403|api[_\s-]?key|unauthori[sz]ed|invalid[_\s-]?key|鉴权|密钥|未配置)/i
const CONTEXT = /(context[_\s-]?length|too\s+long|max[_\s-]?tokens|context\s+window|上下文|超出.*长度|token.*超)/i
const RATE = /(429|rate[_\s-]?limit|too\s+many\s+requests|频率|限流)/i
const NETWORK = /(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|network|socket|连接|超时|断网)/i

export function classifyError(message: string | undefined | null): ErrorView {
  const text = (message ?? '').trim()

  if (AUTH.test(text)) {
    return {
      kind: 'auth',
      hint: '模型服务没有通过鉴权：检查 API Key 与 Base URL。',
      action: 'settings',
      actionLabel: '打开设置',
    }
  }
  if (CONTEXT.test(text)) {
    return {
      kind: 'context',
      hint: '这次请求超出了模型的上下文窗口，开一个新会话或压缩历史再试。',
      action: 'newSession',
      actionLabel: '新建会话',
    }
  }
  if (RATE.test(text)) {
    return {
      kind: 'rate',
      hint: '触发服务商的频率限制，稍等一会儿再重试。',
      action: 'retry',
      actionLabel: '重试',
    }
  }
  if (NETWORK.test(text)) {
    return {
      kind: 'network',
      hint: '连接不上模型服务：检查网络 / 代理，或服务是否在运行。',
      action: 'retry',
      actionLabel: '重试',
    }
  }
  return {
    kind: 'other',
    hint: text || '请求失败。',
    action: 'retry',
    actionLabel: '重试',
  }
}

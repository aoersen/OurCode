// Draft → full ApiConfigGroup conversion.
//
// The settings editor keeps a *partial* group while the user types (new group,
// unsaved edits). Connection test / model fetch run against that draft, so this
// conversion must carry **every** field the request path reads — a dropped field
// silently downgrades the request (e.g. a lost `skipTlsVerify` turns an intranet
// self-signed endpoint into "HTTPS 证书校验失败" even though the user ticked the
// box). Keep this list in sync with ApiConfigGroup.
import type { ApiConfigGroup } from '@/types'

export function toFullConfigGroup(group: Partial<ApiConfigGroup>, now: number = Date.now()): ApiConfigGroup {
  return {
    id: group.id || 'draft',
    name: group.name || '未命名配置',
    baseUrl: (group.baseUrl || '').trim(),
    apiKey: (group.apiKey || '').trim(),
    systemPrompt: group.systemPrompt || '',
    defaultModel: (group.defaultModel || '').trim(),
    provider: (group.provider || 'openai') as ApiConfigGroup['provider'],
    apiFormat: group.apiFormat,
    customHeaders: group.customHeaders || {},
    // Renderer → main TLS bypass flag. Must survive the draft round-trip:
    // without it the main process never registers the host in tlsDraftHosts.
    skipTlsVerify: group.skipTlsVerify === true,
    color: group.color,
    sortOrder: group.sortOrder,
    createdAt: group.createdAt ?? now,
    updatedAt: now,
  }
}

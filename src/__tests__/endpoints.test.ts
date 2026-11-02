import { describe, it, expect } from 'vitest'
import { buildChatUrl, buildModelsUrl, buildEndpointUrl, resolveFormat, PROVIDER_REGISTRY } from '@/services/llm/endpoints'

describe('buildChatUrl — openai (chat completions)', () => {
  it('appends /chat/completions when base already ends with /v1', () => {
    expect(buildChatUrl('https://api.openai.com/v1', 'openai')).toBe('https://api.openai.com/v1/chat/completions')
  })

  it('appends /v1/chat/completions for a bare host (gateway)', () => {
    expect(buildChatUrl('http://gateway:8000', 'openai')).toBe('http://gateway:8000/v1/chat/completions')
  })

  it('keeps a base that already contains the full endpoint path', () => {
    expect(buildChatUrl('http://host/v1/chat/completions', 'openai')).toBe('http://host/v1/chat/completions')
  })

  it('tolerates trailing slashes', () => {
    expect(buildChatUrl('https://api.openai.com/v1/', 'openai')).toBe('https://api.openai.com/v1/chat/completions')
  })

  it('buildEndpointUrl is an alias of buildChatUrl', () => {
    expect(buildEndpointUrl('https://api.openai.com/v1', 'openai')).toBe(buildChatUrl('https://api.openai.com/v1', 'openai'))
  })
})

describe('buildChatUrl — vendor base URLs from the catalog', () => {
  it('appends /chat/completions to versioned roots other than /v1', () => {
    expect(buildChatUrl('https://open.bigmodel.cn/api/paas/v4', 'openai'))
      .toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions')
    expect(buildChatUrl('https://ark.cn-beijing.volces.com/api/v3', 'openai'))
      .toBe('https://ark.cn-beijing.volces.com/api/v3/chat/completions')
    expect(buildChatUrl('https://qianfan.baidubce.com/v2', 'openai'))
      .toBe('https://qianfan.baidubce.com/v2/chat/completions')
  })

  it('understands /v1/openai and bare /openai roots', () => {
    expect(buildChatUrl('https://api.deepinfra.com/v1/openai', 'openai'))
      .toBe('https://api.deepinfra.com/v1/openai/chat/completions')
    expect(buildChatUrl('https://api.longcat.chat/openai', 'openai'))
      .toBe('https://api.longcat.chat/openai/v1/chat/completions')
    expect(buildChatUrl('https://api.novita.ai/openai', 'openai'))
      .toBe('https://api.novita.ai/openai/v1/chat/completions')
  })

  it('keeps hosts that serve chat completions at the root', () => {
    expect(buildChatUrl('https://api.perplexity.ai', 'openai'))
      .toBe('https://api.perplexity.ai/chat/completions')
    expect(buildChatUrl('https://models.inference.ai.azure.com', 'openai'))
      .toBe('https://models.inference.ai.azure.com/chat/completions')
  })

  it('derives model-list URLs with the same root rules', () => {
    expect(buildModelsUrl('https://open.bigmodel.cn/api/paas/v4', 'openai'))
      .toBe('https://open.bigmodel.cn/api/paas/v4/models')
    expect(buildModelsUrl('https://api.longcat.chat/openai', 'openai'))
      .toBe('https://api.longcat.chat/openai/v1/models')
  })
})

describe('buildChatUrl — responses', () => {
  it('appends /responses when base already ends with /v1', () => {
    expect(buildChatUrl('https://api.openai.com/v1', 'responses')).toBe('https://api.openai.com/v1/responses')
  })

  it('appends /v1/responses for a bare host (gateway)', () => {
    expect(buildChatUrl('http://gateway:8000', 'responses')).toBe('http://gateway:8000/v1/responses')
  })

  it('keeps a base that already contains the full endpoint path', () => {
    expect(buildChatUrl('http://host/v1/responses', 'responses')).toBe('http://host/v1/responses')
  })
})

describe('buildChatUrl — anthropic (messages)', () => {
  it('appends /messages when base ends with /anthropic/v1 (gateway style)', () => {
    expect(buildChatUrl('http://gateway:8000/anthropic/v1', 'anthropic')).toBe('http://gateway:8000/anthropic/v1/messages')
  })

  it('appends /anthropic/v1/messages for a bare non-official host (gateway)', () => {
    expect(buildChatUrl('http://gateway:8000', 'anthropic')).toBe('http://gateway:8000/anthropic/v1/messages')
  })

  it('appends /v1/messages for the official api.anthropic.com bare host', () => {
    expect(buildChatUrl('https://api.anthropic.com', 'anthropic')).toBe('https://api.anthropic.com/v1/messages')
  })

  it('appends /messages when base ends with /v1 (official api.anthropic.com)', () => {
    expect(buildChatUrl('https://api.anthropic.com/v1', 'anthropic')).toBe('https://api.anthropic.com/v1/messages')
  })

  it('keeps a base that already contains the full endpoint path', () => {
    expect(buildChatUrl('http://host/anthropic/v1/messages', 'anthropic')).toBe('http://host/anthropic/v1/messages')
  })
})

describe('buildChatUrl — gemini', () => {
  it('appends /v1beta/models/{model}:generateContent for a bare host', () => {
    expect(buildChatUrl('https://generativelanguage.googleapis.com', 'gemini', 'gemini-2.0-flash'))
      .toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent')
  })

  it('does not duplicate a /v1beta prefix', () => {
    expect(buildChatUrl('https://generativelanguage.googleapis.com/v1beta', 'gemini', 'gemini-1.5-pro'))
      .toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent')
  })

  it('uses a {model} placeholder when model is omitted (preview)', () => {
    expect(buildChatUrl('https://generativelanguage.googleapis.com', 'gemini')).toContain('/v1beta/models/{model}:generateContent')
  })
})

describe('buildChatUrl — ollama', () => {
  it('appends /api/chat for a bare host', () => {
    expect(buildChatUrl('http://localhost:11434', 'ollama')).toBe('http://localhost:11434/api/chat')
  })

  it('does not duplicate an /api prefix', () => {
    expect(buildChatUrl('http://localhost:11434/api', 'ollama')).toBe('http://localhost:11434/api/chat')
  })
})

describe('buildChatUrl — azure', () => {
  it('builds the deployments URL with the model as deployment name', () => {
    expect(buildChatUrl('https://my-resource.openai.azure.com', 'azure', 'gpt-4o'))
      .toBe('https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-06-01')
  })

  it('does not duplicate an /openai prefix', () => {
    expect(buildChatUrl('https://my-resource.openai.azure.com/openai', 'azure', 'gpt-4o'))
      .toBe('https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-06-01')
  })
})

describe('buildModelsUrl', () => {
  it('openai: appends /models when base already ends with /v1', () => {
    expect(buildModelsUrl('https://api.openai.com/v1', 'openai')).toBe('https://api.openai.com/v1/models')
  })

  it('openai: appends /v1/models for a bare host (gateway)', () => {
    expect(buildModelsUrl('http://gateway:8000', 'openai')).toBe('http://gateway:8000/v1/models')
  })

  it('openai: keeps a base that already contains the models endpoint', () => {
    expect(buildModelsUrl('http://host/v1/models', 'openai')).toBe('http://host/v1/models')
  })

  it('openai: derives the models URL from a full chat-completions base', () => {
    expect(buildModelsUrl('https://api.longcat.chat/v1/chat/completions', 'openai')).toBe('https://api.longcat.chat/v1/models')
    expect(buildModelsUrl('https://api.longcat.chat/openai/v1/chat/completions', 'openai')).toBe('https://api.longcat.chat/openai/v1/models')
  })

  it('responses: derives the models URL from a full responses base', () => {
    expect(buildModelsUrl('https://api.openai.com/v1/responses', 'responses')).toBe('https://api.openai.com/v1/models')
  })

  it('responses: reuses the /v1/models endpoint', () => {
    expect(buildModelsUrl('https://api.openai.com/v1', 'responses')).toBe('https://api.openai.com/v1/models')
  })

  it('gemini: builds /v1beta/models without duplicating the prefix', () => {
    expect(buildModelsUrl('https://generativelanguage.googleapis.com', 'gemini')).toBe('https://generativelanguage.googleapis.com/v1beta/models')
    expect(buildModelsUrl('https://generativelanguage.googleapis.com/v1beta', 'gemini')).toBe('https://generativelanguage.googleapis.com/v1beta/models')
  })

  it('ollama: builds /api/tags without duplicating the prefix', () => {
    expect(buildModelsUrl('http://localhost:11434', 'ollama')).toBe('http://localhost:11434/api/tags')
    expect(buildModelsUrl('http://localhost:11434/api', 'ollama')).toBe('http://localhost:11434/api/tags')
  })

  it('azure: builds the deployments list endpoint', () => {
    expect(buildModelsUrl('https://my-resource.openai.azure.com', 'azure')).toBe('https://my-resource.openai.azure.com/openai/deployments?api-version=2024-06-01')
  })

  it('anthropic: returns null (no public model-list endpoint)', () => {
    expect(buildModelsUrl('https://api.anthropic.com', 'anthropic')).toBeNull()
  })
})

describe('resolveFormat', () => {
  it('returns the provider native format when apiFormat is unset/auto', () => {
    expect(resolveFormat('anthropic')).toBe('anthropic')
    expect(resolveFormat('deepseek', 'auto')).toBe('openai')
    expect(resolveFormat('ollama', undefined)).toBe('ollama')
    expect(resolveFormat('azure', 'auto')).toBe('azure')
  })

  it('explicit format override wins', () => {
    expect(resolveFormat('anthropic', 'openai')).toBe('openai')
    expect(resolveFormat('deepseek', 'responses')).toBe('responses')
  })

  it('falls back to openai for unknown providers', () => {
    expect(resolveFormat('nonsense')).toBe('openai')
  })
})

describe('PROVIDER_REGISTRY', () => {
  it('every provider has a native format and default base url', () => {
    for (const p of PROVIDER_REGISTRY) {
      expect(p.nativeFormat).toBeTruthy()
      expect(typeof p.defaultBaseUrl).toBe('string')
    }
  })
})

#!/usr/bin/env node
/**
 * Regenerate shared/model-catalog.json from https://models.dev/api.json.
 *
 * The upstream catalog is the community-maintained model/provider database
 * (context window, max output, modalities, tool calling, reasoning levels and
 * each vendor's OpenAI-compatible endpoint). We compact it so the renderer can
 * bundle it: models share one global id-keyed table (deduped across the 200+
 * providers that resell them), providers keep their endpoint metadata.
 *
 * Usage:
 *   node scripts/generate-model-catalog.mjs                # download latest
 *   node scripts/generate-model-catalog.mjs <api.json>     # use a local snapshot
 *
 * The output is committed, builds never touch the network.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'shared', 'model-catalog.json')
const CACHE = join(ROOT, '.tmp', 'models-dev.json')
const SOURCE = 'https://models.dev/api.json'

/** input/output modality bit order — keep in sync with shared/modelCatalog.ts */
const MODALITIES = ['text', 'image', 'audio', 'video', 'pdf']
/** capability bit order — keep in sync with shared/modelCatalog.ts */
const CAPS = ['tool_call', 'structured_output', 'reasoning', 'attachment']
/** reasoning effort bit order — keep in sync with shared/modelCatalog.ts */
const EFFORTS = ['low', 'medium', 'high', 'max']

const maskOf = (values, all) => all.reduce((acc, v, i) => acc | (values?.includes(v) ? 1 << i : 0), 0)

/**
 * Direct vendors first: when several providers list the same model id (gateways
 * resell vendor models), the vendor's own row should win the dedupe.
 */
const PROVIDER_PRIORITY = [
  'openai', 'anthropic', 'google', 'xai', 'deepseek', 'moonshotai', 'zhipuai', 'alibaba',
  'minimax', 'mistral', 'cohere', 'groq', 'cerebras', 'nvidia', 'longcat', 'agnes',
  'meta', 'microsoft', 'amazon-bedrock', 'google-vertex', 'stepfun-ai', 'volcengine',
  'siliconflow', 'modelscope', 'qiniu-ai', 'xiaomi', 'tencent-tokenhub', 'sensenova',
  'novita-ai', 'togetherai', 'ai21', 'perplexity', 'deepinfra', 'fireworks-ai',
]

/** Endpoints upstream omits because the AI SDK hardcodes them. */
const API_OVERRIDES = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com',
  xai: 'https://api.x.ai/v1',
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
  cohere: 'https://api.cohere.ai/compatibility/v1',
  perplexity: 'https://api.perplexity.ai',
  cerebras: 'https://api.cerebras.ai/v1',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  togetherai: 'https://api.together.xyz/v1',
  vercel: 'https://ai-gateway.vercel.sh/v1',
  'google-vertex': '',
  'google-vertex-anthropic': '',
  'amazon-bedrock': '',
  'cloudflare-ai-gateway': '',
  azure: 'https://{resource}.openai.azure.com',
  'azure-cognitive-services': 'https://{resource}.openai.azure.com',
}

/**
 * Vendors models.dev does not track (or tracks only through a reseller).
 * Endpoints are from the vendors' own OpenAI-compatible API docs.
 */
const MANUAL_PROVIDERS = {
  ollama: {
    name: 'Ollama (Local)', api: 'http://localhost:11434', format: 'ollama',
    doc: 'https://docs.ollama.com/api/openai-compatibility', models: [],
  },
  together: {
    name: 'Together AI', api: 'https://api.together.xyz/v1', format: 'openai',
    doc: 'https://docs.together.ai/docs/openai-api-compatibility', models: [],
  },
  'github-models': {
    name: 'GitHub Models', api: 'https://models.inference.ai.azure.com', format: 'openai',
    doc: 'https://docs.github.com/en/github-models', models: [],
  },
  'baidu-qianfan': {
    name: 'Baidu Qianfan (ERNIE)', api: 'https://qianfan.baidubce.com/v2', format: 'openai',
    doc: 'https://cloud.baidu.com/doc/qianfan-api/index.html', models: [],
  },
  'tencent-hunyuan': {
    name: 'Tencent Hunyuan', api: 'https://api.hunyuan.cloud.tencent.com/v1', format: 'openai',
    doc: 'https://cloud.tencent.com/document/product/1729', models: [],
  },
  'iflytek-spark': {
    name: 'iFlytek Spark', api: 'https://spark-api-open.xf-yun.com/v1', format: 'openai',
    doc: 'https://www.xfyun.cn/doc/spark/HTTP%E8%B0%83%E7%94%A8%E6%96%87%E6%A1%A3.html', models: [],
  },
  '01-ai': {
    name: '01.AI (Yi)', api: 'https://api.lingyiwanwu.com/v1', format: 'openai',
    doc: 'https://platform.lingyiwanwu.com/docs', models: [],
  },
  baichuan: {
    name: 'Baichuan', api: 'https://api.baichuan-ai.com/v1', format: 'openai',
    doc: 'https://platform.baichuan-ai.com/docs/api', models: [],
  },
  internlm: {
    name: 'InternLM', api: 'https://internlm.intern-ai.org.cn/api/v1', format: 'openai',
    doc: 'https://internlm.intern-ai.org.cn/api/document', models: [],
  },
  'openbmb': {
    name: 'OpenBMB (ModelBest)', api: 'https://api.modelbest.cn/v1', format: 'openai',
    doc: 'https://platform.modelbest.cn', models: [],
  },
}

function formatFromNpm(npm = '') {
  if (npm.includes('amazon-bedrock')) return 'unsupported'
  if (npm.includes('google-vertex')) return 'unsupported'
  if (npm.includes('anthropic')) return 'anthropic'
  if (npm.includes('google')) return 'gemini'
  if (npm.includes('azure')) return 'azure'
  if (npm.includes('ollama')) return 'ollama'
  if (npm.includes('openai')) return 'openai'
  return 'openai'
}

function encodeModel(m) {
  const efforts = (m.reasoning_options || []).flatMap((o) => o.values || [])
  const row = [
    m.name && m.name !== m.id ? m.name : 0,
    m.limit?.context || 0,
    m.limit?.output || 0,
    maskOf(m.modalities?.input, MODALITIES),
    maskOf(m.modalities?.output, MODALITIES),
    (m.tool_call ? 1 : 0) | (m.structured_output ? 2 : 0) | (m.reasoning ? 4 : 0) | (m.attachment ? 8 : 0),
    maskOf(efforts, EFFORTS),
    m.release_date ? m.release_date.slice(0, 7) : 0,
  ]
  while (row.length && row[row.length - 1] === 0) row.pop()
  return row
}

/** Chat-ish models worth suggesting when a provider is picked. */
function topModels(provider) {
  return Object.values(provider.models || {})
    .filter((m) => !m.status || m.status === 'beta')
    .filter((m) => !m.type || m.type === 'chat')
    .sort((a, b) => String(b.release_date || '').localeCompare(String(a.release_date || '')))
    .slice(0, 8)
    .map((m) => m.id)
}

async function loadUpstream(localPath) {
  if (localPath) return JSON.parse(await readFile(localPath, 'utf8'))
  if (existsSync(CACHE)) {
    const stat = await readFile(CACHE, 'utf8')
    if (stat.length > 100_000) return JSON.parse(stat)
  }
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`fetch ${SOURCE} -> HTTP ${res.status}`)
  const text = await res.text()
  await mkdir(dirname(CACHE), { recursive: true })
  await writeFile(CACHE, text, 'utf8')
  return JSON.parse(text)
}

async function main() {
  const upstream = await loadUpstream(process.argv[2])

  const models = {}
  // lowercase id → { providerId, id } — vendors and resellers spell ids with
  // different casing (`LongCat-2.0` vs `longcat-2.0`), and both variants would
  // otherwise survive as separate rows.
  const modelOwner = {}
  for (const [providerId, provider] of Object.entries(upstream)) {
    for (const [modelId, model] of Object.entries(provider.models || {})) {
      const key = modelId.toLowerCase()
      const previous = modelOwner[key]
      if (!previous) {
        models[modelId] = encodeModel(model)
        modelOwner[key] = { providerId, id: modelId }
        continue
      }
      const nextRank = PROVIDER_PRIORITY.indexOf(providerId)
      const prevRank = PROVIDER_PRIORITY.indexOf(previous.providerId)
      // A direct vendor row beats a gateway/reseller row; otherwise keep first.
      if (nextRank >= 0 && (prevRank < 0 || nextRank < prevRank)) {
        delete models[previous.id]
        models[modelId] = encodeModel(model)
        modelOwner[key] = { providerId, id: modelId }
      }
    }
  }

  const providers = {}
  for (const [providerId, provider] of Object.entries(upstream)) {
    const api = provider.api || API_OVERRIDES[providerId] || ''
    providers[providerId] = [
      provider.name || providerId,
      api,
      provider.doc || '',
      formatFromNpm(provider.npm),
      topModels(provider),
    ]
  }

  for (const [id, p] of Object.entries(MANUAL_PROVIDERS)) {
    providers[id] = [p.name, p.api, p.doc, p.format, p.models]
    for (const mid of p.models) {
      if (!models[mid]) models[mid] = [0, 0, 0, 1, 1]
    }
  }

  const payload = {
    meta: {
      source: SOURCE,
      generatedAt: new Date().toISOString().slice(0, 10),
      modelCount: Object.keys(models).length,
      providerCount: Object.keys(providers).length,
    },
    models,
    providers,
  }

  await writeFile(OUT, JSON.stringify(payload), 'utf8')
  console.log(`wrote ${OUT} (${(JSON.stringify(payload).length / 1024).toFixed(0)} KB): ${payload.meta.modelCount} models / ${payload.meta.providerCount} providers`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

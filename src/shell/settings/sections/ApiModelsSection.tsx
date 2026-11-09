import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'

import { useConfigStore, type ConnectionStep, type ConnectionTestResult } from '@/stores/configStore'
import { useUIStore } from '@/stores/uiStore'
import type { CustomModel, ModelInfo } from '@/types'
import { FORMAT_META, PROVIDER_REGISTRY, getProviderMeta, resolveFormat } from '@/services/llm/endpoints'
import { toFullConfigGroup } from '@/services/llm/configDraft'
import { MODEL_CATALOG_META, getCatalogModel, getCatalogProvider, listCatalogProviders } from '@shared/modelCatalog'
import {
  FORMAT_OVERRIDES,
  applyCatalogPreset,
  countHeaderLines,
  describeDraftDiff,
  draftDiff,
  draftFromGroup,
  emptyDraftForProvider,
  formatHeadersText,
  isFormatOverrideRisky,
  modelSpecLine,
  parseHeadersText,
  validateDraftForSave,
  validateDraftForTest,
  type ApiDraft,
} from '../apiDraft'
import { errorText } from '../errorText'
import {
  GroupLabel,
  Row,
  SectionHeading,
  SelectField,
  Segmented,
  StatusLine,
  Switch,
  TextAction,
  TextArea,
  TextInput,
} from '../settingsParts'

interface ApiModelsSectionProps {
  /** 面板级的 ⌘/Ctrl+Enter 保存钩子（只有表单有改动时才真的写盘） */
  saveHandlerRef: MutableRefObject<(() => void) | null>
}

function customToModelInfo(model: CustomModel): ModelInfo {
  return {
    id: model.id,
    name: model.name,
    isFree: false,
    isFavorite: false,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    inputModalities: model.inputModalities,
    outputModalities: model.outputModalities,
    capabilities: model.capabilities,
    reasoningLevels: model.reasoningLevels,
    vision: model.vision,
    functionCall: model.functionCall,
  }
}

/**
 * 「API 与模型」：配置列表 + 单条编辑。
 *
 * 所有写入都走 configStore 的既有 action（create/update/delete/import/export、
 * testConnectionGroup、fetchModelsForGroup、upsert/removeCustomModel），没有新增
 * 持久化通道。校验、脏值比较、目录预设套用是 ../apiDraft 里的纯函数。
 */
export default function ApiModelsSection({ saveHandlerRef }: ApiModelsSectionProps) {
  const configGroups = useConfigStore((s) => s.configGroups)
  const activeConfigGroupId = useConfigStore((s) => s.activeConfigGroupId)
  const models = useConfigStore((s) => s.models)
  const customModels = useConfigStore((s) => s.customModels)
  const loadConfigGroups = useConfigStore((s) => s.loadConfigGroups)
  const createConfigGroup = useConfigStore((s) => s.createConfigGroup)
  const updateConfigGroup = useConfigStore((s) => s.updateConfigGroup)
  const deleteConfigGroup = useConfigStore((s) => s.deleteConfigGroup)
  const fetchModelsForGroup = useConfigStore((s) => s.fetchModelsForGroup)
  const testConnectionGroup = useConfigStore((s) => s.testConnectionGroup)
  const upsertCustomModel = useConfigStore((s) => s.upsertCustomModel)
  const removeCustomModel = useConfigStore((s) => s.removeCustomModel)
  const notify = useUIStore((s) => s.showNotification)

  const [draft, setDraft] = useState<ApiDraft | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [newProvider, setNewProvider] = useState('openai')
  const [headersText, setHeadersText] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState(false)
  const [presetId, setPresetId] = useState('')

  const [editorModels, setEditorModels] = useState<ModelInfo[]>([])
  const [fetchingModels, setFetchingModels] = useState(false)
  const [modelFetchError, setModelFetchError] = useState<string | null>(null)
  const [newModelName, setNewModelName] = useState('')
  const [newContextWindow, setNewContextWindow] = useState('')
  const [newMaxOutput, setNewMaxOutput] = useState('')

  const [testing, setTesting] = useState(false)
  const [testSteps, setTestSteps] = useState<ConnectionStep[]>([])
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null)

  const [backupMode, setBackupMode] = useState<'import' | 'export' | null>(null)
  const [backupPassword, setBackupPassword] = useState('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    void loadConfigGroups()
  }, [loadConfigGroups])

  const providerPresets = useMemo(
    () => listCatalogProviders().filter((provider) => provider.api && provider.format !== 'unsupported'),
    [],
  )

  const currentDraft = useMemo<ApiDraft | null>(
    () => (draft ? { ...draft, customHeaders: parseHeadersText(headersText) } : null),
    [draft, headersText],
  )

  const savedDraft = useMemo(() => {
    if (!draft?.id) return null
    const group = configGroups.find((item) => item.id === draft.id)
    return group ? draftFromGroup(group) : null
  }, [draft?.id, configGroups])

  const diff = useMemo(() => draftDiff(savedDraft, currentDraft), [savedDraft, currentDraft])

  const resetTransient = () => {
    setShowKey(false)
    setFormError(null)
    setPendingDelete(false)
    setTesting(false)
    setTestSteps([])
    setTestResult(null)
    setEditorModels([])
    setFetchingModels(false)
    setModelFetchError(null)
    setNewModelName('')
    setNewContextWindow('')
    setNewMaxOutput('')
    setPresetId('')
  }

  const openSaved = (groupId: string) => {
    const group = configGroups.find((item) => item.id === groupId)
    if (!group) return
    resetTransient()
    setIsCreating(false)
    setDraft(draftFromGroup(group))
    setHeadersText(formatHeadersText(group.customHeaders))
    // 使用中的组直接用 store 里已拉取的模型列表，其余组只带该提供商的自定义模型
    if (group.id === activeConfigGroupId && models.length > 0) {
      setEditorModels(models)
    } else {
      setEditorModels(customModels.filter((item) => item.provider === group.provider).map(customToModelInfo))
    }
  }

  const startNew = () => {
    resetTransient()
    setIsCreating(true)
    setDraft(emptyDraftForProvider(newProvider))
    setHeadersText('')
  }

  const closeEditor = () => {
    setDraft(null)
    setIsCreating(false)
    resetTransient()
  }

  const patchDraft = (patch: Partial<ApiDraft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current))
  }

  const save = useCallback(async () => {
    if (!currentDraft) return
    const check = validateDraftForSave(currentDraft, configGroups)
    if (!check.ok) {
      setFormError(check.error)
      return
    }
    setFormError(null)
    try {
      if (isCreating) await createConfigGroup(currentDraft)
      else if (currentDraft.id) await updateConfigGroup(currentDraft.id, currentDraft)
      notify('配置已保存', 'success')
      setDraft(null)
      setIsCreating(false)
      resetTransient()
    } catch (error) {
      const message = errorText(error, '保存配置失败')
      setFormError(message)
      notify(message, 'error')
    }
  }, [currentDraft, configGroups, isCreating, createConfigGroup, updateConfigGroup, notify])

  // 面板级 ⌘/Ctrl+Enter：只有「新建」或「有未保存修改」时才写盘，避免无改动也走一次 IPC
  useEffect(() => {
    saveHandlerRef.current = () => {
      if (!currentDraft) return
      if (!isCreating && !diff.dirty) return
      void save()
    }
    return () => {
      saveHandlerRef.current = null
    }
  }, [saveHandlerRef, currentDraft, isCreating, diff.dirty, save])

  const test = async () => {
    if (!currentDraft) return
    const check = validateDraftForTest(currentDraft)
    if (!check.ok) {
      setFormError(check.error)
      return
    }
    setTesting(true)
    setFormError(null)
    setTestSteps([])
    setTestResult(null)
    try {
      const result = await testConnectionGroup(toFullConfigGroup(currentDraft), (step) => {
        setTestSteps((previous) => [...previous, step])
      })
      setTestResult(result)
      notify(result.success ? '连接成功' : result.message, result.success ? 'success' : 'error')
    } catch (error) {
      const message = errorText(error, '测试连接失败，请稍后重试')
      setFormError(message)
      notify(message, 'error')
    } finally {
      setTesting(false)
    }
  }

  const fetchModels = async () => {
    if (!currentDraft) return
    if (!currentDraft.baseUrl.trim()) {
      setModelFetchError('请先填写 API 基础 URL')
      return
    }
    setFetchingModels(true)
    setModelFetchError(null)
    try {
      const list = await fetchModelsForGroup(toFullConfigGroup(currentDraft))
      setEditorModels(list)
      if (list.length === 0) setModelFetchError('接口未返回任何模型，可在下方手动添加')
    } catch (error) {
      setModelFetchError(errorText(error, '获取模型列表失败'))
    } finally {
      setFetchingModels(false)
    }
  }

  const addModel = () => {
    if (!currentDraft) return
    const id = newModelName.trim()
    if (!id) {
      setModelFetchError('先填写模型名再添加')
      return
    }
    const contextWindow = Number(newContextWindow)
    const maxOutputTokens = Number(newMaxOutput)
    const custom: CustomModel = {
      id,
      name: id,
      provider: currentDraft.provider,
      createdAt: Date.now(),
      ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
      ...(Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? { maxOutputTokens } : {}),
    }
    upsertCustomModel(custom)
    setEditorModels((previous) => {
      const entry: ModelInfo = {
        id,
        name: id,
        isFree: false,
        isFavorite: false,
        contextWindow: custom.contextWindow,
        maxOutputTokens: custom.maxOutputTokens,
      }
      return previous.some((item) => item.id === id)
        ? previous.map((item) => (item.id === id ? { ...item, ...entry } : item))
        : [...previous, entry]
    })
    if (!currentDraft.defaultModel) patchDraft({ defaultModel: id })
    setNewModelName('')
    setNewContextWindow('')
    setNewMaxOutput('')
    setModelFetchError(null)
  }

  const removeModel = (id: string) => {
    if (customModels.some((item) => item.id === id)) removeCustomModel(id)
    setEditorModels((previous) => previous.filter((item) => item.id !== id))
  }

  const removeGroup = async () => {
    if (!currentDraft?.id) return
    try {
      await deleteConfigGroup(currentDraft.id)
      notify('配置已删除', 'success')
      closeEditor()
    } catch (error) {
      const message = errorText(error, '删除配置失败')
      setFormError(message)
      notify(message, 'error')
    }
  }

  const applyPreset = (catalogId: string) => {
    setPresetId(catalogId)
    if (!catalogId) return
    const preset = getCatalogProvider(catalogId)
    if (!preset) return
    setDraft((current) => (current ? applyCatalogPreset(current, preset, { isCreating }) : current))
  }

  const exportConfigs = async () => {
    try {
      const { exportConfigGroups } = useConfigStore.getState()
      const data = await exportConfigGroups(backupPassword.trim() || undefined)
      const blob = new Blob([data], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `ourcode-configs-${Date.now()}.json`
      anchor.click()
      URL.revokeObjectURL(url)
      notify('已导出配置', 'success')
      setBackupMode(null)
      setBackupPassword('')
    } catch (error) {
      notify(errorText(error, '导出失败'), 'error')
    }
  }

  const importConfigs = async (file: File) => {
    try {
      const text = await file.text()
      const { importConfigGroups } = useConfigStore.getState()
      await importConfigGroups(text, backupPassword.trim() || undefined)
      await loadConfigGroups()
      notify('已导入配置', 'success')
      setBackupMode(null)
      setBackupPassword('')
    } catch (error) {
      notify(errorText(error, '导入失败'), 'error')
    }
  }

  const providerMeta = draft ? getProviderMeta(draft.provider || '') : undefined
  const format = draft ? resolveFormat(draft.provider || 'custom', draft.apiFormat) : 'openai'
  const nativeFormat = providerMeta?.nativeFormat || 'openai'
  const defaultModelSpec = draft?.defaultModel
    ? editorModels.find((item) => item.id === draft.defaultModel) ?? getCatalogModel(draft.defaultModel)
    : undefined
  const headerCount = countHeaderLines(headersText)

  return (
    <div>
      <SectionHeading
        title="API 与模型"
        hint="接入点、密钥与默认模型都存在本地；保存后才生效。"
      >
        <TextAction onClick={() => void loadConfigGroups()} label="重新读取配置">
          刷新
        </TextAction>
      </SectionHeading>

      <GroupLabel trailing={`${configGroups.length} 个`}>已保存配置</GroupLabel>
      {configGroups.length === 0 ? (
        <p className="py-2 text-[12.5px] leading-[20px] text-[var(--pure-muted)]">
          还没有配置。在下方选一个提供商新建，或者导入已有的 JSON 备份。
        </p>
      ) : (
        <div className="divide-y divide-[var(--pure-border)]">
          {configGroups.map((group) => {
            const selected = draft?.id === group.id
            return (
            <button
              key={group.id}
              type="button"
              onClick={() => openSaved(group.id)}
              aria-label={`编辑配置 ${group.name}`}
              aria-pressed={selected}
              className={`pure-focus pure-surface-row group -mx-2 relative flex w-full items-baseline gap-3 pl-3 pr-2 py-2 text-left ${
                selected ? 'bg-[var(--pure-hover)]' : ''
              }`}
            >
              {/* 选中态左侧一条 2px ink：列表里一眼看出「正在编辑哪一条」 */}
              <span
                aria-hidden="true"
                className={`absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full transition-colors ${
                  selected ? 'bg-[var(--pure-ink)]' : 'bg-transparent'
                }`}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] leading-[20px] text-[var(--pure-ink)]">{group.name}</span>
                <span className="block truncate pt-0.5 font-mono text-[11.5px] leading-[18px] text-[var(--pure-muted)]">
                  {group.baseUrl}
                </span>
              </span>
              {group.id === activeConfigGroupId ? (
                <span className="shrink-0 rounded-full bg-[var(--pure-active)] px-2 py-0.5 text-[10.5px] leading-[16px] text-[var(--pure-ink)]">
                  使用中
                </span>
              ) : (
                <span className="shrink-0 text-[11.5px] leading-[18px] text-[var(--pure-muted)] opacity-0 transition-opacity group-hover:opacity-100">
                  编辑
                </span>
              )}
            </button>
          )
          })}
        </div>
      )}

      <GroupLabel>新建与备份</GroupLabel>
      <Row label="新建配置" description="按提供商预填名称与默认地址">
        <SelectField
          label="新建配置的提供商"
          value={newProvider}
          onChange={(event) => setNewProvider(event.target.value)}
          options={PROVIDER_REGISTRY.map((provider) => ({ value: provider.value, label: provider.label }))}
        />
        <TextAction onClick={startNew} label="新建配置">
          新建
        </TextAction>
      </Row>

      <Row label="导入 / 导出" description="JSON 备份；密码可选，留空则密钥写成 ***">
        <TextAction
          onClick={() => {
            setBackupMode(backupMode === 'import' ? null : 'import')
            setBackupPassword('')
          }}
          label="导入配置"
        >
          导入
        </TextAction>
        <TextAction
          onClick={() => {
            setBackupMode(backupMode === 'export' ? null : 'export')
            setBackupPassword('')
          }}
          label="导出配置"
        >
          导出
        </TextAction>
      </Row>

      {backupMode ? (
        <div className="pb-2">
          <Row label="备份密码" description="留空表示不加密；导入时密码必须与导出时一致" stacked>
            <div className="flex items-center gap-2">
              <TextInput
                label="备份密码"
                type="password"
                autoComplete="off"
                value={backupPassword}
                onChange={(event) => setBackupPassword(event.target.value)}
                className="flex-1"
              />
              {backupMode === 'export' ? (
                <TextAction onClick={() => void exportConfigs()} label="确认导出">
                  导出
                </TextAction>
              ) : (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json"
                    aria-label="选择配置文件"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0]
                      if (file) void importConfigs(file)
                      event.target.value = ''
                    }}
                  />
                  <TextAction onClick={() => fileInputRef.current?.click()} label="选择配置文件导入">
                    选择文件
                  </TextAction>
                </>
              )}
              <TextAction
                onClick={() => {
                  setBackupMode(null)
                  setBackupPassword('')
                }}
                label="取消备份操作"
              >
                取消
              </TextAction>
            </div>
          </Row>
        </div>
      ) : null}

      {draft && currentDraft ? (
        <div className="pt-8">
          <div className="flex items-baseline gap-3">
            <h3 className="text-[15px] leading-[22px] text-[var(--pure-ink)]">
              {isCreating ? '新建配置' : `编辑「${savedDraft?.name ?? draft.name}」`}
            </h3>
            <span className="shrink-0 text-[11.5px] leading-[18px] text-[var(--pure-muted)]">
              {providerMeta?.label || draft.provider}
            </span>
            <span className="ml-auto shrink-0 font-mono text-[11.5px] leading-[18px] text-[var(--pure-muted)]">
              {FORMAT_META[format].label}
            </span>
          </div>

          <GroupLabel>基础</GroupLabel>
          <Row label="配置名称" description="必填；同名配置会被拒绝保存">
            <TextInput
              label="配置名称"
              value={draft.name}
              onChange={(event) => patchDraft({ name: event.target.value })}
              placeholder="例如：主力模型"
              className="w-[220px]"
            />
          </Row>
          <Row label="默认模型" description="新建会话默认使用的模型，可从已拉取的列表里选">
            <TextInput
              label="默认模型"
              mono
              list="shell-settings-model-options"
              value={draft.defaultModel}
              onChange={(event) => patchDraft({ defaultModel: event.target.value })}
              placeholder="可输入或从列表选择"
              className="w-[220px]"
            />
            <datalist id="shell-settings-model-options">
              {editorModels.map((item) => (
                <option key={item.id} value={item.id} />
              ))}
            </datalist>
          </Row>
          <Row
            label="厂商预设"
            description={`已收录 ${providerPresets.length} 个可直接套用官方地址的接入点`}
            stacked
          >
            <SelectField
              label="厂商预设"
              value={presetId}
              onChange={(event) => applyPreset(event.target.value)}
              options={[
                { value: '', label: '手动填写 / 保持当前接入点' },
                ...providerPresets.map((provider) => ({ value: provider.id, label: `${provider.name} — ${provider.api}` })),
              ]}
              className="w-full"
            />
          </Row>
          <Row label="API 基础 URL" description="必填，通常以 /v1 结尾" stacked>
            <TextInput
              label="API 基础 URL"
              mono
              value={draft.baseUrl}
              onChange={(event) => patchDraft({ baseUrl: event.target.value })}
              placeholder={providerMeta?.defaultBaseUrl || 'https://api.example.com/v1'}
            />
          </Row>
          <Row label="跳过证书校验" description="仅用于内网自签名证书，生产环境保持关闭">
            <Switch
              label="跳过证书校验"
              checked={draft.skipTlsVerify}
              onChange={(next) => patchDraft({ skipTlsVerify: next })}
            />
          </Row>

          <GroupLabel>请求格式</GroupLabel>
          <Row label="请求格式" description="跟随提供商默认即可，只有自建网关才需要覆盖" stacked>
            <Segmented
              label="请求格式"
              value={(draft.apiFormat || 'auto') as (typeof FORMAT_OVERRIDES)[number]['value']}
              onChange={(next) => patchDraft({ apiFormat: next })}
              options={FORMAT_OVERRIDES.map((option) => ({ value: option.value, label: option.label }))}
            />
            {isFormatOverrideRisky(draft) ? (
              <div className="pt-2">
                <StatusLine tone="error">
                  该格式与提供商默认（{FORMAT_META[nativeFormat].label}）不同，请确认网关确实支持。
                </StatusLine>
              </div>
            ) : null}
          </Row>

          <GroupLabel>认证与标识</GroupLabel>
          <Row label="API 密钥" description="必填；Ollama / 自建中继可留空。可用 $ENV_NAME 引用环境变量" stacked>
            <div className="flex items-center gap-2">
              <TextInput
                label="API 密钥"
                mono
                type={showKey ? 'text' : 'password'}
                autoComplete="off"
                value={draft.apiKey}
                onChange={(event) => patchDraft({ apiKey: event.target.value })}
                className="flex-1"
              />
              <TextAction
                onClick={() => setShowKey((value) => !value)}
                label={showKey ? '隐藏密钥' : '显示密钥'}
              >
                {showKey ? '隐藏' : '显示'}
              </TextAction>
            </div>
          </Row>
          <Row
            label="自定义请求头"
            description={headerCount > 0 ? `已填写 ${headerCount} 条，每行一条 Header: Value` : '每行一条，格式 Header: Value'}
            stacked
          >
            <TextArea
              label="自定义请求头"
              mono
              rows={3}
              value={headersText}
              onChange={(event) => setHeadersText(event.target.value)}
              placeholder={'Authorization: Bearer sk-xxx\nX-API-Key: xxx'}
            />
          </Row>

          <GroupLabel trailing={`模型目录收录 ${MODEL_CATALOG_META.modelCount} 个`}>
            模型
          </GroupLabel>
          <div className="flex items-center gap-3 pb-1">
            <TextAction onClick={() => void fetchModels()} disabled={fetchingModels || testing} label="获取模型列表">
              {fetchingModels ? '获取中…' : '获取模型列表'}
            </TextAction>
            <span className="text-[11.5px] leading-[18px] text-[var(--pure-muted)]">
              点模型名可设为默认；自定义模型可移除
            </span>
          </div>
          {modelFetchError ? (
            <div className="pb-1">
              <StatusLine tone="error">{modelFetchError}</StatusLine>
            </div>
          ) : null}
          {editorModels.length === 0 ? (
            <p className="py-1 text-[12px] leading-[18px] text-[var(--pure-muted)]">
              暂无模型：点「获取模型列表」拉取，或在下方手动添加。
            </p>
          ) : (
            <div className="max-h-[220px] overflow-y-auto pure-scroll">
              {editorModels.map((item) => {
                const isDefault = item.id === draft.defaultModel
                const custom = customModels.find((entry) => entry.id === item.id)
                const specs = modelSpecLine(item)
                return (
                  <div key={item.id} className="flex items-center gap-3 py-1">
                    <button
                      type="button"
                      onClick={() => patchDraft({ defaultModel: item.id })}
                      aria-pressed={isDefault}
                      aria-label={`把 ${item.id} 设为默认模型`}
                      title={specs || item.id}
                      className={`pure-focus min-w-0 flex-1 truncate text-left font-mono text-[11.5px] leading-[18px] transition-colors ${
                        isDefault ? 'text-[var(--pure-ink)]' : 'text-[var(--pure-muted)] hover:text-[var(--pure-ink)]'
                      }`}
                    >
                      {item.id}
                    </button>
                    {specs ? (
                      <span className="hidden shrink-0 text-[11px] leading-[18px] text-[var(--pure-muted)] sm:inline">
                        {specs}
                      </span>
                    ) : null}
                    {isDefault ? (
                      <span className="shrink-0 text-[11px] leading-[18px] text-[var(--pure-ink)]">默认</span>
                    ) : null}
                    {custom ? (
                      <TextAction onClick={() => removeModel(item.id)} danger label={`移除模型 ${item.id}`}>
                        移除
                      </TextAction>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )}
          {defaultModelSpec ? (
            <p className="pt-1 text-[11.5px] leading-[18px] text-[var(--pure-muted)]">
              默认模型规格：{modelSpecLine(defaultModelSpec) || '目录未收录'}
            </p>
          ) : null}

          <Row label="手动添加模型" description="模型名必填；上下文与输出上限可选（不填则沿用目录值）" stacked>
            <div className="flex flex-wrap items-center gap-2">
              <TextInput
                label="模型名"
                mono
                value={newModelName}
                onChange={(event) => setNewModelName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') addModel()
                }}
                placeholder="deepseek-reasoner"
                className="min-w-[180px] flex-1"
              />
              <TextInput
                label="上下文窗口（tokens）"
                inputMode="numeric"
                value={newContextWindow}
                onChange={(event) => setNewContextWindow(event.target.value)}
                placeholder="上下文"
                className="w-[110px]"
              />
              <TextInput
                label="输出上限（tokens）"
                inputMode="numeric"
                value={newMaxOutput}
                onChange={(event) => setNewMaxOutput(event.target.value)}
                placeholder="输出"
                className="w-[100px]"
              />
              <TextAction onClick={addModel} label="添加模型">
                添加
              </TextAction>
            </div>
          </Row>

          <GroupLabel trailing={testing ? '测试中…' : undefined}>连接测试</GroupLabel>
          <div className="flex items-center gap-3 pb-1">
            <TextAction onClick={() => void test()} disabled={testing} label="测试连接">
              {testing ? '测试中…' : '测试连接'}
            </TextAction>
            {testResult ? (
              <StatusLine tone={testResult.success ? 'ok' : 'error'}>
                {testResult.success ? '连接成功' : testResult.message}
              </StatusLine>
            ) : null}
          </div>
          {testSteps.length > 0 ? (
            <div className="pb-2">
              {testSteps.map((step, index) => (
                <div key={`${step.name}-${index}`} className="py-0.5">
                  <div className="flex items-baseline gap-2 text-[12px] leading-[18px]">
                    <span className={step.ok ? 'text-[var(--pure-ink)]' : 'text-[var(--pure-danger)]'} aria-hidden="true">
                      {step.ok ? '✓' : '✗'}
                    </span>
                    <span className="shrink-0 text-[var(--pure-ink)]">{step.name}</span>
                    <span className="min-w-0 flex-1 truncate text-[var(--pure-muted)]">{step.detail}</span>
                    {step.ms !== undefined ? (
                      <span className="shrink-0 font-mono text-[11px] text-[var(--pure-muted)]">{step.ms}ms</span>
                    ) : null}
                  </div>
                  {step.url ? (
                    <div className="break-all pl-4 font-mono text-[11px] leading-[16px] text-[var(--pure-muted)]">{step.url}</div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {formError ? (
            <div className="pt-2">
              <StatusLine tone="error">{formError}</StatusLine>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3 pt-6">
            {!isCreating && draft.id ? (
              <TextAction onClick={() => setPendingDelete(true)} danger label="删除此配置">
                删除此配置
              </TextAction>
            ) : null}
            <span className="ml-auto flex items-center gap-3">
              <span className="text-[11.5px] leading-[18px] text-[var(--pure-muted)]">
                {diff.dirty ? `未保存的修改：${describeDraftDiff(diff)}` : isCreating ? '⌘/Ctrl+Enter 保存' : '没有改动'}
              </span>
              <TextAction onClick={closeEditor} label="取消编辑">
                取消
              </TextAction>
              <TextAction onClick={() => void save()} label="保存配置">
                保存配置
              </TextAction>
            </span>
          </div>
          {pendingDelete ? (
            <div className="pt-3">
              <InlineConfirmDelete name={savedDraft?.name ?? draft.name} onCancel={() => setPendingDelete(false)} onConfirm={() => void removeGroup()} />
            </div>
          ) : null}
        </div>
      ) : (
        <p className="pt-8 text-[12.5px] leading-[20px] text-[var(--pure-muted)]">
          从上面选择一个已保存的配置进行编辑，或选提供商新建一个。
        </p>
      )}
    </div>
  )
}

function InlineConfirmDelete({
  name,
  onConfirm,
  onCancel,
}: {
  name: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="rounded-xl bg-[var(--pure-code)] px-3 py-2.5" role="group" aria-label={`删除配置 ${name}`}>
      <div className="text-[12.5px] leading-[19px] text-[var(--pure-ink)]" role="alert">
        确定要删除「{name}」吗？这一操作不可撤销。
      </div>
      <div className="flex items-center gap-3 pt-2">
        <TextAction onClick={onCancel} label="取消删除">
          取消
        </TextAction>
        <TextAction onClick={onConfirm} danger label={`确认删除配置 ${name}`}>
          删除
        </TextAction>
      </div>
    </div>
  )
}

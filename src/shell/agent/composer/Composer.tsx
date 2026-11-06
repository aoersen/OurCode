/**
 * Composer —— 纯风输入胶囊（唯一允许阴影的两处之一）。
 *
 * 视觉契约（`.stitch/designs/pure-01b-empty-2.png` / `pure-02b-running.png`）：
 *   行1  textarea（无边框、无背景、无 focus ring）
 *   行2  左：+ 附件 · 模型名 ⌄ · 权限模式 ⌄   右：上下文细环 · 32px 近黑发送键
 * 一个胶囊、24px 圆角、1px 冷灰描边、柔和阴影；没有内部计量胶囊、没有工具条描边。
 *
 * 两个 variant：
 *   hero   —— 空会话、渲染在阅读列里（居中偏上），多一行快捷键提示；
 *   inline —— 有内容后贴底 dock，行高更紧、不带提示行。
 *
 * 行为全部来自 `useComposer()`；这里只有布局和 class。
 */
import { useEffect, useRef } from 'react'
import FileChip from '@/components/ChatPanel/FileChip'
import { useUIStore } from '@/stores/uiStore'
import { imageAttachmentDataUrl } from '@/utils/imageAttach'
import { useI18n } from '@/i18n/useI18n'
import { AttachmentMenu, ContextMeter, ModePicker, ModelPicker, Popover } from './ComposerParts'
import useComposer, { type ComposerVoiceState } from './useComposer'

export type ComposerVariant = 'hero' | 'inline'

/** 语音设置卡：首次点麦克风且没有可用端点时展开，只填一个 OpenAI 兼容地址即可 */
function VoiceSetupPanel({ voice }: { voice: ComposerVoiceState }) {
  const t = useI18n()
  const fields = [
    { key: 'endpoint' as const, label: t('chat.voiceEndpoint'), hint: t('chat.voiceEndpointHint') },
    { key: 'apiKey' as const, label: t('chat.voiceApiKey'), hint: t('chat.voiceApiKeyHint') },
    { key: 'model' as const, label: t('chat.voiceModel'), hint: 'whisper-1' },
    { key: 'language' as const, label: t('chat.voiceLanguage'), hint: 'zh' },
  ]

  return (
    <div className="mb-2 rounded-xl border border-[var(--pure-border)] bg-[var(--surface)] px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-medium text-[var(--pure-ink)]">{t('chat.voiceSetupTitle')}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--pure-muted)]">
          {voice.source === 'builtin'
            ? t('chat.voiceActiveBuiltin')
            : voice.source === 'local'
              ? t('chat.voiceActiveLocal')
              : voice.configured
                ? t('chat.voiceActiveManual')
                : t('chat.voiceActiveAuto')}
        </span>
        <button
          type="button"
          onClick={voice.closeSetup}
          aria-label={t('chat.voiceSetupClose')}
          className="w-6 h-6 rounded-md flex items-center justify-center text-[var(--pure-muted)] hover:text-[var(--pure-ink)] hover:bg-[var(--pure-hover)]"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        {fields.map((field) => (
          <label key={field.key} className="block min-w-0">
            <span className="block text-[11px] text-[var(--pure-muted)]">{field.label}</span>
            <input
              value={voice.draft[field.key]}
              onChange={(e) => voice.setDraft({ ...voice.draft, [field.key]: e.target.value })}
              placeholder={field.hint}
              spellCheck={false}
              className="mt-0.5 w-full h-7 rounded-md border border-[var(--pure-border)] bg-[var(--surface)] px-2 text-[12px] text-[var(--pure-ink)] outline-none focus:border-[var(--pure-ink)]"
            />
          </label>
        ))}
      </div>

      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] text-[var(--pure-muted)] truncate">{t('chat.voiceImeTip')}</span>
        <span className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={voice.reset}
            className="h-7 px-2 rounded-md text-[12px] text-[var(--pure-muted)] hover:text-[var(--pure-ink)] hover:bg-[var(--pure-hover)]"
          >
            {t('chat.voiceReset')}
          </button>
          <button
            type="button"
            onClick={voice.save}
            className="h-7 px-2.5 rounded-md bg-[var(--pure-ink)] text-[12px] text-white hover:opacity-90"
          >
            {t('chat.voiceSave')}
          </button>
        </span>
      </div>
    </div>
  )
}

export default function Composer({
  variant = 'inline',
  className = '',
}: {
  variant?: ComposerVariant
  className?: string
}) {
  const t = useI18n()
  const c = useComposer()
  const rootPath = useUIStore((s) => s.rootPath)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const hero = variant === 'hero'

  // 自适应高度：先归零再量 scrollHeight，上限 200px（超过就内部滚动）
  useEffect(() => {
    const el = c.textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [c.text, c.textareaRef, variant])

  useEffect(() => {
    const onResize = () => {
      const el = c.textareaRef.current
      if (!el) return
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [c.textareaRef])

  const primaryIsStop = c.isRunning && !c.hasDraft

  return (
    <div className={className} data-testid="composer" data-variant={variant}>
      {/* 待发送队列（运行中打字排队）：折叠在胶囊上方，不抢胶囊的视觉重量 */}
      {c.queuedMessages.length > 0 && (
        <div className="mb-2 rounded-xl border border-[var(--pure-border)] bg-[var(--pure-rail)] px-3 py-2">
          <div className="flex items-center gap-2 text-[11px] text-[var(--pure-secondary)]">
            <span>
              {t('chat.queueTitle')} · {c.queuedMessages.length}
            </span>
            <button
              type="button"
              onClick={c.clearQueue}
              className="ml-auto text-[11px] hover:text-[var(--pure-ink)] transition-colors"
            >
              {t('chat.queueClearAll')}
            </button>
          </div>
          <ul className="mt-1 max-h-[96px] overflow-y-auto pure-scroll">
            {c.queuedMessages.map((msg, index) => (
              <li key={`${index}-${msg.content.slice(0, 8)}`} className="flex items-center gap-2 py-0.5 text-[12px]">
                <span className="min-w-0 flex-1 truncate text-[var(--pure-secondary)]">
                  {msg.content || t('chat.imageOnly')}
                </span>
                {msg.attachments?.length ? (
                  <span className="shrink-0 text-[11px] text-[var(--pure-muted)]">🖼 {msg.attachments.length}</span>
                ) : null}
                <button
                  type="button"
                  onClick={() => c.sendQueuedNow(index)}
                  title={t('chat.queueSendNow')}
                  className="shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-[var(--pure-muted)] hover:text-[var(--pure-ink)] hover:bg-[var(--pure-hover)]"
                >
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <polygon points="5 3 19 12 5 21" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => c.removeQueued(index)}
                  title={t('chat.queueDelete')}
                  className="shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-[var(--pure-muted)] hover:text-[var(--pure-danger)] hover:bg-[var(--pure-hover)]"
                >
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 附件 chip：路径引用（随消息变成 [name](./path) 链接） */}
      {c.contextFiles.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {c.contextFiles.map((file) => (
            <FileChip
              key={file}
              path={file}
              rootPath={rootPath || ''}
              removable
              onRemove={c.removeContextFile}
              removeLabel={t('chat.removeFile')}
            />
          ))}
        </div>
      )}

      {/* 图片附件：真·多模态内容，缩略图 + hover 删除 */}
      {c.images.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {c.images.map((img) => (
            <div key={img.id} className="relative group">
              <img
                src={imageAttachmentDataUrl(img)}
                alt={img.name}
                title={img.name}
                className="h-11 w-11 object-cover rounded-lg border border-[var(--pure-border)]"
              />
              <button
                type="button"
                onClick={() => c.removeImage(img.id)}
                aria-label={t('chat.removeImage')}
                className="absolute -top-1.5 -right-1.5 hidden group-hover:flex w-4 h-4 items-center justify-center rounded-full bg-[var(--surface)] border border-[var(--pure-border)] text-[var(--pure-secondary)] text-[11px] leading-none"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {c.voice.setupOpen && <VoiceSetupPanel voice={c.voice} />}

      {/* 拖拽区（也是 drop target）：浮层只是拖拽提示，胶囊本身仍在文档流里 */}
      <div className="relative" data-chat-drop {...c.dragHandlers}>
        {c.isDragOver && (
          <div className="pure-drop-overlay" aria-hidden>
            <span className="px-2.5 py-1 rounded-full bg-[var(--pure-ink)] text-white text-[11px]">
              {t('chat.dropHint')}
            </span>
          </div>
        )}

        {/* slash 命令（行首 "/"） */}
        {c.slash.open && c.slash.items.length > 0 && (
          <Popover width="right-0">
            {c.slash.items.map((cmd, index) => (
              <button
                key={cmd.id}
                type="button"
                onMouseEnter={() => c.slash.hover(index)}
                onClick={() => c.slash.pick(cmd)}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors ${
                  index === c.slash.index
                    ? 'bg-[var(--pure-hover)] text-[var(--pure-ink)]'
                    : 'text-[var(--pure-secondary)] hover:bg-[var(--pure-hover)]'
                }`}
              >
                <span className="shrink-0 text-[var(--pure-ink)]">/{cmd.name}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--pure-muted)]">{cmd.description}</span>
              </button>
            ))}
          </Popover>
        )}

        {/* @ 文件引用 */}
        {c.fileSearch.open && c.fileSearch.results.length > 0 && (
          <Popover width="right-0">
            {c.fileSearch.results.map((file, index) => (
              <button
                key={file.path}
                type="button"
                onMouseEnter={() => c.fileSearch.hover(index)}
                onClick={() => c.fileSearch.pick(file.path)}
                title={file.path}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors ${
                  index === c.fileSearch.index
                    ? 'bg-[var(--pure-hover)] text-[var(--pure-ink)]'
                    : 'text-[var(--pure-secondary)] hover:bg-[var(--pure-hover)]'
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{file.path}</span>
                <span className="shrink-0 text-[11px] text-[var(--pure-muted)]">{file.name}</span>
              </button>
            ))}
          </Popover>
        )}

        <div
          data-testid="composer-capsule"
          className={`w-full bg-[var(--surface)] border border-[var(--pure-border)] pure-soft-shadow flex flex-col ${
            hero
              ? 'rounded-[26px] px-4 pt-3.5 pb-3'
              : 'rounded-[24px] px-3.5 pt-2.5 pb-2'
          }`}
        >
          <textarea
            ref={c.textareaRef}
            value={c.text}
            onChange={c.onChange}
            onKeyDown={c.onKeyDown}
            onPaste={c.onPaste}
            placeholder={hero ? c.heroPlaceholder : c.placeholder}
            rows={1}
            disabled={!c.configReady}
            data-ai-input
            aria-label={hero ? c.heroPlaceholder : c.placeholder}
            className={`w-full bg-transparent resize-none outline-none border-0 text-[var(--pure-ink)] placeholder:text-[var(--pure-muted)] px-0.5 py-0 max-h-[200px] disabled:opacity-50 ${
              hero ? 'text-[15px] leading-[24px] min-h-[44px]' : 'text-[14px] leading-[22px] min-h-[26px]'
            }`}
          />

          <div className={`flex items-center gap-1 min-w-0 ${hero ? 'mt-1.5' : 'mt-1'}`}>
            <AttachmentMenu
              onPickFile={c.addFile}
              onPickImages={() => imageInputRef.current?.click()}
              onVoice={c.voice.toggle}
              listening={c.voice.listening}
              voiceBusy={c.voice.busy}
            />
            <ModelPicker />
            <ModePicker />

            <div className="ml-auto flex items-center gap-1.5 shrink-0">
              <ContextMeter usage={c.contextUsage} />

              {/* 运行中且有草稿：停止（幽灵）+ 发送（主）并存，别把中止能力藏起来 */}
              {c.isRunning && c.hasDraft && (
                <button
                  type="button"
                  onClick={c.stop}
                  title={t('chat.stop')}
                  aria-label={t('chat.stop')}
                  className="w-7 h-7 rounded-md flex items-center justify-center text-[var(--pure-secondary)] hover:bg-[var(--pure-hover)] hover:text-[var(--pure-ink)] transition-colors"
                >
                  <span className="w-2.5 h-2.5 rounded-[2px] bg-current" />
                </button>
              )}

              <button
                type="button"
                onClick={primaryIsStop ? c.stop : c.submit}
                disabled={!primaryIsStop && !c.configReady}
                aria-disabled={!primaryIsStop && !c.canSend}
                title={primaryIsStop ? t('chat.stop') : t('chat.send')}
                aria-label={primaryIsStop ? t('chat.stop') : t('chat.send')}
                data-testid="composer-primary"
                className={`w-8 h-8 shrink-0 flex items-center justify-center bg-[var(--pure-ink)] text-white transition-opacity hover:opacity-90 disabled:opacity-25 ${
                  primaryIsStop ? 'rounded-[10px]' : 'rounded-full'
                }`}
              >
                {primaryIsStop ? (
                  <span className="w-2.5 h-2.5 rounded-[2px] bg-white" />
                ) : (
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* hero 才有的快捷键提示：inline 态把这条让给默认习惯，省一行高度 */}
      {hero && (
        <p className="mt-2 text-center text-[11px] text-[var(--pure-muted)]" aria-hidden>
          {t('chat.ctrlEnterSend')}
        </p>
      )}

      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          c.pickImages(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}

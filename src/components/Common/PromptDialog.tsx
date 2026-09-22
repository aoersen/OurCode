import { useEffect, useRef, useState } from 'react'
import ModalPortal from './ModalPortal'
import Button from './Button'
import Input from './Input'
import { useI18n } from '@/i18n/useI18n'
import { isComposingEvent } from '@/utils/composition'

export interface PromptOptions {
  title: string
  defaultValue?: string
  placeholder?: string
  /** 多行输入（编辑历史消息正文这类长文本）；Enter 换行，Ctrl/Cmd+Enter 提交 */
  multiline?: boolean
  /** 允许留空提交（"无密码请留空"这类可选输入） */
  allowEmpty?: boolean
  confirmText?: string
  cancelText?: string
}

interface PendingRequest {
  options: PromptOptions
  resolve: (value: string | null) => void
}

let onRequest: ((request: PendingRequest) => void) | null = null

/**
 * Electron 的渲染进程不实现 window.prompt —— 调用它会直接抛出
 * "prompt() is and will not be supported."，所以重命名 / 新建文件这类输入型操作
 * 全部走这里。取消返回 null，与浏览器的 prompt 语义一致。
 */
export function askText(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    if (!onRequest) {
      resolve(null)
      return
    }
    onRequest({ options, resolve })
  })
}

export default function PromptDialogHost() {
  const t = useI18n()
  const [request, setRequest] = useState<PendingRequest | null>(null)
  const [value, setValue] = useState('')
  const currentRef = useRef<PendingRequest | null>(null)
  const fieldRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null)

  useEffect(() => {
    onRequest = (next) => {
      currentRef.current?.resolve(null)
      currentRef.current = next
      setRequest(next)
    }
    return () => {
      onRequest = null
    }
  }, [])

  const settle = (next: string | null) => {
    const pending = currentRef.current
    currentRef.current = null
    setRequest(null)
    pending?.resolve(next)
  }

  useEffect(() => {
    if (!request) return
    setValue(request.options.defaultValue ?? '')
    const focusTimer = window.setTimeout(() => {
      fieldRef.current?.focus()
      fieldRef.current?.select()
    }, 0)
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        settle(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [request])

  if (!request) return null

  const { options } = request
  const trimmed = value.trim()
  const canSubmit = options.allowEmpty || (options.multiline ? value.length > 0 : trimmed.length > 0)

  const submit = () => {
    if (!canSubmit) return
    settle(options.multiline ? value : trimmed)
  }

  const fieldClass =
    'w-full px-3 py-2 text-sm rounded-lg bg-nova-input-bg border border-nova-border text-nova-text-primary outline-none focus:border-nova-accent'

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 backdrop-blur-sm"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) settle(null)
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={options.title}
          className="glass-modal rounded-xl w-full max-w-md mx-4 animate-fade-in"
        >
          <div className="px-5 pt-5 pb-3">
            <h3 className="text-sm font-semibold text-nova-text-primary">{options.title}</h3>
          </div>
          <div className="px-5">
            {options.multiline ? (
              <textarea
                ref={fieldRef as React.RefObject<HTMLTextAreaElement>}
                value={value}
                rows={8}
                placeholder={options.placeholder}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    submit()
                  }
                }}
                className={`${fieldClass} font-mono resize-y min-h-[160px]`}
              />
            ) : (
              <Input
                ref={fieldRef as React.RefObject<HTMLInputElement>}
                value={value}
                placeholder={options.placeholder}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  // IME 组合期间的回车是确认候选词，不提交
                  if (e.key === 'Enter' && !isComposingEvent(e)) {
                    e.preventDefault()
                    submit()
                  }
                }}
              />
            )}
          </div>
          <div className="flex justify-end gap-2 px-5 py-4">
            <Button variant="secondary" onClick={() => settle(null)}>
              {options.cancelText ?? t('common.cancel')}
            </Button>
            <Button onClick={submit} disabled={!canSubmit}>
              {options.confirmText ?? t('common.confirm')}
            </Button>
          </div>
        </div>
      </div>
    </ModalPortal>
  )
}

import { describe, expect, it } from 'vitest'

import {
  formatAppList,
  parseAppList,
  reduceResetPhase,
  updateStateLabel,
  type ResetPhase,
} from '@/shell/settings/featuresModel'
import {
  AUTO_SAVE_NOTE,
  countLanguageServers,
  formatLanguageServersText,
  parseLanguageServersText,
} from '@/shell/settings/editorAiModel'
import { errorText } from '@/shell/settings/errorText'

describe('featuresModel · 应用名单', () => {
  it('逗号 / 中文逗号 / 换行都能分隔，且去掉空白与重复', () => {
    expect(parseAppList('excel, notepad\n记事本，excel')).toEqual(['excel', 'notepad', '记事本'])
    expect(parseAppList('')).toEqual([])
    expect(parseAppList('  ,  , \n')).toEqual([])
  })

  it('名单 → 文本用于回填输入框', () => {
    expect(formatAppList(['excel', 'notepad'])).toBe('excel, notepad')
    expect(formatAppList(undefined)).toBe('')
  })
})

describe('featuresModel · 危险重置双重确认', () => {
  it('request → first，confirmFirst → second，confirmSecond → idle', () => {
    let phase: ResetPhase = reduceResetPhase('idle', 'request')
    expect(phase).toBe('first')
    phase = reduceResetPhase(phase, 'confirmFirst')
    expect(phase).toBe('second')
    phase = reduceResetPhase(phase, 'confirmSecond')
    expect(phase).toBe('idle')
  })

  it('cancel 从任一阶段回到 idle', () => {
    expect(reduceResetPhase('first', 'cancel')).toBe('idle')
    expect(reduceResetPhase('second', 'cancel')).toBe('idle')
    expect(reduceResetPhase('idle', 'cancel')).toBe('idle')
  })

  it('跳过第一次确认不会进入第二次', () => {
    expect(reduceResetPhase('idle', 'confirmFirst')).toBe('idle')
    expect(reduceResetPhase('first', 'confirmSecond')).toBe('first')
  })

  it('重复 request 不倒退', () => {
    expect(reduceResetPhase('first', 'request')).toBe('first')
    expect(reduceResetPhase('second', 'request')).toBe('second')
  })
})

describe('featuresModel · 更新状态文案', () => {
  it('覆盖空闲 / 检查中 / 新版本 / 下载中 / 已下载 / 失败', () => {
    expect(updateStateLabel('idle', '')).toBe('已是最新版本')
    expect(updateStateLabel('checking', '')).toBe('检查中…')
    expect(updateStateLabel('available', '0.7.0')).toBe('发现新版本 0.7.0')
    expect(updateStateLabel('available', '')).toBe('发现新版本')
    expect(updateStateLabel('downloading', '')).toBe('下载中…')
    expect(updateStateLabel('downloaded', '')).toBe('已下载，重启后安装')
    expect(updateStateLabel('error', '')).toBe('检查失败')
  })
})

describe('editorAiModel · LSP 服务器行', () => {
  it('解析「语言: 命令」，忽略空行与缺命令的行', () => {
    const text = 'python: pylsp\n\nrust: rust-analyzer\nbroken\ngo:   \n'
    expect(parseLanguageServersText(text)).toEqual({ python: 'pylsp', rust: 'rust-analyzer' })
  })

  it('只有第一个冒号是分隔符（命令里可以带冒号）', () => {
    expect(parseLanguageServersText('kotlin: kotlin-language-server --jvm-args -Xmx:1g')).toEqual({
      kotlin: 'kotlin-language-server --jvm-args -Xmx:1g',
    })
  })

  it('对象 → 文本可往返', () => {
    const text = formatLanguageServersText({ python: 'pylsp', go: 'gopls -mode stdio' })
    expect(text).toBe('python: pylsp\ngo: gopls -mode stdio')
    expect(parseLanguageServersText(text)).toEqual({ python: 'pylsp', go: 'gopls -mode stdio' })
    expect(countLanguageServers({ python: 'pylsp' })).toBe(1)
    expect(countLanguageServers(undefined)).toBe(0)
  })

  it('自动保存的说明不是空话（面板里作为只读行展示）', () => {
    expect(AUTO_SAVE_NOTE).toContain('Ctrl+S')
  })
})

describe('errorText · 错误收敛', () => {
  it('Error / 字符串 / { message } 都取正文', () => {
    expect(errorText(new Error('boom'), '兜底')).toBe('boom')
    expect(errorText('直接给的文案', '兜底')).toBe('直接给的文案')
    expect(errorText({ message: '对象里的文案' }, '兜底')).toBe('对象里的文案')
  })

  it('空值 / 空白 / 未知形状回落到兜底', () => {
    expect(errorText(null, '兜底')).toBe('兜底')
    expect(errorText(undefined, '兜底')).toBe('兜底')
    expect(errorText(new Error('   '), '兜底')).toBe('兜底')
    expect(errorText(42, '兜底')).toBe('兜底')
    expect(errorText({ message: '  ' }, '兜底')).toBe('兜底')
  })
})

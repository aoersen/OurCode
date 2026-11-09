/**
 * 权限模式浮层的纯逻辑：五档语义、循环顺序、当前态摘要。
 *
 * 真值来源是 `src/services/permissions/modePolicy.ts`（`EditMode` 的字面量集合与
 * `MODE_CYCLE`）。这里只补两样东西：
 *  1. 用「人话」解释每一档（设计稿 `detail-01-permission-modes` 的定稿文案）；
 *  2. 目标模式开启时的子集 —— 目标模式自带的流程取代 auto_edit / plan，
 *     和 `chatStore.cycleEditMode` 的轮换集合保持一致（两档：手动 / 自主）。
 *
 * 纯函数、无 store、无 React：选档动作交给调用方走
 * `chatStore.requestEditModeChange(sessionId, mode)`（它会跑原生读授权确认）。
 */
import { MODE_CYCLE, type EditMode } from '@/services/permissions/modePolicy'
import type { MenuLocale } from './locale'

export interface ModeCopy {
  /** 行标题（14px ink） */
  label: string
  /** 行描述（12px muted，设计稿括注里的那句） */
  description: string
  /** 顶部「当前：X · <一句后果>」里的那句后果 */
  consequence: string
}

export const MODE_COPY: Record<EditMode, Record<MenuLocale, ModeCopy>> = {
  confirm_before_change: {
    'zh-CN': {
      label: '手动确认',
      description: '每个工具调用都要你点一下',
      consequence: '每次工具调用都会停下来等你确认',
    },
    'en-US': {
      label: 'Manual confirm',
      description: 'Every tool call waits for your click',
      consequence: 'Every tool call stops and waits for you',
    },
  },
  auto_edit: {
    'zh-CN': {
      label: '自动编辑',
      description: '只在工作区内自动改文件',
      consequence: '工作区内改文件不再询问，命令仍要确认',
    },
    'en-US': {
      label: 'Auto edit',
      description: 'Only edits files inside the workspace',
      consequence: 'Workspace edits run free; commands still ask',
    },
  },
  plan: {
    'zh-CN': {
      label: '计划模式',
      description: '先出计划，批准后才动手',
      consequence: '先只读调研并给出计划，批准前不动文件',
    },
    'en-US': {
      label: 'Plan mode',
      description: 'Plans first, acts after approval',
      consequence: 'Read-only research and a plan; no edits before approval',
    },
  },
  guarded: {
    'zh-CN': {
      label: '自主执行',
      description: '自动批准并自动继续',
      consequence: '自动批准工具调用并自动继续下一轮，危险命令仍需确认一次',
    },
    'en-US': {
      label: 'Autonomous',
      description: 'Auto-approves and keeps going',
      consequence: 'Tool calls approve themselves and the run continues',
    },
  },
  yolo: {
    'zh-CN': {
      label: '完全访问',
      description: '跳过沙箱限制，风险自负',
      consequence: '跳过沙箱与审批限制，后果自负',
    },
    'en-US': {
      label: 'Full access',
      description: 'Skips sandbox limits; risk is yours',
      consequence: 'Sandbox and approval limits are skipped',
    },
  },
}

/** 目标模式开启时仍可选的档位（与 chatStore.cycleEditMode 的集合一致）。 */
export const TARGET_MODE_MODES: readonly EditMode[] = ['confirm_before_change', 'guarded']

export function modeCopy(mode: EditMode, locale: MenuLocale): ModeCopy {
  return MODE_COPY[mode]?.[locale] ?? MODE_COPY.confirm_before_change['zh-CN']
}

export function modeLabel(mode: EditMode, locale: MenuLocale): string {
  return modeCopy(mode, locale).label
}

/** 当前应展示哪一档：未知/空值一律按「手动确认」（modePolicy 的默认分支）。 */
export function normalizeMode(raw: string | null | undefined): EditMode {
  return (MODE_CYCLE as readonly string[]).includes(raw ?? '')
    ? (raw as EditMode)
    : 'confirm_before_change'
}

/** Shift+Tab 的轮换集合；目标模式只轮换 手动/自主 两档。 */
export function modeCycle(targetMode: boolean): EditMode[] {
  return targetMode ? [...TARGET_MODE_MODES] : [...MODE_CYCLE]
}

/** 循环到下一档；当前值不在集合里时回到集合第一档。 */
export function nextMode(current: EditMode, targetMode: boolean): EditMode {
  const cycle = modeCycle(targetMode)
  const index = cycle.indexOf(current)
  return cycle[(index + 1) % cycle.length]
}

export interface ModeMenuItem extends ModeCopy {
  mode: EditMode
}

/** 浮层里的行：顺序与 MODE_CYCLE 一致（手动 → 自动 → 计划 → 自主 → 完全）。 */
export function modeItems(locale: MenuLocale, targetMode: boolean): ModeMenuItem[] {
  return modeCycle(targetMode).map((mode) => ({ mode, ...modeCopy(mode, locale) }))
}

/** 触发器上的当前模式：目标模式下被禁用的档位就近收敛到「手动确认」。 */
export function displayMode(current: EditMode, targetMode: boolean): EditMode {
  const cycle = modeCycle(targetMode)
  return cycle.includes(current) ? current : cycle[0]
}



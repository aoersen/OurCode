/**
 * 「一人公司」Monolith Workspace 极简主题常量。
 *
 * 设计语言(与设计稿「版本 K · 融合采纳版」对齐):
 * 浅灰蓝画布 #f6f7fb + 纯白面板 + 1px 发丝线分隔,零阴影零玻璃拟态(唯一例外:
 * 任务状态彩条);蓝紫渐变仅用于 logo/进度条/激活态/角色头像;9 态状态色是画面中
 * 唯一的彩色,以 6px 圆点 + 等宽大写标签出现;任务指示器 = conic 彩虹环
 * (运行中旋转 → 完成变绿停 → 失败变红)。
 */
import type { OfficeStatus, SubAgentProgress } from '@shared/types'

/** 黑白灰基础 token(办公室窗口内使用,不依赖全局 nova 变量)。 */
export const MONO = {
  bg: '#FFFFFF',
  bgSubtle: '#FAFAFA',
  hover: '#F4F4F5',
  hairline: '#ECECEC',
  ink: '#18181B',
  t1: '#111827',
  t2: '#6B7280',
  t3: '#9CA3AF',
} as const

/** 画布底色(看板/对话面板外层)。 */
export const CANVAS = '#F6F7FB'

/** 蓝紫渐变(品牌 moment:logo/进度条填充/激活态/项目切换胶囊选中)。 */
export const GRADIENT = {
  blue: 'linear-gradient(135deg, #0058bc, #3b82f6)',
  blueViolet: 'linear-gradient(135deg, #0058bc, #8b5cf6)',
  /** 任务状态彩条:conic 彩虹(运行中旋转动画,完成/失败替换为纯色环)。 */
  rainbow: 'conic-gradient(from 0deg, #0058bc, #8b5cf6, #ec4899, #f97316, #0058bc)',
  /** 最新状态汇报条的渐变描边。 */
  statusBorder: 'linear-gradient(90deg, #0058bc, #8b5cf6, #ec4899)',
} as const

/** 角色头像渐变底 + 首字(角色卡 / 对话角色消息 / 任务行角色小头像共用)。 */
export const ROLE_AVATAR: Record<string, { bg: string; char: string }> = {
  产品: { bg: 'linear-gradient(135deg, #a855f7, #7c3aed)', char: '产' },
  需求分析: { bg: 'linear-gradient(135deg, #a855f7, #7c3aed)', char: '产' },
  需求分析师: { bg: 'linear-gradient(135deg, #a855f7, #7c3aed)', char: '需' },
  设计: { bg: 'linear-gradient(135deg, #ec4899, #db2777)', char: '设' },
  'UI 开发': { bg: 'linear-gradient(135deg, #ec4899, #db2777)', char: '设' },
  'UI/UX 设计师': { bg: 'linear-gradient(135deg, #ec4899, #db2777)', char: '设' },
  研发: { bg: 'linear-gradient(135deg, #3b82f6, #0058bc)', char: '研' },
  核心架构师: { bg: 'linear-gradient(135deg, #3b82f6, #0058bc)', char: '研' },
  '业务研发-1': { bg: 'linear-gradient(135deg, #3b82f6, #0058bc)', char: '研' },
  '业务研发-2': { bg: 'linear-gradient(135deg, #3b82f6, #0058bc)', char: '研' },
  测试: { bg: 'linear-gradient(135deg, #34d399, #059669)', char: '测' },
  '自动化测试-1': { bg: 'linear-gradient(135deg, #34d399, #059669)', char: '测' },
  '性能测试-2': { bg: 'linear-gradient(135deg, #34d399, #059669)', char: '测' },
  代码审查: { bg: 'linear-gradient(135deg, #0ea5e9, #0891b2)', char: '审' },
  测试生成: { bg: 'linear-gradient(135deg, #34d399, #059669)', char: '测' },
  调研: { bg: 'linear-gradient(135deg, #f59e0b, #d97706)', char: '调' },
  监管: { bg: 'linear-gradient(135deg, #0058bc, #8b5cf6)', char: '监' },
  架构总监: { bg: 'linear-gradient(135deg, #0058bc, #8b5cf6)', char: '监' },
  子任务: { bg: 'linear-gradient(135deg, #94a3b8, #64748b)', char: '子' },
}

/** 取角色头像:未知角色兜底为灰渐变 + 首字。 */
export function roleAvatar(label: string): { bg: string; char: string } {
  return ROLE_AVATAR[label] ?? { bg: 'linear-gradient(135deg, #94a3b8, #64748b)', char: (label || '?').slice(0, 1) }
}

/** 9 态工位状态 → 圆点色 / 文字色(文字取加深变体保证白底可读)/ 大写标签。 */
export const OFFICE_STATE_META: Record<OfficeStatus, { dot: string; text: string; label: string }> = {
  working: { dot: '#22C55E', text: '#16A34A', label: 'WORKING' },
  thinking: { dot: '#A855F7', text: '#9333EA', label: 'THINKING' },
  receiving: { dot: '#06B6D4', text: '#0891B2', label: 'RECEIVING' },
  reviewing: { dot: '#6366F1', text: '#4F46E5', label: 'REVIEWING' },
  transfer: { dot: '#3B82F6', text: '#2563EB', label: 'TRANSFER' },
  idle: { dot: '#EAB308', text: '#A16207', label: 'IDLE' },
  completed: { dot: '#10B981', text: '#059669', label: 'COMPLETED' },
  error: { dot: '#EF4444', text: '#DC2626', label: 'ERROR' },
  offline: { dot: '#64748B', text: '#64748B', label: 'OFFLINE' },
}

/** 子 Agent 任务态 → 圆点 / 文字色(看板任务行、侧栏任务行共用)。 */
export function taskStateMeta(status: SubAgentProgress['status']): { dot: string; text: string } {
  switch (status) {
    case 'running':
      return OFFICE_STATE_META.working
    case 'done':
      return OFFICE_STATE_META.completed
    default:
      return OFFICE_STATE_META.error
  }
}

/** 任务行 5 态收敛（V12 审查 #7）：运行中/等待输入/已完成/失败/空闲，
 *  每态必须配文字标签，不得仅依赖颜色。新组件（工作台/右栏卡）统一使用。 */
export const TASK_5STATE: Record<
  'running' | 'waiting' | 'done' | 'failed' | 'idle',
  { dot: string; text: string }
> = {
  running: { dot: '#0058BC', text: '#0058BC' },
  waiting: { dot: '#D97706', text: '#D97706' },
  done: { dot: '#16A34A', text: '#16A34A' },
  failed: { dot: '#DC2626', text: '#DC2626' },
  idle: { dot: '#94A3B8', text: '#64748B' },
}

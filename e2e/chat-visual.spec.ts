import { test, expect, _electron as electron } from '@playwright/test'
import { APP_LAUNCH_ARGS } from './helpers'
import path from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * 临时视觉验证 spec —— 用 OURCODE_USER_DATA 沙箱种入一个演示会话，截取聊天区
 * 截图供人工检查「极简纯净版」重构效果。验证完即删（或改回 test.skip）。
 */

const NOW = Date.now()

const SEED_GROUP = {
  id: 'vis-group-1',
  name: '演示配置组',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-demo',
  systemPrompt: '',
  defaultModel: 'gpt-4o',
  provider: 'openai',
  customHeaders: {},
  color: '#3b82f6',
}

const SEED_SESSION = {
  id: 'vis-sess-1',
  title: '实现极简纯净版聊天界面',
  configGroupId: 'vis-group-1',
  model: 'gpt-4o',
  modelParams: {},
  createdAt: NOW - 600_000,
  updatedAt: NOW - 60_000,
  agentMode: 'agent',
  projectEditMode: 'confirm_before_change',
  todos: [
    { id: 'vis-t1', content: '分析用户需求并提取关键组件', status: 'completed' },
    { id: 'vis-t2', content: '生成 React 组件结构', status: 'in_progress' },
    { id: 'vis-t3', content: '应用 Tailwind CSS 样式', status: 'pending' },
    { id: 'vis-t4', content: '编写单元测试用例', status: 'pending' },
  ],
  planContent: JSON.stringify({
    title: '重构聊天消息区为极简纯净版',
    steps: [
      { summary: '更新 ChatMessage 组件视觉', detail: '头像 / 气泡 / 操作栏对齐设计稿' },
      { summary: '重写思考块与工具行样式', detail: 'minimal-panel + hairline 边框' },
      { summary: '调整输入框与头部', detail: '统一 #3B82F6 强调色' },
    ],
  }),
  planStatus: 'pending_approval',
  agentRuns: [
    {
      id: 'vis-run-1',
      status: 'running',
      startedAt: NOW - 12_000,
      tokensIn: 900,
      tokensOut: 300,
      cacheHits: 0,
      cacheTokensSaved: 0,
      cacheReadTokens: 0,
      requestCount: 1,
      toolCallCount: 4,
      fileChangeCount: 2,
    },
  ],
  // 会话绑定项目 —— 验证 agent 模式在项目未重新挂载时也能恢复为 Agent
  projectPath: 'E:\\demo-project',
  messages: [
    {
      id: 'vis-m1',
      role: 'user',
      content:
        '请帮我创建一个包含任务列表、状态展示和代码块的复杂 AI 对话界面。需要使用我们的 Glass Light 设计系统，注重毛玻璃效果和柔和的色彩过渡。',
      sortOrder: 0,
      contextFiles: [],
      tokenCount: 0,
      createdAt: NOW - 600_000,
    },
    {
      id: 'vis-m2',
      role: 'assistant',
      content:
        '我已经为您生成了符合要求的界面结构。这个设计充分利用了 **Glass Light** 系统的核心特性：\n\n- 使用多层次的高斯模糊面板构建空间感\n- 品牌渐变色用于强调和状态指示\n- 圆润的胶囊状按钮和标签\n\n核心组件实现如下：\n\n```tsx\nexport const ChatInterface = () => {\n  return (\n    <div className="minimal-panel rounded-xl p-6">\n      <h2 className="font-headline-md text-primary">\n        AI Assistant\n      </h2>\n    </div>\n  );\n};\n```',
      sortOrder: 1,
      contextFiles: [],
      tokenCount: 0,
      createdAt: NOW - 590_000,
      runId: 'vis-run-1',
      thinking:
        '1. 分析用户请求：需要一个符合 Glass Light 设计系统的复杂 AI 对话 UI。\n2. 确定关键组件：任务清单、用户消息、AI 回复结构、工具调用状态、执行流程图、代码块。\n3. 规划布局：中心化内容流，最大宽度 760px，确保阅读舒适度。\n4. 制定色彩策略：使用 #f6f7fb 基础背景，结合高斯模糊的白色面板和品牌渐变色点缀。',
      toolCalls: [
        { id: 'vis-tc1', name: 'read_file', arguments: { path: 'src/components/ChatLayout.tsx' } },
        { id: 'vis-tc2', name: 'edit_file', arguments: { path: 'src/App.tsx' } },
        { id: 'vis-tc3', name: 'run_command', arguments: { command: 'npm test' } },
        { id: 'vis-tc4', name: 'submit_plan', arguments: { title: '重构聊天消息区为极简纯净版' } },
      ],
      toolResults: [
        { toolCallId: 'vis-tc1', name: 'read_file', result: 'file contents…', isError: false },
        { toolCallId: 'vis-tc2', name: 'edit_file', result: '2 lines changed', isError: false },
        { toolCallId: 'vis-tc3', name: 'run_command', result: '✓ 42 tests passed', isError: false },
        { toolCallId: 'vis-tc4', name: 'submit_plan', result: 'plan submitted', isError: false },
      ],
    },
  ],
}

test('聊天区视觉截图（极简纯净版）', async () => {
  test.setTimeout(120000)
  const userData = mkdtempSync(join(tmpdir(), 'chat-visual-'))
  const app = await electron.launch({
    args: [...APP_LAUNCH_ARGS],
    env: { ...process.env, OURCODE_USER_DATA: userData },
  })

  try {
    // 找到主窗口（跳过自动打开的 DevTools）
    let win: Awaited<ReturnType<typeof app.firstWindow>> | null = null
    for (let i = 0; i < 40 && !win; i++) {
      for (const p of app.windows()) {
        try {
          if (await p.evaluate(() => typeof window.electronAPI !== 'undefined')) {
            win = p
            break
          }
        } catch { /* closed mid-poll */ }
      }
      if (!win) await new Promise((r) => setTimeout(r, 500))
    }
    if (!win) throw new Error('main window not found')
    win.setViewportSize({ width: 1280, height: 860 }).catch(() => {})

    // 种入演示配置组 + 会话（沙箱 userData，不污染真实数据）
    await win.evaluate(
      async ({ group, session }) => {
        // Fresh userData → the first-run onboarding would otherwise block clicks
        localStorage.setItem('hasCompletedOnboarding', 'true')
        try { await (window as any).electronAPI.saveConfigGroup(group) } catch { /* cosmetic — ok */ }
        await (window as any).electronAPI.saveSession(session)
        localStorage.setItem('lastActiveSessionId', session.id)
      },
      { group: SEED_GROUP, session: SEED_SESSION },
    )
    // 刷新让 store 重新水合会话
    await win.reload()
    await win.waitForTimeout(2500)

    // ── DOM 级验证：确认重构后的关键样式真实生效 ──
    const styles = await win.evaluate(() => {
      const cs = (el: Element | null, prop: string) => (el ? getComputedStyle(el).getPropertyValue(prop) : null)
      const root = document.querySelector('.chat-accent') as HTMLElement | null
      const bubble = document.querySelector('.bubble-user') as HTMLElement | null
      const inputBox = document.querySelector('.chat-input-box') as HTMLElement | null
      // 右侧面板主列（白底）
      const chatCol = document.querySelector('.chat-accent .bg-nova-surface') as HTMLElement | null
      // 消息滚动容器（左右内边距应与底部输入框外层一致）
      const msgScroll = document.querySelector('.overflow-y-auto.px-6') as HTMLElement | null
      const inputWrap = document.querySelector('.border-t.border-nova-border.p-3') as HTMLElement | null
      // 工具 chip：找带 font-mono 文字的工具行按钮（read_file/edit_file 等）
      const toolChip = Array.from(document.querySelectorAll('button')).find((b) =>
        b.className.includes('rounded-md') && b.className.includes('border') && !!b.querySelector('.font-mono'),
      ) as HTMLElement | null
      // 计划卡：极简纯净版 V2 内嵌决策卡 —— role=region 且左侧 2px 边线的那张
      const planCard = Array.from(document.querySelectorAll('[role="region"]')).find(
        (p) => getComputedStyle(p).borderLeftWidth === '2px',
      ) as HTMLElement | null
      // 计划批准主按钮：白卡内 bg-nova-accent 电光蓝按钮（「同意并执行」）
      const planBtn = planCard ? planCard.querySelector('button.bg-nova-accent') : null
      return {
        hasChatAccentScope: !!root,
        chatAccent: root ? cs(root, '--accent') : null,
        hasPlanCard: !!planCard,
        planBg: planCard ? cs(planCard, 'background-color') : null,
        planBorder: planCard ? cs(planCard, 'border-top-color') : null,
        planRadius: planCard ? cs(planCard, 'border-radius') : null,
        // 图标已从连字字体改为内联 SVG（MSIcon），按 data-icon 认图标名
        thinkingHasPsychologyIcon: !!document.querySelector('svg[data-icon="psychology"]'),
        // 思考块不应再是 minimal-panel 大框：psychology 图标所在容器应没有
        // 卡片边框（父级链上无 .minimal-panel）
        thinkingNotInPanel: (() => {
          const icon = document.querySelector('svg[data-icon="psychology"]')
          return icon ? !icon.closest('.minimal-panel') : null
        })(),
        bubbleBg: bubble ? cs(bubble, 'background-color') : null,
        bubbleBorder: bubble ? cs(bubble, 'border-top-color') : null,
        planBtnBg: planBtn ? cs(planBtn, 'background-color') : null,
        planLeftBar: planCard ? cs(planCard, 'border-left-color') : null,
        inputRadius: inputBox ? cs(inputBox, 'border-radius') : null,
        // 右侧面板底色 = 白（mockup #ffffff）
        panelBg: chatCol ? cs(chatCol, 'background-color') : null,
        // 消息列左右内边距 24px（输入框外层保持原样 12px）
        msgPadX: msgScroll ? cs(msgScroll, 'padding-left') : null,
        inputPadX: inputWrap ? cs(inputWrap, 'padding-left') : null,
        toolChipBg: toolChip ? cs(toolChip, 'background-color') : null,
        toolChipBorder: toolChip ? cs(toolChip, 'border-top-color') : null,
        // 消息左侧不应再有机器人头像（smart_toy 已从消息行移除；种子会话无子代理，
        // 若消息滚动容器里还出现说明头像没删干净 —— 注意：AgentStatusMiniPanel
        // 胶囊的 smart_toy 在容器外，不在此列）
        messageAvatarRemoved: !(msgScroll ? msgScroll.innerHTML.includes('smart_toy') : false),
      }
    })
    console.log('CHAT_VISUAL_STYLES', JSON.stringify(styles, null, 2))
    // 断言核心样式
    expect(styles.hasChatAccentScope).toBe(true)
    // 浅色模式不再把 accent 硬编码成蓝色：面板继承 --primary-color（默认 #0058bc）
    expect(styles.chatAccent).toBe('#0058bc')
    expect(styles.hasPlanCard).toBe(true)
    expect(styles.planBg).toBe('rgb(255, 255, 255)')
    expect(styles.planBorder).toBe('rgba(15, 23, 42, 0.08)')
    expect(styles.planRadius).toBe('12px')
    expect(styles.thinkingHasPsychologyIcon).toBe(true)
    expect(styles.thinkingNotInPanel).toBe(true)
    expect(styles.bubbleBg).toBe('rgb(241, 245, 249)')
    expect(styles.bubbleBorder).toBe('rgba(0, 0, 0, 0)')
    expect(styles.planBtnBg).toBe('rgb(0, 88, 188)')
    expect(styles.planLeftBar).toBe('rgb(0, 88, 188)')
    expect(styles.inputRadius).toBe('12px')
    expect(styles.panelBg).toBe('rgb(255, 255, 255)')
    expect(styles.msgPadX).toBe('24px')
    expect(styles.inputPadX).toBe('12px')
    expect(styles.messageAvatarRemoved).toBe(true)

    await win.screenshot({ path: 'test-results/chat-visual-1-default.png' })

    // 焦点轮廓回归：全局 :focus-visible accent 环不能落在文本输入上 —— 文本输入
    // 即使鼠标点击也会命中 :focus-visible，曾导致输入框选中时在文本区上下各画出
    // 一条全宽蓝线（「两条横线」问题）。点击聚焦后 outline 必须是透明的。
    await win.locator('textarea[data-ai-input]').click()
    await win.waitForTimeout(300)
    const focusOutline = await win.evaluate(() => {
      const ta = document.querySelector('textarea[data-ai-input]') as HTMLElement | null
      if (!ta) return null
      const cs = getComputedStyle(ta)
      return { color: cs.outlineColor, width: cs.outlineWidth }
    })
    expect(focusOutline).not.toBeNull()
    expect(focusOutline!.color).toBe('rgba(0, 0, 0, 0)')
    // 焦点指示并未丢失：容器边框转 accent（原设计保留）
    const focusBoxBorder = await win.evaluate(() => {
      const box = document.querySelector('.chat-input-box') as HTMLElement | null
      return box ? getComputedStyle(box).borderTopColor : null
    })
    expect(focusBoxBorder).toBe('rgb(0, 88, 188)')

    // 展开「思考与执行过程」块再截一张 + 验证工具 chip 样式
    const toggle = win.getByText('思考与执行过程').first()
    if (await toggle.isVisible().catch(() => false)) {
      await toggle.click()
      await win.waitForTimeout(600)
      await win.screenshot({ path: 'test-results/chat-visual-2-expanded.png' })

      const chip = await win.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(
          (b) => b.className.includes('rounded-md') && b.className.includes('border') && !!b.querySelector('.font-mono'),
        ) as HTMLElement | null
        if (!btn) return null
        const cs = getComputedStyle(btn)
        const icon = btn.querySelector('svg[data-icon]')
        const name = btn.querySelector('.font-mono')
        const path = Array.from(btn.querySelectorAll('span')).find((s) => s.className.includes('max-w-[100px]'))
        return {
          bg: cs.backgroundColor,
          border: cs.borderTopColor,
          iconText: icon?.getAttribute('data-icon') ?? null,
          nameSize: name ? getComputedStyle(name).fontSize : null,
          pathMaxW: path ? getComputedStyle(path).maxWidth : null,
        }
      })
      console.log('CHIP_STYLES', JSON.stringify(chip))
      expect(chip).not.toBeNull()
      expect(chip!.bg).toBe('rgb(255, 255, 255)')
      expect(chip!.border).toBe('rgb(226, 232, 240)')
      // mockup：状态图标在前（check/sync/close），工具名 13px mono，路径截断 100px
      expect(['check', 'sync', 'close']).toContain(chip!.iconText)
      expect(chip!.nameSize).toBe('13px')
      expect(chip!.pathMaxW).toBe('100px')
    }
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
})

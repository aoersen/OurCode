import { test, expect } from '@playwright/test'
import { dismissOnboarding, launchApp } from './helpers'

/**
 * Claw 渠道接入面板的端到端验收。
 *
 * 替代原先的浏览器面板用例（那个面板已被 Claw 接入替换）：确认活动栏里是
 * Claw 图标而不是浏览器图标、点开后能看到五个渠道与接入控制区块、且渠道状态
 * 来自主进程（而不是前端写死的占位）。
 */
test.describe('Claw 渠道接入面板', () => {
  test('渠道接入入口在设置「工具」分组里', async () => {
    const { app, userData } = await launchApp()
    try {
      const win = await app.firstWindow()
      await dismissOnboarding(win)
      // 左侧活动栏已移除：Claw 面板迁到设置。
      await win.locator('button[title="设置"]').first().click()
      await expect(
        win.locator('button[role="tab"]', { hasText: '渠道接入' }).first(),
      ).toBeVisible({ timeout: 15_000 })
    } finally {
      await app.close()
      void userData
    }
  })

  test('面板列出五个渠道，并展示接入控制与网关状态', async () => {
    const { app } = await launchApp()
    try {
      const win = await app.firstWindow()
      // 首启引导层是 fixed inset-0 的遮罩，不关掉会拦住一切点击（详见 helpers）
      await dismissOnboarding(win)
      await win.locator('button[title="设置"]').first().click()
      await win.locator('button[role="tab"]', { hasText: '渠道接入' }).first().click()

      // 五个渠道都渲染出来（渠道目录来自 shared/claw.ts，这里验证它真的到了界面上）
      for (const label of ['微信', '企业微信', 'QQ', '飞书', 'Telegram']) {
        await expect(win.locator(`text=${label}`).first()).toBeVisible({ timeout: 10_000 })
      }
      // 接入控制区块与底部网关状态行
      await expect(win.locator('text=ACCESS CONTROL').first()).toBeVisible()
      await expect(win.locator('text=/Claw 网关/').first()).toBeVisible()
      // 状态徽章来自主进程（默认只有微信启用 → 其余显示「已停用」）
      await expect(win.locator('text=已停用').first()).toBeVisible()
      // 网关产物必须被找到（路径解析回归守卫：曾经拼成 dist-electron/out/...，
      // 表现成微信卡片上一句「连接失败」）
      await expect(win.locator('text=连接失败')).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  test('设置页的凭据字段极简：每个渠道最多两个输入框，没有回调/密钥类字段', async () => {
    const { app } = await launchApp()
    try {
      const win = await app.firstWindow()
      await dismissOnboarding(win)
      await win.click('button[title="设置"], button[aria-label="设置"]')
      await win.click('text=功能')
      await win.waitForTimeout(600)

      // 凭据表单：每个字段是一个 <label> 包着 <input>，第一个 <span> 就是字段名
      // （第二个 span 是说明文字，不能算进去——说明里会提到「无需回调地址」）
      const fieldLabels = async (): Promise<string[]> =>
        win.evaluate(() =>
          Array.from(document.querySelectorAll('label'))
            .filter((label) => label.querySelector('input') !== null)
            .map((label) => (label.querySelector('span')?.textContent ?? '').trim())
            .filter(Boolean),
        )

      await win.click('text=企业微信')
      await win.waitForTimeout(300)
      const wecom = await fieldLabels()
      expect(wecom).toHaveLength(2)
      expect(wecom.join(' ')).toContain('机器人 ID')
      expect(wecom.join(' ')).toContain('Secret')
      // 回调那套配置（企业微信其他接入方式才需要）不该出现在这里
      expect(wecom.join(' ')).not.toMatch(/CorpID|AgentId|EncodingAESKey|Token|端口|回调地址/)

      await win.click('text=Telegram')
      await win.waitForTimeout(300)
      const tg = await fieldLabels()
      expect(tg).toHaveLength(1)
      expect(tg[0]).toContain('Bot Token')

      await win.click('text=QQ')
      await win.waitForTimeout(300)
      const qq = await fieldLabels()
      // 两个凭据 + 一个沙箱开关
      expect(qq).toHaveLength(3)
      expect(qq.join(' ')).not.toMatch(/回调|密钥|端口/)

      // 连接方式必须在界面上写清楚（用户不该去翻文档才知道不用回调地址）
      expect(await win.evaluate(() => document.body.innerText)).toContain('长连接')
    } finally {
      await app.close()
    }
  })

  test('凭据不全时能从面板直接跳到该渠道的设置表单', async () => {
    const { app } = await launchApp()
    try {
      const win = await app.firstWindow()
      await dismissOnboarding(win)
      await win.locator('button[title="设置"]').first().click()
      await win.locator('button[role="tab"]', { hasText: '渠道接入' }).first().click()

      // 启用企业微信（默认关闭，且没有凭据）→ 卡片上应出现提示 + 直达入口
      const wecomToggle = win.locator('button[aria-label="启用/停用 企业微信"]').first()
      await wecomToggle.click()
      await expect(win.locator('text=凭据未配置完整').first()).toBeVisible({ timeout: 8000 })
      const jump = win.locator('button:has-text("去设置")').first()
      await expect(jump).toBeVisible()

      // 点「去设置」→ 设置面板打开，且直接落在该渠道的表单上（而不是默认的 API 配置页）
      await jump.click()
      await expect(win.locator('text=Claw 渠道接入').first()).toBeVisible({ timeout: 8000 })
      await expect(
        win.locator('input[placeholder*="智能机器人"]').first(),
      ).toBeVisible({ timeout: 8000 })
      // 表单是这个渠道的（有机器人 ID 字段），不是别的渠道
      await expect(win.locator('label:has-text("机器人 ID")').first()).toBeVisible()
    } finally {
      await app.close()
    }
  })

  test('渠道状态来自主进程：默认只有微信是启用态', async () => {
    const { app } = await launchApp()
    try {
      const win = await app.firstWindow()
      await dismissOnboarding(win)
      // 直接问主进程：面板上的状态与它必须一致（渠道目录、默认开关都来自主进程）
      const status = await win.evaluate(async () => {
        return (window as unknown as { electronAPI: { getClawStatus: () => Promise<unknown> } }).electronAPI.getClawStatus()
      })
      const channels = (status as { channels: Array<{ id: string; enabled: boolean }> }).channels
      expect(channels.map((c) => c.id)).toEqual(['wechat', 'wecom', 'qq', 'feishu', 'telegram'])
      expect(channels.find((c) => c.id === 'wechat')?.enabled).toBe(true)
      expect(channels.filter((c) => c.enabled)).toHaveLength(1)
    } finally {
      await app.close()
    }
  })
})

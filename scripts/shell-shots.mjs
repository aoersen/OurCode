import { chromium } from '@playwright/test';
import fs from 'node:fs';

/**
 * 新壳截图工具（本地预览，不启 Electron）。
 *
 *   1) 起预览：npx vite --config vite.config.preview.ts      # 端口 5199
 *   2) 截图： $env:CHROME_PATH="<chromium>/chrome.exe"; node scripts/shell-shots.mjs
 *
 * 产物：E:/ls/ideUtil/.tmp/shell-shots/*.png
 */
const OUT = 'E:/ls/ideUtil/.tmp/shell-shots';
fs.mkdirSync(OUT, { recursive: true });
const BASE = 'http://localhost:5199/shell.html';
const CHROME = process.env.CHROME_PATH;

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const done = [];

async function session(viewport, work) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  await page.goto(`${BASE}?bubble=expanded&artifact=plan`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await work(page);
  await page.close();
}

const snap = async (page, name) => {
  await page.waitForTimeout(420);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  done.push(name);
};

// 默认 / 菜单 / 面板 / 管理面 / 一人公司 / 设置（1440x900）
await session({ width: 1440, height: 900 }, async (page) => {
  await snap(page, '01-default');

  await page.locator('button:has-text("手动确认"), button:has-text("自动执行"), button:has-text("自主执行")').first().click();
  await snap(page, '02-modes');
  await page.keyboard.press('Escape');

  await page.locator('button:has-text("Claude"), button:has-text("Sonnet")').first().click();
  await snap(page, '03-model');
  await page.keyboard.press('Escape');

  await page.getByRole('tab', { name: '变更' }).click();
  await snap(page, '04-changes');

  await page.locator('button:has-text("管理")').first().click().catch(() => {});
  await snap(page, '05-manage');

  await page.locator('button[aria-label="一人公司"]').first().click().catch(() => {});
  await snap(page, '06-office');
  await page.keyboard.press('Escape');

  await page.locator('button[aria-label="设置"]').first().click().catch(() => {});
  await snap(page, '07-settings');
  await page.keyboard.press('Escape');
});

// 暗色
await session({ width: 1440, height: 900 }, async (page) => {
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await snap(page, '08-dark');
});

// 窄窗（< 1024）：左栏自动收起，产物面板走抽屉
await session({ width: 900, height: 820 }, async (page) => {
  await snap(page, '09-narrow');
  await page.getByRole('tab', { name: '文件' }).click().catch(() => {});
  await snap(page, '10-narrow-drawer');
});

await browser.close();
console.log('shots:', done.join(', '));

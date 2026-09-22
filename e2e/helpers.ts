/**
 * Shared launch/dismiss helpers for the Electron e2e suite.
 *
 * Every spec used to launch `dist-electron/main.js` with the developer's real
 * userData and no locale control. That broke the suite on CI in two ways:
 *
 * 1. A fresh profile shows the first-run onboarding modal (App.tsx gates it on
 *    localStorage.hasCompletedOnboarding), and its `fixed inset-0 z-[300]`
 *    overlay swallows every click. Locally the flag was already set in the real
 *    profile, which is why the failure only ever appeared on CI. The old
 *    dismissal helper also matched the Chinese aria-label only, so on CI's
 *    en-US locale it silently no-opped.
 * 2. The app resolves its 'system' language preference against app.getLocale(),
 *    so every label flipped to English on CI and specs asserting Chinese labels
 *    failed.
 *
 * `launchApp` pins the locale the specs are written for and isolates userData;
 * `dismissOnboarding` waits for the modal instead of sampling the DOM once.
 */
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Pin the renderer locale. The suite asserts on Chinese labels (11 specs) and
 * app.getLocale() is en-US on GitHub's ubuntu runners, which silently flipped
 * every label mid-CI. Forcing the switch keeps a run identical on any machine.
 */
const FORCED_LOCALE = '--lang=zh-CN'

const APP_ENTRY = join(__dirname, '../dist-electron/main.js')

/**
 * Args for launching the built app: entry point + the pinned locale. Specs that
 * build their own `electron.launch` call (to keep a bespoke window-finding
 * helper) should spread this instead of hardcoding the entry path.
 */
export const APP_LAUNCH_ARGS: string[] = [APP_ENTRY, FORCED_LOCALE]

/** The onboarding dialog's aria-label in every shipped locale (zh-CN, en-US). */
const ONBOARDING_DIALOG = ['欢迎使用', 'Welcome']
  .map((label) => `[role="dialog"][aria-label="${label}"]`)
  .join(', ')

/** Create a throwaway userData dir (the app reads it via OURCODE_USER_DATA). */
export function makeUserData(prefix = 'ourcode-e2e-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Remove a userData dir created by {@link makeUserData}. */
export function dropUserData(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

/**
 * Launch the built app against a throwaway userData, so specs never read or
 * write the developer's real profile. Pass an existing `userData` to relaunch
 * against the same profile — persistence specs (hot-exit, filetree-restore,
 * editor-close, unsaved-close) depend on both launches sharing it.
 */
export async function launchApp(
  opts: { userData?: string; args?: string[] } = {},
): Promise<{ app: ElectronApplication; userData: string }> {
  const userData = opts.userData ?? makeUserData()
  const app = await electron.launch({
    args: [...APP_LAUNCH_ARGS, ...(opts.args ?? [])],
    env: { ...process.env, OURCODE_USER_DATA: userData },
  })
  return { app, userData }
}

/**
 * Dismiss the first-run onboarding modal.
 *
 * It mounts only AFTER the app's async boot finishes (config/session/project
 * restore), so wait for it rather than sampling the DOM once — the previous
 * splash-based heuristic returned ~1.6 s in and left the overlay up.
 *
 * Safe to call repeatedly and cheap on an already-onboarded profile, which is
 * the case for the second launch of a relaunch spec.
 */
export async function dismissOnboarding(win: Page): Promise<void> {
  // The modal is gated on this flag, so a profile that already completed
  // onboarding will not show one — don't pay the wait below. The visibility
  // probe still runs because the office window shares localStorage but
  // initializes separately: a modal can be up while the flag already reads
  // 'true'.
  const completed = await win
    .evaluate(() => localStorage.getItem('hasCompletedOnboarding'))
    .catch(() => null)
  const showing = await win.locator(ONBOARDING_DIALOG).first().isVisible().catch(() => false)
  if (completed === 'true' && !showing) return

  const dialog = win.locator(ONBOARDING_DIALOG).first()
  try {
    await dialog.waitFor({ state: 'visible', timeout: 20000 })
  } catch {
    return
  }
  // "暂时跳过 / Skip for now" is the first button of the modal's action row.
  await dialog.locator('button').first().click()
  await dialog.waitFor({ state: 'detached', timeout: 10000 }).catch(() => {})
}

/**
 * A minimal config group. The office view only needs one to EXIST: the office
 * window auto-creates a session when a config group is configured.
 */
const SEED_CONFIG_GROUP = {
  id: 'e2e-seeded-group',
  name: 'E2E Seeded',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-e2e-seeded',
  systemPrompt: '',
  defaultModel: 'gpt-4o',
  provider: 'openai',
  customHeaders: {},
  color: '#3b82f6',
}

/**
 * Seed an API config group so the office view renders its real layout.
 *
 * Without an active session OfficeChatPane renders its empty state with
 * `h-full`, collapsing the whole scene/workbench row to zero height — the 场景
 * tab then sits behind the chat pane and cannot be clicked. The office window
 * only auto-creates a session when a config group exists, and a fresh profile
 * has none, so specs driving the office view must seed one. (They used to rely
 * on the developer's real profile already having one, which is why office-view
 * failed on CI, where the profile is always fresh.)
 *
 * Writes through IPC rather than walking the onboarding modal: same mechanism
 * the other seeding specs use, no UI interaction to go flaky. The reload is what
 * lets App.tsx pick the group up on boot. saveConfigGroup only writes to the
 * local store; no network call is made.
 */
export async function seedApiConfig(win: Page): Promise<void> {
  await win.evaluate(async (group) => {
    localStorage.setItem('hasCompletedOnboarding', 'true')
    await (window as any).electronAPI.saveConfigGroup(group)
  }, SEED_CONFIG_GROUP)
  await win.reload()
  await win.waitForTimeout(2000)
}

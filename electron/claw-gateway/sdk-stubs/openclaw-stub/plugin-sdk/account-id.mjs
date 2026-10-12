/**
 * Stub for `openclaw/plugin-sdk/account-id`. The Weixin protocol layer calls
 * this to normalize account ids like "b0f5860fdecb@im.bot" into
 * filesystem-safe ids like "b0f5860fdecb-im-bot" (mirrors the plugin's
 * deriveRawAccountId patterns).
 */

export function normalizeAccountId(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/[@.]/g, "-")
}

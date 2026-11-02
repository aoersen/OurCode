/**
 * Computer Use — main-process policy façade.
 *
 * The rules themselves live in `shared/computerPolicy.ts` so the renderer can
 * explain a refusal before the call is sent. This module only re-exports them
 * under the name the service imports, keeping one implementation.
 */
export {
  BUILTIN_DENY_PATTERNS,
  DANGER_VERBS,
  analyzeActionDanger,
  checkAppAllowed,
  looksLikeCredential,
  matchesDenyList,
} from '../../../shared/computerPolicy'
export type { DangerVerdict, PolicyPrefs, PolicyVerdict } from '../../../shared/computerPolicy'

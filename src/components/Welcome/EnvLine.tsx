/**
 * One quiet status line at the bottom of the welcome canvas.
 *
 * A healthy environment needs a single sentence, not a four-cell dashboard with
 * a "manage" link in every cell — that earlier version spent a whole band of
 * the first screen on controls nobody needed before typing. Only the model
 * state is allowed to draw attention, because an unconfigured model is the one
 * condition that blocks the primary action.
 */
import { useI18n } from '@/i18n/useI18n'
import { executeCommand } from '@/services/commands/commandRegistry'
import { formatTokenCount } from '@/services/llm/contextUsage'
import type { WelcomeEnv } from './useWelcomeData'

interface EnvLineProps {
  env: WelcomeEnv
}

function Dot({ tone }: { tone: 'ok' | 'muted' | 'warn' }) {
  const cls =
    tone === 'ok' ? 'bg-emerald-500' : tone === 'warn' ? 'bg-orange-500' : 'bg-nova-text-muted/50'
  return <span className={`w-1.5 h-1.5 rounded-full ${cls}`} aria-hidden />
}

export default function EnvLine({ env }: EnvLineProps) {
  const t = useI18n()

  const items: Array<{ key: string; label: string; tone: 'ok' | 'muted' | 'warn'; onClick?: () => void }> = []

  items.push({
    key: 'model',
    label: `${t('welcome.env.model')} ${env.modelConfigured ? env.modelName : t('welcome.env.modelMissing')}`,
    tone: env.modelConfigured ? 'ok' : 'warn',
    onClick: () => executeCommand('openSettings'),
  })

  if (env.mcpCount !== null) {
    items.push({
      key: 'mcp',
      label: `${t('welcome.env.mcp')} ${env.mcpCount}`,
      tone: env.mcpCount > 0 ? 'ok' : 'muted',
      onClick: () => executeCommand('openMcpCenter'),
    })
  }

  if (env.skillCount !== null) {
    items.push({
      key: 'skills',
      label: `${t('welcome.env.skills')} ${env.skillCount}`,
      tone: env.skillCount > 0 ? 'ok' : 'muted',
      onClick: () => executeCommand('openSkillRegistry'),
    })
  }

  if (env.contextKnown && env.contextWindow > 0) {
    items.push({
      key: 'context',
      label: `${t('welcome.env.context')} ${formatTokenCount(env.contextUsed)} / ${formatTokenCount(env.contextWindow)}`,
      tone: 'muted',
    })
  }

  return (
    <div className="pt-4 border-t border-nova-border flex items-center gap-2 flex-wrap text-[11.5px] text-nova-text-muted">
      {items.map((item, index) => (
        <span key={item.key} className="flex items-center gap-2">
          {index > 0 && <span className="text-nova-text-muted/40" aria-hidden>·</span>}
          {item.onClick ? (
            <button
              type="button"
              onClick={item.onClick}
              className="flex items-center gap-1.5 rounded transition-colors hover:text-nova-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nova-accent/30"
            >
              <Dot tone={item.tone} />
              {item.label}
            </button>
          ) : (
            <span className="flex items-center gap-1.5">
              <Dot tone={item.tone} />
              {item.label}
            </span>
          )}
        </span>
      ))}

      <span className="flex-1" />
      <button
        type="button"
        onClick={() => executeCommand('openSettings')}
        className="rounded text-nova-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nova-accent/30"
      >
        {t('welcome.env.settings')}
      </button>
    </div>
  )
}

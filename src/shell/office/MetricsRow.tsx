/**
 * 指标卡一行（3–4 个）：营收 / 产能 / 待办 / 工时。
 *
 * 没有卡片描边、没有底色 —— 只有 24px 的 ink 数字、12px 的 muted 标签和留白。
 * 没有数据源的那一项（营收）显示灰色「未接入」，不填假数字。
 */
import type { OfficeMetric } from './officeModel'

export default function MetricsRow({ metrics }: { metrics: ReadonlyArray<OfficeMetric> }) {
  return (
    <div className="shrink-0 flex items-start gap-10 pt-3" data-testid="office-metrics-row">
      {metrics.map((metric) => (
        <div key={metric.key} title={metric.title} className="min-w-0" data-metric={metric.key}>
          <div className="flex items-baseline gap-1">
            <span
              className={
                metric.wired
                  ? 'text-[24px] leading-[30px] text-[var(--pure-ink)] tabular-nums'
                  : 'text-[13px] leading-[30px] text-[var(--pure-muted)]'
              }
            >
              {metric.value}
            </span>
            {metric.suffix ? (
              <span className="text-[12px] leading-[18px] text-[var(--pure-muted)] tabular-nums">{metric.suffix}</span>
            ) : null}
          </div>
          <div className="text-[12px] leading-[18px] text-[var(--pure-muted)]">{metric.label}</div>
        </div>
      ))}
    </div>
  )
}

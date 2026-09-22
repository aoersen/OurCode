/**
 * 右栏「产出物」卡（V12 审查 #6）：finalGoal + 各角色落盘的交付物（agents/*.md），
 * 点击在编辑器打开。数据来自 dashboardData.listDeliverables（5s 轮询）。
 */
import { useEffect, useState } from 'react'
import { useI18n } from '@/i18n/useI18n'
import { useUIStore } from '@/stores/uiStore'
import { useEditorStore } from '@/stores/editorStore'
import { listDeliverables, type Deliverable } from '@/services/targetMode/dashboardData'

export default function ArtifactsCard({ active = true }: { active?: boolean }) {
  const t = useI18n()
  const rootPath = useUIStore((s) => s.rootPath)
  const openFile = useEditorStore((s) => s.openFile)
  const [deliverables, setDeliverables] = useState<Deliverable[]>([])
  const [hasGoal, setHasGoal] = useState(false)

  useEffect(() => {
    if (!rootPath || !active) return
    let alive = true
    const load = () => {
      listDeliverables(rootPath).then((list) => {
        if (!alive) return
        setDeliverables(list.slice(0, 5))
        window.electronAPI
          .readFile(`${rootPath.replace(/[\\/]+$/, '')}/.ourcode/targemode/finalGoal.md`)
          .then((r) => {
            if (alive) setHasGoal(!!r.content)
          })
          .catch(() => {
            if (alive) setHasGoal(false)
          })
      })
    }
    load()
    const timer = window.setInterval(load, 5000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [rootPath, active])

  const goalPath = rootPath
    ? `${rootPath.replace(/[\\/]+$/, '')}/.ourcode/targemode/finalGoal.md`
    : null

  return (
    <div
      data-testid="office-artifacts-card"
      className="shrink-0 rounded-xl border px-3.5 py-3"
      style={{ background: '#fff', borderColor: 'rgba(15,23,42,0.08)' }}
    >
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[13px] font-bold" style={{ color: '#0f172a' }}>
          {t('office.artifacts')}
        </span>
      </div>

      {hasGoal && goalPath && (
        <button
          onClick={() => void openFile(goalPath)}
          className="w-full flex items-center gap-2 py-2 px-1 text-left rounded-md transition-colors hover:bg-[#F4F4F5]"
          style={{ borderBottom: '1px solid rgba(15,23,42,0.08)' }}
        >
          <span style={{ fontSize: 13 }}>📄</span>
          <span className="flex-1 truncate" style={{ fontSize: 12, color: '#334155' }}>
            finalGoal.md
          </span>
          <span className="text-xs flex-none" style={{ color: '#0058bc' }}>
            {t('office.open')}
          </span>
        </button>
      )}

      {deliverables.length === 0 && !hasGoal ? (
        <div className="text-xs py-2" style={{ color: '#94a3b8' }}>
          {t('office.noDeliverables')}
        </div>
      ) : (
        deliverables.map((d) => (
          <button
            key={d.path}
            onClick={() => void openFile(d.path)}
            className="w-full flex items-center gap-2 py-2 px-1 text-left rounded-md transition-colors hover:bg-[#F4F4F5]"
          >
            <span style={{ fontSize: 13 }}>📄</span>
            <span className="flex-1 truncate" style={{ fontSize: 12, color: '#334155' }}>
              {d.name}
            </span>
            <span className="text-xs flex-none" style={{ color: '#0058bc' }}>
              {t('office.open')}
            </span>
          </button>
        ))
      )}
    </div>
  )
}

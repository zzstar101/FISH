import { Card } from '@fish/ui/card'
import { useState } from 'react'
import { ApiError } from '../../lib/api-client'
import {
  GOVERNANCE_ACTION_LABEL,
  RESTRICTION_STATUS_LABEL,
  RESTRICTION_TYPE_LABEL,
  statusLabel,
} from './display'
import { type GovernanceAction, useGovernanceAction } from './queries'

/**
 * 治理面板（#73 治理半场 PR3）：商品详情 / 用户详情共用的「动作 + 原因 + 二次确认」。
 *
 * 设计取舍：
 * - 原因必填并写进审计（不可抵赖），所以这里不提供「跳过原因」的快捷路径；
 * - 二次确认用 `window.confirm` 而不做弹层——下架 / 封禁是低频高危操作，
 *   多一个依赖换来的是更少的遮挡，与管理后台整体风格一致；
 * - 409 `GOVERNANCE_CONFLICT` 是预期分支（并发），单独成条提示，让操作者知道
 *   「有人先做了」而不是「你失败了」，因为此时目标状态确实已经变了。
 */
export type GovernanceActionSpec = {
  action: GovernanceAction
  label: string
  /** 触发按钮的角色色；danger 类用红色，避免误点。 */
  tone?: 'primary' | 'danger'
  description: string
}

export function GovernancePanel({
  targetId,
  actions,
}: {
  targetId: string
  actions: GovernanceActionSpec[]
}) {
  const governance = useGovernanceAction()
  const [reason, setReason] = useState('')
  const [pendingAction, setPendingAction] = useState<GovernanceAction | null>(null)

  const conflict =
    governance.error instanceof ApiError && governance.error.code === 'GOVERNANCE_CONFLICT'

  const submit = (spec: GovernanceActionSpec) => {
    if (!reason.trim() || governance.isPending) return
    if (!window.confirm(`确认执行「${spec.label}」吗？该操作会写入不可撤销的审计日志。`)) return
    setPendingAction(spec.action)
    governance.mutate(
      { action: spec.action, targetId, input: { reason: reason.trim() } },
      { onSettled: () => setPendingAction(null) },
    )
  }

  if (actions.length === 0) return null

  return (
    <Card className="space-y-3 p-4">
      <div>
        <h2 className="font-semibold text-[15px]">治理动作</h2>
        <p className="mt-1 text-sm text-ink-3">
          业务变更与审计写入在同一事务内完成，原因必填。并发操作时先到者生效，后到者会收到明确提示。
        </p>
      </div>

      <textarea
        className="min-h-20 w-full rounded-lg border border-line bg-surface p-2 text-sm outline-none focus:border-brand"
        maxLength={500}
        onChange={(event) => setReason(event.target.value)}
        placeholder="治理原因（必填，最多 500 字，将写入审计日志）"
        value={reason}
      />

      <div className="flex flex-wrap gap-2">
        {actions.map((spec) => (
          <button
            className={`rounded-lg px-3 py-1.5 text-sm text-white disabled:opacity-40 ${
              spec.tone === 'danger' ? 'bg-red-600' : 'bg-brand'
            }`}
            disabled={!reason.trim() || governance.isPending}
            key={spec.action}
            onClick={() => submit(spec)}
            type="button"
          >
            {governance.isPending && pendingAction === spec.action ? '提交中…' : spec.label}
          </button>
        ))}
      </div>

      {governance.isSuccess ? (
        <p className="text-sm text-green-700">
          {statusLabel(GOVERNANCE_ACTION_LABEL, governance.data.action)}
          {governance.data.restriction
            ? ` · ${statusLabel(RESTRICTION_TYPE_LABEL, governance.data.restriction.type)} · ${statusLabel(
                RESTRICTION_STATUS_LABEL,
                governance.data.restriction.status,
              )}`
            : ''}
          {governance.data.listingStatus ? ` · 商品状态 ${governance.data.listingStatus}` : ''}
        </p>
      ) : null}

      {governance.isError ? (
        <p className="text-sm text-red-600">
          {conflict
            ? '该目标已被其他管理员处理过，当前状态可能已变化，请刷新后查看。'
            : `操作失败：${governance.error.message}`}
        </p>
      ) : null}
    </Card>
  )
}

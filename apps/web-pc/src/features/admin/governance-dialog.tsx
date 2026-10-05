import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@fish/ui/dialog'
import { Input } from '@fish/ui/input'
import { useState } from 'react'
import { validateReason } from './admin-view'

/**
 * 治理写操作的确认弹窗（#467 验收「高风险操作」）：明确展示目标 + 原因必填（1–500）+
 * 可选回链举报单 / 可选到期时间。提交失败**渲染在弹窗内部**（radix 遮罩会盖住页面级
 * 通知，#448 审查教训），冲突时由调用方决定关闭与否。
 */

/** 提交给治理 mutation 的形状：sourceReportId 已过前缀守卫（品牌类型）。 */
export type GovernanceDialogOutput = {
  reason: string
  sourceReportId?: `rpt_${string}`
  expiresAt?: string
}

/**
 * 关联举报单的前缀守卫：匹配时把输入收窄成契约的 `rpt_${string}` 品牌类型，
 * 让「报出去的 id 一定是举报单前缀」在类型层成立（存在性仍由服务端 404/422 兜底）。
 */
export function asSourceReportId(input: string): `rpt_${string}` | undefined {
  return /^rpt_[0-9a-z]+$/.test(input) ? (input as `rpt_${string}`) : undefined
}

export function GovernanceDialog({
  description,
  errorMessage,
  onClose,
  onSubmit,
  pending,
  requireTarget,
  submitLabel,
  title,
}: {
  description: string
  errorMessage: string | null
  onClose: () => void
  onSubmit: (input: GovernanceDialogOutput) => void
  pending: boolean
  /** restrict / ban 才有到期时间（契约：惰性判断，可不填=永久）。 */
  requireTarget: 'listing' | 'user-restrict' | 'user-lift'
  submitLabel: string
  title: string
}) {
  const [reason, setReason] = useState('')
  const [sourceReportId, setSourceReportId] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  const shownError = localError ?? errorMessage

  function submit() {
    const reasonError = validateReason(reason)
    if (reasonError !== null) {
      setLocalError(reasonError)
      return
    }
    const trimmedReport = sourceReportId.trim()
    let expires: string | undefined
    if (expiresAt.length > 0) {
      const parsed = new Date(expiresAt)
      if (Number.isNaN(parsed.getTime())) {
        setLocalError('到期时间格式不正确')
        return
      }
      expires = parsed.toISOString()
    }
    setLocalError(null)
    let brandedReport: `rpt_${string}` | undefined
    if (trimmedReport.length > 0) {
      const branded = asSourceReportId(trimmedReport)
      if (branded === undefined) {
        setLocalError('关联举报单 ID 格式不正确（应以 rpt_ 开头）')
        return
      }
      brandedReport = branded
    }
    onSubmit({
      reason: reason.trim(),
      ...(brandedReport !== undefined ? { sourceReportId: brandedReport } : {}),
      ...(expires !== undefined ? { expiresAt: expires } : {}),
    })
  }

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      open
    >
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <span className="font-medium text-sm">
              原因 <span className="text-coral">*</span>
            </span>
            <textarea
              aria-label="治理原因"
              className="min-h-20 w-full rounded-xl border border-line bg-white/80 px-3 py-2 text-sm focus-visible:ring-3 focus-visible:ring-brand/15 focus:outline-none"
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              placeholder="写进审计、不可抵赖；1–500 字"
              value={reason}
            />
            <span className="block text-right text-ink-3 text-xs">{reason.trim().length}/500</span>
          </div>

          <div className="space-y-1.5">
            <span className="font-medium text-sm">关联举报单（可选）</span>
            <Input
              aria-label="关联举报单 ID"
              className="bg-white/80"
              onChange={(event) => setSourceReportId(event.target.value)}
              placeholder="rpt_…（必须与治理目标匹配）"
              value={sourceReportId}
            />
          </div>

          {requireTarget === 'user-restrict' ? (
            <div className="space-y-1.5">
              <span className="font-medium text-sm">到期时间（可选，留空 = 永久）</span>
              <Input
                aria-label="限制到期时间"
                className="bg-white/80"
                onChange={(event) => setExpiresAt(event.target.value)}
                type="datetime-local"
                value={expiresAt}
              />
            </div>
          ) : null}

          {shownError !== null ? (
            <p
              className={`rounded-xl px-3.5 py-2.5 text-sm ${
                localError !== null ? 'bg-warn-soft text-warn' : 'bg-danger-soft text-danger'
              }`}
              role="alert"
            >
              {shownError}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button disabled={pending} onClick={onClose} variant="ghost">
            取消
          </Button>
          <Button
            disabled={pending}
            onClick={submit}
            variant={requireTarget === 'listing' ? 'destructive' : 'default'}
          >
            {pending ? '正在执行…' : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 治理成功结果的提示行（列表/详情页在成功后展示一次）。 */
export function GovernanceResultBadge({
  action,
}: {
  action:
    | 'LISTING_DELISTED'
    | 'LISTING_RESTORED'
    | 'USER_RESTRICTED'
    | 'USER_RESTRICTION_LIFTED'
    | 'USER_BANNED'
    | 'USER_UNBANNED'
}) {
  const label: Record<string, string> = {
    LISTING_DELISTED: '已下架',
    LISTING_RESTORED: '已恢复',
    USER_RESTRICTED: '已限制发布',
    USER_RESTRICTION_LIFTED: '已解除限制',
    USER_BANNED: '已封禁',
    USER_UNBANNED: '已解封',
  }
  return <Badge variant="success">{label[action] ?? action}</Badge>
}

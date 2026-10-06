import { type ReportId, ReportIdSchema } from '@fish/contracts/system/public-id'
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
import { DialogAlert, ReasonField } from './admin-dialog-parts'
import { validateReason } from './admin-view'

/**
 * 治理写操作的确认弹窗（#467 验收「高风险操作」）：明确展示目标 + 原因必填（1–500）+
 * 可选回链举报单 / 可选到期时间。提交失败**渲染在弹窗内部**（radix 遮罩会盖住页面级
 * 通知，#448 审查教训），冲突时由调用方决定关闭与否。
 */

/** 提交给治理 mutation 的形状：sourceReportId 已过契约守卫（品牌类型）。 */
export type GovernanceDialogOutput = {
  reason: string
  sourceReportId?: ReportId
  expiresAt?: string
}

/**
 * 关联举报单的值域守卫：直接复用契约的 `ReportIdSchema`（TypeID `rpt_` + 26 位 Base32），
 * 端上不再自己写 `/^rpt_[0-9a-z]+$/` 复刻前缀知识——契约收紧时这里跟着收紧。
 * 存在性与「是否与治理目标匹配」仍由服务端 404/422 兜底。
 */
export function asSourceReportId(input: string): ReportId | undefined {
  const parsed = ReportIdSchema.safeParse(input)
  return parsed.success ? parsed.data : undefined
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
    let brandedReport: ReportId | undefined
    if (trimmedReport.length > 0) {
      const branded = asSourceReportId(trimmedReport)
      if (branded === undefined) {
        setLocalError('关联举报单 ID 格式不正确（应为 rpt_ 开头的规范 ID）')
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
          <ReasonField ariaLabel="治理原因" label="原因" onChange={setReason} value={reason} />

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
            <DialogAlert message={shownError} tone={localError !== null ? 'warn' : 'danger'} />
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

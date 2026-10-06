import { Button } from '@fish/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@fish/ui/dialog'
import { useState } from 'react'
import { DialogAlert, OptionCards, ReasonField } from './admin-dialog-parts'
import { validateReason } from './admin-view'

/**
 * 举报处理弹窗（#467 验收「处理结果」）：受理（HANDLED）或驳回（REJECTED）+ 原因必填。
 * 只写处理结果，**不触发治理动作**（契约明示：下架/封禁是治理端点的事，可带
 * `sourceReportId` 回链本单）。失败渲染在弹窗内部（#448 教训）。
 */
export function ReportHandleDialog({
  errorMessage,
  onClose,
  onSubmit,
  pending,
  targetLabel,
}: {
  errorMessage: string | null
  onClose: () => void
  onSubmit: (input: { result: 'HANDLED' | 'REJECTED'; reason: string }) => void
  pending: boolean
  targetLabel: string
}) {
  const [result, setResult] = useState<'HANDLED' | 'REJECTED' | null>(null)
  const [reason, setReason] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  const shownError = localError ?? errorMessage

  function submit() {
    if (result === null) {
      setLocalError('请先选择受理或驳回')
      return
    }
    const reasonError = validateReason(reason)
    if (reasonError !== null) {
      setLocalError(reasonError)
      return
    }
    setLocalError(null)
    onSubmit({ result, reason: reason.trim() })
  }

  const options = [
    {
      value: 'HANDLED' as const,
      label: '受理（HANDLED）',
      hint: '举报属实或需跟进，后续治理另行执行',
    },
    { value: 'REJECTED' as const, label: '驳回（REJECTED）', hint: '举报不成立，写明驳回理由' },
  ]

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      open
    >
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>处理举报</DialogTitle>
          <DialogDescription>目标「{targetLabel}」——处理结果与原因写入审计。</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <OptionCards
            activeClassName={(value) =>
              value === 'HANDLED' ? 'border-brand bg-brand-soft/60' : 'border-line bg-surface-2'
            }
            legend="处理结果"
            name="report-handle-result"
            onChange={setResult}
            options={options}
            value={result}
          />

          <ReasonField ariaLabel="处理原因" label="处理原因" onChange={setReason} value={reason} />

          {shownError !== null ? (
            <DialogAlert message={shownError} tone={localError !== null ? 'warn' : 'danger'} />
          ) : null}
        </div>

        <DialogFooter>
          <Button disabled={pending} onClick={onClose} variant="ghost">
            取消
          </Button>
          <Button disabled={pending} onClick={submit}>
            {pending ? '正在提交…' : '提交处理结果'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

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
          <fieldset className="grid grid-cols-2 gap-2 border-0 p-0 m-0">
            <legend className="sr-only">处理结果</legend>
            {options.map((option) => {
              const active = result === option.value
              return (
                <label
                  className={`block cursor-pointer rounded-xl border p-3 text-left transition-colors ${
                    active
                      ? option.value === 'HANDLED'
                        ? 'border-brand bg-brand-soft/60'
                        : 'border-line bg-surface-2'
                      : 'border-line bg-white/70 hover:border-brand/40'
                  }`}
                  key={option.value}
                >
                  <input
                    checked={active}
                    className="sr-only"
                    name="report-handle-result"
                    onChange={() => setResult(option.value)}
                    type="radio"
                    value={option.value}
                  />
                  <span className="block font-semibold text-sm">{option.label}</span>
                  <span className="mt-1 block text-ink-3 text-xs">{option.hint}</span>
                </label>
              )
            })}
          </fieldset>

          <div className="space-y-1.5">
            <span className="font-medium text-sm">
              处理原因 <span className="text-coral">*</span>
            </span>
            <textarea
              aria-label="处理原因"
              className="min-h-20 w-full rounded-xl border border-line bg-white/80 px-3 py-2 text-sm focus-visible:ring-3 focus-visible:ring-brand/15 focus:outline-none"
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              placeholder="写进审计、不可抵赖；1–500 字"
              value={reason}
            />
            <span className="block text-right text-ink-3 text-xs">{reason.trim().length}/500</span>
          </div>

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
          <Button disabled={pending} onClick={submit}>
            {pending ? '正在提交…' : '提交处理结果'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

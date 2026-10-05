import {
  type AdminDisputeResolveInput,
  type DisputeResolution,
  MAX_DISPUTE_RESOLUTION_NOTE_LENGTH,
} from '@fish/contracts/disputes/schema'
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
 * 争议处理弹窗（#465 验收「处理结论」）：三选一结论 + 原因必填（1–500 字）。
 *
 * 只写结论与原因，**不改变成交事实、不执行处罚**（票面验收第 6 条）——需要下架/封禁
 * 请另走治理动作。失败渲染在弹窗内部（#448 教训），错误从父级传入、弹窗不自持 mutation。
 */
export function DisputeResolveDialog({
  errorMessage,
  onClose,
  onSubmit,
  pending,
  subjectLabel,
}: {
  errorMessage: string | null
  onClose: () => void
  onSubmit: (input: AdminDisputeResolveInput) => void
  pending: boolean
  subjectLabel: string
}) {
  const [resolution, setResolution] = useState<DisputeResolution | null>(null)
  const [reason, setReason] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  const shownError = localError ?? errorMessage

  function submit() {
    if (resolution === null) {
      setLocalError('请先选择处理结论')
      return
    }
    const reasonError = validateReason(reason)
    if (reasonError !== null) {
      setLocalError(reasonError)
      return
    }
    setLocalError(null)
    onSubmit({ resolution, reason: reason.trim() })
  }

  const options: ReadonlyArray<{ value: DisputeResolution; label: string; hint: string }> = [
    { value: 'UPHELD', label: '反馈成立', hint: '争议所述属实，结论写入审计' },
    { value: 'DISMISSED', label: '反馈不成立', hint: '现有材料不支持该反馈' },
    { value: 'INCONCLUSIVE', label: '无法认定', hint: '双方说法都无法证实' },
  ]

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      open
    >
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>处理争议</DialogTitle>
          <DialogDescription>
            争议「{subjectLabel}」——结论与原因写入审计；本操作不改成交事实、不执行处罚。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <fieldset className="grid grid-cols-3 gap-2 border-0 p-0 m-0">
            <legend className="sr-only">处理结论</legend>
            {options.map((option) => {
              const active = resolution === option.value
              return (
                <label
                  className={`block cursor-pointer rounded-xl border p-3 text-left transition-colors ${
                    active
                      ? 'border-brand bg-brand-soft/60'
                      : 'border-line bg-white/70 hover:border-brand/40'
                  }`}
                  key={option.value}
                >
                  <input
                    checked={active}
                    className="sr-only"
                    name="dispute-resolve-resolution"
                    onChange={() => setResolution(option.value)}
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
              maxLength={MAX_DISPUTE_RESOLUTION_NOTE_LENGTH}
              onChange={(event) => setReason(event.target.value)}
              placeholder="写进审计、不可抵赖；1–500 字"
              value={reason}
            />
            <span className="block text-right text-ink-3 text-xs">
              {reason.trim().length}/{MAX_DISPUTE_RESOLUTION_NOTE_LENGTH}
            </span>
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
            {pending ? '正在提交…' : '提交处理结论'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

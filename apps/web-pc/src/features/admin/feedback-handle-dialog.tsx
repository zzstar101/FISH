import { FEEDBACK_REPLY_MAX, type FeedbackHandleResult } from '@fish/contracts/feedback/schema'
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
import { DialogErrorAlert, OptionCards, ReasonField } from './admin-dialog-parts'
import { validateReason } from './admin-view'

export type FeedbackHandleSubmit = {
  result: FeedbackHandleResult
  reply?: string
  note: string
}

/** 弹窗本地校验：回复用户必须写回复；直接结单不带回复；内部备注必填。返回 null = 通过。 */
export function validateFeedbackHandle(input: {
  result: FeedbackHandleResult | null
  reply: string
  note: string
}): string | null {
  if (input.result === null) return '请先选择回复用户或直接结单'
  if (input.result === 'REPLIED') {
    const reply = input.reply.trim()
    if (reply.length === 0) return '请填写给用户的回复'
    if (reply.length > FEEDBACK_REPLY_MAX) return `回复不能超过 ${FEEDBACK_REPLY_MAX} 字`
  }
  return validateReason(input.note)
}

/**
 * 处理反馈弹窗（#463）：回复用户（REPLIED，回复对用户可见）或直接结单（CLOSED）+ 内部备注必填。
 * 失败渲染在弹窗内部（与举报处理弹窗同口径）。
 */
export function FeedbackHandleDialog({
  errorMessage,
  onClose,
  onSubmit,
  pending,
}: {
  errorMessage: string | null
  onClose: () => void
  onSubmit: (input: FeedbackHandleSubmit) => void
  pending: boolean
}) {
  const [result, setResult] = useState<FeedbackHandleResult | null>(null)
  const [reply, setReply] = useState('')
  const [note, setNote] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  function submit() {
    const invalid = validateFeedbackHandle({ result, reply, note })
    if (invalid !== null || result === null) {
      setLocalError(invalid)
      return
    }
    setLocalError(null)
    onSubmit({
      result,
      ...(result === 'REPLIED' ? { reply: reply.trim() } : {}),
      note: note.trim(),
    })
  }

  const options = [
    { value: 'REPLIED' as const, label: '回复用户', hint: '回复内容会显示在用户的「我的反馈」里' },
    { value: 'CLOSED' as const, label: '直接结单', hint: '不回复，用户只看到「已处理」' },
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
          <DialogTitle>处理反馈</DialogTitle>
          <DialogDescription>处理结果与内部备注写入审计；回复原文对用户可见。</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <OptionCards
            activeClassName={(value) =>
              value === 'REPLIED' ? 'border-brand bg-brand-soft/60' : 'border-line bg-surface-2'
            }
            legend="处理结果"
            name="feedback-handle-result"
            onChange={setResult}
            options={options}
            value={result}
          />

          {result === 'REPLIED' ? (
            <ReasonField
              ariaLabel="给用户的回复"
              label="给用户的回复"
              maxLength={FEEDBACK_REPLY_MAX}
              placeholder="用户会在「我的反馈」看到这段话"
              onChange={setReply}
              value={reply}
            />
          ) : null}

          <ReasonField ariaLabel="内部备注" label="内部备注" onChange={setNote} value={note} />

          <DialogErrorAlert errorMessage={errorMessage} localError={localError} />
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

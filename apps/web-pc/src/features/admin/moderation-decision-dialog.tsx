import { Button } from '@fish/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@fish/ui/dialog'
import { useRef, useState } from 'react'
import { DialogErrorAlert, OptionCards, ReasonField } from './admin-dialog-parts'
import { createIdempotencyKey, validateReason } from './admin-view'

/**
 * 人工审核决定弹窗（#467 验收「人工 ALLOW/BLOCK」）。
 *
 * **幂等键生命周期**：`createIdempotencyKey()` 在弹窗实例内只生成一次（useRef）——
 * 同一次弹窗内的网络重试复用同一个 key，服务端按 key 幂等；不同记录之间必须不同，
 * 由调用方用 `key={record.id}` 重挂弹窗达成（同 key 用于其它记录 → 409）。
 * 失败渲染在弹窗内部（#448 教训）。
 */
export function ModerationDecisionDialog({
  errorMessage,
  listingTitle,
  onClose,
  onSubmit,
  pending,
}: {
  errorMessage: string | null
  listingTitle: string
  onClose: () => void
  onSubmit: (input: { decision: 'ALLOW' | 'BLOCK'; reason: string; idempotencyKey: string }) => void
  pending: boolean
}) {
  const idempotencyKeyRef = useRef(createIdempotencyKey())
  const [decision, setDecision] = useState<'ALLOW' | 'BLOCK' | null>(null)
  const [reason, setReason] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  function submit() {
    if (decision === null) {
      setLocalError('请先选择放行或拦截')
      return
    }
    const reasonError = validateReason(reason)
    if (reasonError !== null) {
      setLocalError(reasonError)
      return
    }
    setLocalError(null)
    onSubmit({ decision, reason: reason.trim(), idempotencyKey: idempotencyKeyRef.current })
  }

  const options = [
    { value: 'ALLOW' as const, label: '放行（ALLOW）', hint: '内容无违规，商品恢复正常的审核状态' },
    { value: 'BLOCK' as const, label: '拦截（BLOCK）', hint: '内容违规，商品在公开列表隐藏' },
  ]

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      open
    >
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>人工审核决定</DialogTitle>
          <DialogDescription>
            商品「{listingTitle}」——决定与原因写入审计，处理完成后不可在本页改判。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <OptionCards
            activeClassName={(value) =>
              value === 'ALLOW' ? 'border-brand bg-brand-soft/60' : 'border-danger bg-danger-soft'
            }
            legend="审核决定"
            name="moderation-decision"
            onChange={setDecision}
            options={options}
            value={decision}
          />

          <ReasonField ariaLabel="决定原因" label="决定原因" onChange={setReason} value={reason} />

          <DialogErrorAlert errorMessage={errorMessage} localError={localError} />
        </div>

        <DialogFooter>
          <Button disabled={pending} onClick={onClose} variant="ghost">
            取消
          </Button>
          <Button disabled={pending} onClick={submit}>
            {pending ? '正在提交…' : '提交决定'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

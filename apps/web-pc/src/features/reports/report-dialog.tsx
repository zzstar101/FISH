import type { ReportReason } from '@fish/contracts/reports/schema'
import { ReportReasonSchema } from '@fish/contracts/reports/schema'
import type { ListingId, UserId } from '@fish/contracts/system/public-id'
import { Alert, AlertDescription, AlertTitle } from '@fish/ui/alert'
import { Button } from '@fish/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@fish/ui/dialog'
import { Field, FieldLabel } from '@fish/ui/field'
import { RadioGroup, RadioGroupItem } from '@fish/ui/radio-group'
import { Textarea } from '@fish/ui/textarea'
import { CheckCircle2, Loader2, ShieldAlert } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { ApiError } from '../../lib/api-client'
import { REPORT_DESC_PLACEHOLDER, REPORT_DETAIL_MAX_LENGTH, reasonsOf } from './meta'
import { useSubmitReport } from './queries'
import { submitFailureText, submitSuccessText } from './view'

/**
 * 举报目标。用可辨识联合而不是 `{ type; id: string }`：契约的 `targetId` 是
 * `lst_…` / `usr_…` 两个模板字面量类型的联合，写宽成 `string` 就丢掉前缀约束了。
 */
export type ReportTarget =
  | { type: 'LISTING'; id: ListingId; label: string }
  | { type: 'USER'; id: UserId; label: string }

/**
 * 举报弹窗。商品与用户共用同一个组件 —— 两者的差异只有「原因枚举」与文案，
 * 由 `reasonsOf(targetType)` 分流，页面结构不重复实现。
 */
export function ReportDialog({
  open,
  onOpenChange,
  target,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: ReportTarget
}) {
  const options = reasonsOf(target.type)
  const [reason, setReason] = useState<ReportReason | null>(null)
  const [detail, setDetail] = useState('')
  const { data, error, isPending, isSuccess, mutate, reset } = useSubmitReport()

  // 关闭时清场，而不是打开时清场：effect 在 paint 之后才跑，若在 `open` 变 true 时清，
  // 重开的那一帧会先带着上一次的原因与说明画出来再被重置（看得见的闪一下）。
  // 换举报对象由调用方的 `key` 触发重挂载（见 `report-entry.tsx`），这里不必再盯 target。
  useEffect(() => {
    if (open) return
    setReason(null)
    setDetail('')
    reset()
  }, [open, reset])

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (reason === null) return
    const trimmed = detail.trim()
    mutate({
      targetType: target.type,
      targetId: target.id,
      reason,
      // 契约是 `trim().min(1).max(200).optional()`：空串要**省略字段**，不能发空字符串。
      ...(trimmed === '' ? {} : { detailText: trimmed }),
    })
  }

  const targetKind = target.type === 'LISTING' ? '商品' : '用户'

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        {isSuccess && data !== null ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2 className="size-5 text-success" />
                举报已受理
              </DialogTitle>
            </DialogHeader>
            <p className="text-ink-2 text-sm leading-6">{submitSuccessText(data.created)}</p>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)} type="button">
                知道了
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form className="space-y-5" onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ShieldAlert className="size-5 text-brand" />
                举报{targetKind}
              </DialogTitle>
              <DialogDescription className="break-all">{target.label}</DialogDescription>
            </DialogHeader>

            <Field>
              <FieldLabel>举报原因</FieldLabel>
              <RadioGroup
                onValueChange={(value) => setReason(ReportReasonSchema.parse(value))}
                value={reason ?? ''}
              >
                {options.map((option) => (
                  <label
                    className="flex cursor-pointer items-center gap-3 text-sm"
                    htmlFor={`report-reason-${option.key}`}
                    key={option.key}
                  >
                    <RadioGroupItem id={`report-reason-${option.key}`} value={option.key} />
                    {option.label}
                  </label>
                ))}
              </RadioGroup>
            </Field>

            <Field>
              <FieldLabel htmlFor="report-detail">补充说明（选填）</FieldLabel>
              <Textarea
                id="report-detail"
                maxLength={REPORT_DETAIL_MAX_LENGTH}
                onChange={(event) => setDetail(event.target.value)}
                placeholder={
                  reason === null
                    ? REPORT_DESC_PLACEHOLDER
                    : (options.find((option) => option.key === reason)?.hint ??
                      REPORT_DESC_PLACEHOLDER)
                }
                rows={4}
                value={detail}
              />
              {/* 长度提示：契约硬上限 200（`ReportCreateInputSchema`），超了服务端直接 422。 */}
              <p className="text-right text-ink-3 text-xs">
                {detail.length}/{REPORT_DETAIL_MAX_LENGTH}
              </p>
            </Field>

            {error !== null ? (
              <Alert variant="destructive">
                <AlertTitle>提交失败</AlertTitle>
                <AlertDescription>
                  {submitFailureText(error instanceof ApiError ? error.code : null)}
                </AlertDescription>
              </Alert>
            ) : null}

            <DialogFooter>
              <Button
                disabled={isPending}
                onClick={() => onOpenChange(false)}
                type="button"
                variant="outline"
              >
                取消
              </Button>
              <Button disabled={isPending || reason === null} type="submit">
                {isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                {isPending ? '正在提交…' : '提交举报'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

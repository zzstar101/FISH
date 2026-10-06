import { DELETION_CONSEQUENCES } from '@fish/contracts/account-deletion/copy'
import { coolingOffLabel } from '@fish/contracts/account-deletion/countdown'
import {
  ACCOUNT_DELETION_CONFIRMATION_PHRASE,
  ACCOUNT_DELETION_COOLING_OFF_DAYS,
} from '@fish/contracts/account-deletion/schema'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@fish/ui/dialog'
import { Field, FieldError, FieldLabel } from '@fish/ui/field'
import { Input } from '@fish/ui/input'
import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import { describeDeletionFailure, matchesDeletionConfirmation } from '../auth/account-deletion'
import {
  useAccountDeletionStatus,
  useRequestAccountDeletion,
  useWithdrawAccountDeletion,
} from '../auth/queries'

type AccountDeletionCardProps = {
  /** 当前登录用户 id（`ProfileContent` 的 `ownerId`）。用于申请/撤回后失效「我的」相关查询。 */
  ownerId: string
}

/**
 * 个人中心的注销入口与冷静期状态（Issue #464 验收第 1 条）。
 *
 * 一个组件覆盖注销流程的两个状态，因为它们**必须**互斥呈现：`/me/account-deletion`
 * 的 `status` 决定这里是「申请注销」还是「撤回申请」，不存在同时显示两个按钮的可能。
 *
 * 状态从服务端读，不在本地记「我点过申请了」：同一账号可能在另一台设备上申请或撤回，
 * 本地记的状态会立刻说谎。读失败时不渲染任何注销动作（宁可显示读取失败），
 * 否则冷静期内的用户会看到一个假的「申请注销」按钮，点下去只会拿到 200 + 既有状态。
 *
 * UI 内嵌在 `/profile` 路由里而不是新开路由页：`apps/web-pc/src/routeTree.gen.ts` 是
 * 生成文件（AGENTS 禁止手改），为一张卡重跑路由生成器不值得（见 PR 说明）。
 */
export function AccountDeletionCard({ ownerId }: AccountDeletionCardProps) {
  const status = useAccountDeletionStatus(ownerId)
  const request = useRequestAccountDeletion(ownerId)
  const withdraw = useWithdrawAccountDeletion(ownerId)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [requestError, setRequestError] = useState<string | null>(null)
  const [offlinedCount, setOfflinedCount] = useState<number | null>(null)
  const [withdrawError, setWithdrawError] = useState<string | null>(null)

  const submitting = request.isPending
  const confirmed = matchesDeletionConfirmation(typed)

  function closeDialog() {
    if (submitting) return
    setDialogOpen(false)
    setTyped('')
    setRequestError(null)
  }

  async function submit() {
    if (!confirmed || submitting) return
    setRequestError(null)
    try {
      const result = await request.mutateAsync()
      setOfflinedCount(result.offlinedListingCount)
      setDialogOpen(false)
      setTyped('')
    } catch (error) {
      setRequestError(describeDeletionFailure(error, '注销申请提交失败，请稍后重试'))
    }
  }

  async function handleWithdraw() {
    setWithdrawError(null)
    try {
      await withdraw.mutateAsync()
    } catch (error) {
      setWithdrawError(describeDeletionFailure(error, '撤回失败，请稍后重试'))
    }
  }

  if (status.isPending) {
    return (
      <Card className="gap-0 border border-line p-6">
        <h2 className="font-semibold">注销账号</h2>
        <p className="mt-1 text-ink-3 text-sm">正在读取账号状态…</p>
      </Card>
    )
  }

  if (status.isError) {
    return (
      <Card className="gap-0 border border-line p-6">
        <h2 className="font-semibold">注销账号</h2>
        <p className="mt-1 text-ink-3 text-sm">读取账号状态失败，请重试后再决定是否注销。</p>
        <Button
          className="mt-3 self-start"
          onClick={() => void status.refetch()}
          type="button"
          variant="outline"
        >
          重新读取
        </Button>
      </Card>
    )
  }

  const data = status.data

  if (data.status === 'DELETION_REQUESTED') {
    // 读不到 `purgeScheduledAt` 时由 `coolingOffLabel` 兜底成「冷静期内」：这一屏与小程序
    // 注销页共用同一句文案，不在这里再写一份兜底（此前两端兜底正好相反）。
    const remaining = coolingOffLabel(data.purgeScheduledAt, Date.now())
    return (
      <Card className="gap-0 border border-danger/30 bg-danger-soft/40 p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-semibold">注销申请已提交</h2>
            <p className="mt-1 text-ink-3 text-sm">
              {remaining}
              ，到期后账号与个人资料不可恢复。期间不能发布、留言、聊天或交易。
            </p>
            {offlinedCount !== null && offlinedCount > 0 ? (
              <p className="mt-1 text-ink-3 text-sm">
                本次已下架 {offlinedCount} 件在售商品；撤回申请不会自动重新上架。
              </p>
            ) : null}
          </div>
          <Button
            disabled={withdraw.isPending}
            onClick={() => void handleWithdraw()}
            type="button"
            variant="outline"
          >
            {withdraw.isPending ? '正在撤回…' : '撤回注销申请'}
          </Button>
        </div>
        {withdrawError !== null ? (
          <p className="mt-3 text-danger text-sm" role="alert">
            {withdrawError}
          </p>
        ) : null}
      </Card>
    )
  }

  return (
    <>
      <Card className="gap-0 border border-line p-6">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-danger-soft text-danger">
              <Trash2 className="size-5" />
            </span>
            <div>
              <h2 className="font-semibold">注销账号</h2>
              <p className="mt-0.5 text-ink-3 text-sm">
                {ACCOUNT_DELETION_COOLING_OFF_DAYS}{' '}
                天冷静期，期间可撤回；到期后账号与个人资料不可恢复。
              </p>
            </div>
          </div>
          <Button onClick={() => setDialogOpen(true)} type="button" variant="outline">
            申请注销
          </Button>
        </div>
      </Card>

      <Dialog
        onOpenChange={(next) => {
          if (!next) {
            closeDialog()
            return
          }
          setDialogOpen(true)
        }}
        open={dialogOpen}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>注销账号</DialogTitle>
            <DialogDescription>提交前请确认你知道下面这些后果。</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <ul className="space-y-3 rounded-xl bg-surface-2 px-4 py-4">
              {DELETION_CONSEQUENCES.map((item) => (
                <li key={item.title}>
                  <p className="font-medium text-sm">{item.title}</p>
                  <p className="mt-0.5 text-ink-3 text-sm">{item.detail}</p>
                </li>
              ))}
            </ul>

            <Field data-invalid={requestError !== null}>
              <FieldLabel htmlFor="account-deletion-confirmation">
                输入「{ACCOUNT_DELETION_CONFIRMATION_PHRASE}」以确认
              </FieldLabel>
              <Input
                aria-invalid={requestError !== null}
                autoComplete="off"
                disabled={submitting}
                id="account-deletion-confirmation"
                onChange={(event) => {
                  setTyped(event.target.value)
                  setRequestError(null)
                }}
                placeholder={ACCOUNT_DELETION_CONFIRMATION_PHRASE}
                value={typed}
              />
              {requestError !== null ? (
                <FieldError>{requestError}</FieldError>
              ) : (
                <p className="text-ink-3 text-xs">
                  这一步只是防误触；提交后仍可在 {ACCOUNT_DELETION_COOLING_OFF_DAYS} 天内撤回。
                </p>
              )}
            </Field>

            {requestError !== null ? (
              <p className="rounded-xl bg-warn-soft px-4 py-3 text-sm text-warn" role="status">
                {requestError}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button disabled={submitting} onClick={closeDialog} type="button" variant="outline">
              再想想
            </Button>
            <Button
              disabled={!confirmed || submitting}
              onClick={() => void submit()}
              type="button"
              variant="destructive"
            >
              {submitting ? '正在提交…' : '提交注销申请'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

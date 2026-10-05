import { Button } from '@fish/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@fish/ui/dialog'
import { Ban } from 'lucide-react'
import { useState } from 'react'
import { useBlockState, useBlockUser, useUnblockUser } from './queries'

/**
 * 他人主页的「拉黑 / 解除拉黑」动作（#466）。
 *
 * 拉黑是单方面动作、立即生效（双向拦截），点击后先过**确认弹窗**（展示目标 +
 * 后果说明）；解除是恢复性动作，直接执行。按钮状态由 `blockButtonState` 纯函数推导：
 * 状态读到之前不可点（防止把「未读到」画成「未拉黑」）。
 */

export type BlockReadState = 'loading' | 'blocked' | 'notBlocked' | 'notFound' | 'unknown'

export type BlockButtonState = {
  label: string
  /** blocked=true 时按钮是「解除」语义（描边样式）；false 是「拉黑」（危险描边）。 */
  blocked: boolean
  enabled: boolean
  hint: string | null
}

export function blockButtonState(input: {
  read: BlockReadState
  pending: boolean
  errorMessage: string | null
}): BlockButtonState {
  if (input.pending) {
    return {
      label: input.read === 'blocked' ? '解除中…' : '拉黑中…',
      blocked: input.read === 'blocked',
      enabled: false,
      hint: null,
    }
  }
  if (input.read === 'loading') {
    return { label: '拉黑', blocked: false, enabled: false, hint: null }
  }
  if (input.read === 'notFound') {
    return { label: '无法拉黑', blocked: false, enabled: false, hint: '用户不存在或不可见' }
  }
  if (input.read === 'unknown') {
    return {
      label: '拉黑',
      blocked: false,
      enabled: false,
      hint: input.errorMessage ?? '状态读取失败，请重试',
    }
  }
  if (input.read === 'blocked') {
    return { label: '解除拉黑', blocked: true, enabled: true, hint: null }
  }
  return { label: '拉黑', blocked: false, enabled: true, hint: null }
}

export function BlockButtonView({
  state,
  onBlock,
  onUnblock,
}: {
  state: BlockButtonState
  onBlock: () => void
  onUnblock: () => void
}) {
  return (
    <div className="flex items-center gap-2">
      <Button
        disabled={!state.enabled}
        onClick={state.blocked ? onUnblock : onBlock}
        size="sm"
        variant="outline"
      >
        <Ban className="size-4" />
        {state.label}
      </Button>
      {state.hint !== null ? <p className="text-ink-3 text-xs">{state.hint}</p> : null}
    </div>
  )
}

/** 容器：读状态 + 两个 mutation + 拉黑确认弹窗。 */
export function BlockAction({ nickname, userId }: { nickname: string; userId: string }) {
  const state = useBlockState(userId, true)
  const blockMutation = useBlockUser(userId)
  const unblockMutation = useUnblockUser(userId)
  const [confirming, setConfirming] = useState(false)
  const pending = blockMutation.isPending || unblockMutation.isPending
  const failure =
    (blockMutation.data?.kind === 'failed' ? blockMutation.data.message : null) ??
    (unblockMutation.data?.kind === 'failed' ? unblockMutation.data.message : null)

  const view = blockButtonState({
    errorMessage: failure ?? (state.data?.kind === 'failed' ? state.data.message : null),
    pending,
    read:
      state.data === undefined
        ? 'loading'
        : state.data.kind === 'loaded'
          ? state.data.blocked
            ? 'blocked'
            : 'notBlocked'
          : state.data.kind === 'notFound'
            ? 'notFound'
            : 'unknown',
  })

  async function confirmBlock() {
    const result = await blockMutation.mutateAsync()
    if (result.kind === 'written') setConfirming(false)
  }

  return (
    <>
      <BlockButtonView
        onBlock={() => {
          blockMutation.reset()
          setConfirming(true)
        }}
        onUnblock={() => {
          unblockMutation.reset()
          void unblockMutation.mutateAsync()
        }}
        state={view}
      />
      {confirming ? (
        <Dialog
          onOpenChange={(open) => {
            if (!open && !blockMutation.isPending) setConfirming(false)
          }}
          open
        >
          <DialogContent className="sm:max-w-[440px]">
            <DialogHeader>
              <DialogTitle>拉黑「{nickname}」？</DialogTitle>
              <DialogDescription>
                拉黑后，你们双方都无法再发消息、也无法新建会话（既有会话一并冻结）；
                交易系统通知与面交流程不受影响。历史消息保留可见，可随时解除（解除是单方的，对方若也拉黑了你则需对方一并解除）。
              </DialogDescription>
            </DialogHeader>
            {blockMutation.data?.kind === 'failed' ? (
              <p
                className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-danger text-sm"
                role="alert"
              >
                {blockMutation.data.message}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                disabled={blockMutation.isPending}
                onClick={() => setConfirming(false)}
                variant="ghost"
              >
                取消
              </Button>
              <Button
                disabled={blockMutation.isPending}
                onClick={() => void confirmBlock()}
                variant="destructive"
              >
                {blockMutation.isPending ? '正在拉黑…' : '确认拉黑'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  )
}

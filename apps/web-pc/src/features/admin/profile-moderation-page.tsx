import type { ProfileModerationQueueItem } from '@fish/contracts/profile/moderation'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { useState } from 'react'
import { ApiError } from '../../lib/api-client'
import { adminLoadOutcome } from './admin-messages'
import { useProfileModerationDecision, useProfileModerationQueue } from './admin-queries'
import { formatAdminDateTime } from './admin-view'

/**
 * 资料待审（#694 M5 昵称/签名）。机器判定 REVIEW 的昵称 / 签名 / 头像变更：
 * 待审值只在这里与本人页可见，放行后才原子切换 `users` 的公开列。
 * 队列项同时给出「待审值」和「线上当前值」，管理员不用来回切页面比对。
 */
export function ProfileModerationItemCard({
  item,
  onSelect,
}: {
  item: ProfileModerationQueueItem
  onSelect: (item: ProfileModerationQueueItem) => void
}) {
  return (
    <Card key={item.id} className="gap-3 border border-line p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="warn">资料</Badge>
        <span className="font-medium text-sm">{item.author.nickname}</span>
        <span className="text-ink-3 text-xs">
          {item.provider} · 机器判定 {item.suggestion ?? item.machineDecision}
          {item.score !== null ? ` · ${item.score} 分` : ''} · {formatAdminDateTime(item.createdAt)}
        </span>
        {item.matchedRules.length > 0 ? (
          <span className="text-ink-3 text-xs">命中规则：{item.matchedRules.join('、')}</span>
        ) : null}
        {item.matchedTermsMasked.length > 0 ? (
          <span className="text-ink-3 text-xs">命中词：{item.matchedTermsMasked.join('、')}</span>
        ) : null}
      </div>

      <div className="space-y-2 rounded-xl bg-surface-2 p-3 text-sm">
        {item.fields.includes('nickname') ? (
          <p className="break-words">
            <span className="text-ink-3">昵称：</span>
            {item.nickname ?? '（未提交）'}
            <span className="ml-2 text-ink-3 text-xs">线上仍是：{item.currentNickname}</span>
          </p>
        ) : null}
        {item.fields.includes('signature') ? (
          <p className="break-words">
            <span className="text-ink-3">个性签名：</span>
            {item.signature ?? '（清空签名）'}
            <span className="ml-2 text-ink-3 text-xs">
              线上仍是：{item.currentSignature ?? '（空）'}
            </span>
          </p>
        ) : null}
        {item.fields.includes('avatarUrl') ? (
          <p className="break-words">
            <span className="text-ink-3">头像：</span>将更换为新图片
          </p>
        ) : null}
      </div>

      <div className="flex gap-2">
        <Button size="sm" onClick={() => onSelect(item)}>
          放行 / 拒绝
        </Button>
      </div>
    </Card>
  )
}

export function ProfileModerationPage() {
  const queue = useProfileModerationQueue()
  const decision = useProfileModerationDecision()
  const [selected, setSelected] = useState<ProfileModerationQueueItem | null>(null)
  const [reason, setReason] = useState('')
  const [conflict, setConflict] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  if (queue.isPending) return <LoadingState label="正在加载资料待审…" />
  if (queue.isError) {
    const outcome = adminLoadOutcome(queue.error)
    if (outcome.kind === 'forbidden') {
      return <EmptyState title="无权访问" description="当前账号没有公开内容审核权限。" />
    }
    return <ErrorState message="资料待审加载失败" onRetry={() => void queue.refetch()} />
  }

  const items = queue.data.pages.flatMap((page) => page.items)

  function close() {
    setSelected(null)
    setReason('')
  }

  async function submit(value: 'ALLOW' | 'BLOCK') {
    if (!selected) return
    setConflict(false)
    setActionError(null)
    try {
      await decision.mutateAsync({
        recordId: selected.id,
        input: { decision: value, reason: reason.trim(), version: selected.version },
      })
      close()
    } catch (error) {
      if (error instanceof ApiError && error.code === 'PROFILE_MODERATION_CONFLICT') {
        setConflict(true)
        void queue.refetch()
        return
      }
      setActionError(error instanceof Error ? error.message : '处理失败，请重试')
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-semibold text-2xl">资料待审</h1>
        <p className="mt-1 text-ink-3 text-sm">
          机器判定为 REVIEW 的昵称、个性签名与头像变更。放行后原子切换公开资料；拒绝后不公开，
          线上继续保留旧的已审资料。
        </p>
      </div>

      {conflict ? (
        <p className="rounded-xl bg-danger-soft px-4 py-3 text-danger text-sm" role="alert">
          这条记录已被其他管理员处理或版本已过期，队列已刷新，请重新选择。
        </p>
      ) : null}
      {actionError ? (
        <p className="rounded-xl bg-danger-soft px-4 py-3 text-danger text-sm" role="alert">
          {actionError}
        </p>
      ) : null}

      {items.length === 0 ? (
        <EmptyState title="没有待审资料" description="当前没有等待人工复核的昵称或个性签名。" />
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <ProfileModerationItemCard
              key={item.id}
              item={item}
              onSelect={(next) => {
                setActionError(null)
                setConflict(false)
                setSelected(next)
              }}
            />
          ))}
        </div>
      )}

      {queue.hasNextPage ? (
        <Button variant="outline" onClick={() => void queue.fetchNextPage()}>
          加载更多
        </Button>
      ) : null}

      {selected ? (
        <Card className="gap-3 border border-brand/40 p-5">
          <h2 className="font-semibold">处理资料（{selected.author.nickname}）</h2>
          <label className="text-sm" htmlFor="profile-moderation-reason">
            处理原因（必填，写入审计）
          </label>
          <textarea
            id="profile-moderation-reason"
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            className="min-h-24 rounded-xl border border-line bg-surface p-3 text-sm"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={reason.trim().length === 0 || decision.isPending}
              onClick={() => void submit('ALLOW')}
            >
              放行
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={reason.trim().length === 0 || decision.isPending}
              onClick={() => void submit('BLOCK')}
            >
              拒绝
            </Button>
            <Button size="sm" variant="ghost" onClick={close}>
              取消
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  )
}

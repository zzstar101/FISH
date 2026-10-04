import type { WishDto } from '@fish/contracts/wishes/schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Link } from '@tanstack/react-router'
import { ArrowLeft, Target } from 'lucide-react'
import { useState } from 'react'
import { formatRelativeTimeAt } from '../../lib/format'
import { categoryLabel } from '../../lib/labels'
import { useAuth } from '../auth/auth-provider'
import { budgetLabel, MatchListDialog, type MatchTarget } from './match-list'
import { useWishDetail } from './queries'
import { isWishNotFound } from './wish-view'

/**
 * 愿望详情（`/wish/$wishId`，#446）：wishId 通知的落点。
 *
 * `GET /wishes/:id` 是 owner-scoped 的，页面只服务「本人的愿望」；非本人或不存在的
 * 愿望一律 404 → 渲染「愿望不存在或不可见」，不区分两种原因（与服务端同口径）。
 * 匹配结果复用许愿墙的 `MatchListDialog`（同一套「聊一聊」与截断口径）。
 */
export function WishDetailPage({ wishId }: { wishId: string }) {
  const { me } = useAuth()
  if (!me) return null
  return <WishDetailContent key={me.id} ownerId={me.id} wishId={wishId} />
}

function WishDetailContent({ ownerId, wishId }: { ownerId: string; wishId: string }) {
  const wish = useWishDetail(ownerId, wishId)
  const [matchOpen, setMatchOpen] = useState(false)
  const matchTarget: MatchTarget | null =
    wish.data === undefined || wish.data === null
      ? null
      : { kind: 'wish', id: wish.data.id, title: wish.data.keyword }

  if (wish.isPending) return <LoadingState label="正在加载愿望…" />

  if (wish.isError) {
    if (isWishNotFound(wish.error)) {
      return (
        <EmptyState
          action={
            <Link
              className="rounded-lg bg-brand px-4 py-2 font-medium text-sm text-white transition-colors hover:bg-lavender"
              to="/wish"
            >
              返回许愿墙
            </Link>
          }
          description="它可能已被删除，或者不是你发布的愿望。"
          emoji="🔍"
          title="愿望不存在或不可见"
        />
      )
    }
    return <ErrorState message="愿望加载失败" onRetry={() => void wish.refetch()} />
  }

  return (
    <div className="space-y-6">
      <Link
        className="inline-flex items-center gap-2 text-ink-2 text-sm hover:text-brand"
        to="/wish"
      >
        <ArrowLeft className="size-4" />
        返回许愿墙
      </Link>

      <WishDetailCard onOpenMatch={() => setMatchOpen(true)} wish={wish.data} />
      <MatchListDialog
        onClose={() => setMatchOpen(false)}
        ownerId={ownerId}
        target={matchOpen ? matchTarget : null}
      />
    </div>
  )
}

function WishDetailCard({ onOpenMatch, wish }: { onOpenMatch: () => void; wish: WishDto }) {
  return (
    <Card className="gap-0 border border-line p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-semibold text-[22px] tracking-[-0.03em]">{wish.keyword}</h1>
          <p className="mt-1.5 text-ink-3 text-sm">
            {categoryLabel(wish.category)} · {formatRelativeTimeAt(wish.createdAt)}发布
          </p>
        </div>
        <Badge variant={STATUS_VIEW[wish.status].variant}>{STATUS_VIEW[wish.status].label}</Badge>
      </div>

      {wish.description ? (
        <p className="mt-4 text-ink-2 text-sm leading-6 whitespace-pre-line">{wish.description}</p>
      ) : null}

      <dl className="mt-5 flex flex-wrap gap-8">
        <div>
          <dd className="font-bold text-xl tabular-nums">
            {budgetLabel(wish.budgetMinCents, wish.budgetMaxCents)}
          </dd>
          <dt className="mt-0.5 text-ink-3 text-xs">预算区间</dt>
        </div>
        <div>
          <dd className="font-bold text-xl tabular-nums">{wish.matchCount}</dd>
          <dt className="mt-0.5 text-ink-3 text-xs">当前可见匹配</dt>
        </div>
        <div>
          <dd className="font-bold text-xl">{wish.acceptSimilar ? '接受' : '不接受'}</dd>
          <dt className="mt-0.5 text-ink-3 text-xs">同类商品</dt>
        </div>
      </dl>

      <Button
        className="mt-5"
        disabled={wish.matchCount === 0}
        onClick={onOpenMatch}
        variant="outline"
      >
        <Target className="size-4" />
        {wish.matchCount === 0 ? '暂无匹配结果' : '查看匹配结果'}
      </Button>
    </Card>
  )
}

/** 与「我的愿望」列表同一套状态展示（同词同色，漂移会被列表行立刻衬出来）。 */
const STATUS_VIEW: Record<
  WishDto['status'],
  { label: string; variant: 'success' | 'secondary' | 'brand' }
> = {
  ACTIVE: { label: '许愿中', variant: 'success' },
  FULFILLED: { label: '已达成', variant: 'brand' },
  CLOSED: { label: '已关闭', variant: 'secondary' },
}

import type { ListingMatchItem, WishMatchItem } from '@fish/contracts/matching/schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@fish/ui/dialog'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Link, useNavigate } from '@tanstack/react-router'
import { MessageCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ListingThumb } from '../../components/listing-thumb'
import { formatPrice } from '../../lib/format'
import { categoryLabel } from '../../lib/labels'
import { currentSessionGeneration } from '../../lib/session-cache'
import { conversationStartError, MATCH_PAGE_LIMIT, wishMatchError } from './api'
import { useListingMatches, useStartConversation, useWishMatches } from './queries'

export type MatchTarget =
  | { kind: 'wish'; id: string; title: string }
  | { kind: 'listing'; id: string; title: string }

export function MatchListDialog({
  ownerId,
  target,
  onClose,
}: {
  ownerId: string
  target: MatchTarget | null
  onClose: () => void
}) {
  const navigate = useNavigate()
  const wishMatches = useWishMatches(
    ownerId,
    target?.kind === 'wish' ? target.id : '',
    target?.kind === 'wish',
  )
  const listingMatches = useListingMatches(
    ownerId,
    target?.kind === 'listing' ? target.id : '',
    target?.kind === 'listing',
  )
  const startConversation = useStartConversation(ownerId)
  const [notice, setNotice] = useState<string | null>(null)
  // 对话框关闭或组件卸载时作废在途的「聊一聊」导航，避免把用户拉回会话。
  const chatEpochRef = useRef(0)
  useEffect(() => {
    return () => {
      chatEpochRef.current += 1
    }
  }, [])
  const active = target?.kind === 'wish' ? wishMatches : listingMatches
  const total =
    target?.kind === 'wish' ? (wishMatches.data?.total ?? 0) : (listingMatches.data?.total ?? 0)
  const itemCount =
    target?.kind === 'wish'
      ? (wishMatches.data?.items.length ?? 0)
      : (listingMatches.data?.items.length ?? 0)
  const expectedVisible = Math.min(total, MATCH_PAGE_LIMIT)
  const unmappableCount = Math.max(0, expectedVisible - itemCount)
  const truncated = total > MATCH_PAGE_LIMIT

  function closeDialog() {
    chatEpochRef.current += 1
    setNotice(null)
    onClose()
  }

  async function chat(listingId: string) {
    setNotice(null)
    const epoch = chatEpochRef.current
    const generation = currentSessionGeneration()
    const stale = () => epoch !== chatEpochRef.current || generation !== currentSessionGeneration()

    try {
      const conversationId = await startConversation.mutateAsync(listingId)
      if (stale()) return
      closeDialog()
      await navigate({
        to: '/messages/$conversationId',
        params: { conversationId },
      })
    } catch (error) {
      if (stale()) return
      setNotice(conversationStartError(error))
    }
  }

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) closeDialog()
      }}
      open={target !== null}
    >
      <DialogContent className="max-h-[82vh] overflow-hidden sm:max-w-[760px]">
        <DialogHeader>
          <DialogTitle className="text-xl">匹配结果</DialogTitle>
          <DialogDescription className="line-clamp-1">{target?.title ?? ''}</DialogDescription>
        </DialogHeader>

        {active.isPending ? <LoadingState label="正在加载匹配结果…" /> : null}
        {active.isError ? (
          <ErrorState
            message={wishMatchError(active.error)}
            onRetry={() => void active.refetch()}
          />
        ) : null}
        {active.isSuccess && total > 0 ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between rounded-xl bg-surface-2 px-4 py-3 text-sm">
              <span>当前可见匹配数：{total}</span>
              {truncated ? (
                <span className="text-ink-3">仅显示前 {MATCH_PAGE_LIMIT} 条</span>
              ) : null}
            </div>
            {unmappableCount > 0 ? (
              <p className="rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn" role="status">
                另有 {unmappableCount} 条匹配暂不可展示
              </p>
            ) : null}
          </div>
        ) : null}
        {active.isSuccess && total === 0 ? (
          <EmptyState
            description="当前没有服务端产出的有效匹配；发布更多内容后 Worker 会继续计算。"
            emoji="🧩"
            title="暂无匹配"
          />
        ) : null}
        {active.isSuccess && total > 0 && itemCount === 0 ? (
          <EmptyState
            description="匹配记录存在，但当前卡片无法映射为可见数据。"
            emoji="🧩"
            title="暂无可展示结果"
          />
        ) : null}

        {active.isSuccess && itemCount > 0 ? (
          <div className="overflow-y-auto pr-1">
            {notice !== null ? (
              <p
                className="mb-3 rounded-xl bg-danger-soft px-3 py-2 text-danger text-sm"
                role="alert"
              >
                {notice}
              </p>
            ) : null}

            <div className="space-y-3">
              {target?.kind === 'wish' && wishMatches.data
                ? wishMatches.data.items.map((item) => (
                    <WishMatchRow
                      item={item}
                      key={item.id}
                      onChat={() => void chat(item.listing.id)}
                      pending={startConversation.isPending}
                    />
                  ))
                : null}
              {target?.kind === 'listing' && listingMatches.data
                ? listingMatches.data.items.map((item) => (
                    <ListingMatchRow item={item} key={item.id} />
                  ))
                : null}
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function WishMatchRow({
  item,
  onChat,
  pending,
}: {
  item: WishMatchItem
  onChat: () => void
  pending: boolean
}) {
  return (
    <article className="flex items-center gap-4 rounded-2xl border border-line p-4">
      <Link params={{ listingId: item.listing.id }} to="/listing/$listingId">
        <ListingThumb
          alt={item.listing.title}
          className="size-24 rounded-2xl"
          coverUrl={item.listing.coverUrl}
          listingId={item.listing.id}
        />
      </Link>
      <div className="min-w-0 flex-1">
        <Link
          className="line-clamp-1 font-semibold hover:text-brand"
          params={{ listingId: item.listing.id }}
          to="/listing/$listingId"
        >
          {item.listing.title}
        </Link>
        <p className="mt-1.5 text-ink-3 text-sm">
          {categoryLabel(item.listing.category)} · {formatPrice(item.listing.priceCents)}
        </p>
        <Badge className="mt-3" variant="brand">
          匹配度 {item.score}%
        </Badge>
      </div>
      <Button disabled={pending} onClick={onChat} variant="outline">
        <MessageCircle className="size-4" />
        聊一聊
      </Button>
    </article>
  )
}

function ListingMatchRow({ item }: { item: ListingMatchItem }) {
  const budget = budgetLabel(item.wish.budgetMinCents, item.wish.budgetMaxCents)
  return (
    <article className="flex items-center gap-4 rounded-2xl border border-line p-4">
      <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-brand-soft font-bold text-brand">
        求
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="line-clamp-1 font-semibold">想要「{item.wish.keyword}」</h3>
        <p className="mt-1.5 text-ink-3 text-sm">
          {item.wish.category ? categoryLabel(item.wish.category) : '不限分类'} · 预算 {budget}
        </p>
      </div>
      <Badge variant="brand">匹配度 {item.score}%</Badge>
    </article>
  )
}

export function formatWishBudgetCents(cents: number): string {
  // 愿望预算的 0 是金额，不是商品价格语义的“免费送”。
  return cents === 0 ? '¥0' : formatPrice(cents)
}

export function budgetLabel(min: number | null, max: number | null): string {
  // 愿望下限 0 表示“不设下限”，不是商品语义的“免费送”。
  if (min === 0) {
    if (max === null) return '不限'
    return max === 0 ? formatWishBudgetCents(0) : `≤ ${formatWishBudgetCents(max)}`
  }
  if (min !== null && max !== null) {
    return min === max
      ? formatWishBudgetCents(max)
      : `${formatWishBudgetCents(min)} ~ ${formatWishBudgetCents(max)}`
  }
  if (min !== null) return `≥ ${formatWishBudgetCents(min)}`
  if (max !== null) return `≤ ${formatWishBudgetCents(max)}`
  return '不限'
}

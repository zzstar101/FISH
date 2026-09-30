import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { Link } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { formatPrice, formatRelativeTimeAt } from '../../lib/format'
import { proposalDecisionError } from './api'
import type { PendingProposal } from './pending'
import { useAcceptProposal, useMyListings, usePendingProposals, useRejectProposal } from './queries'

/**
 * 我的发布「待确认」段：把分散在会话里的 `tx.proposal` 收成一张待办清单。
 *
 * 提案不是商品状态，所以这一段的数据**不在商品列表里**，得由 `usePendingProposals`
 * 从卖家侧会话推导（口径与边界见 `./pending` 文件头）。推导不完整时只显示清单本身、
 * 不显示「共 N 件」这类会被误读成结论的分段计数。
 *
 * 一件商品只出现一条：同一商品的多条买家会话里取最新那条有提案的，
 * 卖家同意其中一个之后其余提案虽然还在会话里，但已不可再接受（商品已非 ACTIVE）。
 */
export function PendingSection({ ownerId }: { ownerId: string }) {
  const pending = usePendingProposals(ownerId)
  const listings = useMyListings(ownerId, 'ALL')
  const accept = useAcceptProposal(ownerId)
  const reject = useRejectProposal(ownerId)
  const [notice, setNotice] = useState<string | null>(null)

  const proposals = pending.data?.proposals
  const failed = pending.data?.failed === true
  const complete = pending.data?.complete !== false

  async function decide(action: 'accept' | 'reject', proposal: PendingProposal) {
    setNotice(null)
    try {
      if (action === 'accept') {
        await accept.mutateAsync({
          conversationId: proposal.conversationId,
          amountCents: proposal.amountCents,
        })
      } else {
        await reject.mutateAsync({
          conversationId: proposal.conversationId,
          amountCents: proposal.amountCents,
        })
      }
    } catch (error) {
      const view = proposalDecisionError(error)
      setNotice(view.message)
      // 409 LISTING_NOT_ACTIVE 可能是「上一次其实成功了」：不猜结论，重新读服务端状态。
      if (view.refresh) {
        await Promise.allSettled([pending.refetch(), listings.refetch()])
      }
    }
  }

  // 没读到 ≠ 没有申请：整轮失败必须显式说明，否则在等的商品会被当成没人要。
  if (pending.isError || failed) {
    return (
      <Card className="gap-0 border border-line p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-semibold">待确认的交易申请</h2>
            <p className="mt-1.5 text-ink-3 text-sm">
              暂时读不到买家的交易申请，这不代表没有申请。
            </p>
          </div>
          <Button onClick={() => void pending.refetch()} size="sm" variant="outline">
            重试
          </Button>
        </div>
      </Card>
    )
  }

  if (pending.isPending) {
    return (
      <Card className="gap-0 border border-line p-5">
        <p className="flex items-center gap-2 text-ink-3 text-sm">
          <Loader2 className="size-4 animate-spin" />
          正在核对有没有买家在等你确认…
        </p>
      </Card>
    )
  }

  if (!proposals || proposals.size === 0) return null

  const cards = new Map(listings.data?.items.map((item) => [item.id, item]) ?? [])

  return (
    <Card className="gap-0 border border-line p-0">
      <div className="flex items-end justify-between gap-4 p-5 pb-4">
        <div>
          <h2 className="font-semibold text-lg">待确认的交易申请</h2>
          <p className="mt-1 text-ink-3 text-sm">
            买家点了「我想要」在等你点头；你同意后商品会被锁定，进入面交流程。
          </p>
        </div>
        {complete ? (
          <p className="shrink-0 text-ink-3 text-xs">共 {proposals.size} 件</p>
        ) : (
          <p className="shrink-0 text-ink-3 text-xs">仅显示已核对到的部分</p>
        )}
      </div>

      {notice !== null ? (
        <p className="mx-5 mb-4 rounded-xl bg-warn-soft px-4 py-3 text-sm text-warn" role="status">
          {notice}
        </p>
      ) : null}

      <div className="divide-y divide-line border-line border-t">
        {[...proposals.entries()].map(([listingId, proposal]) => {
          const card = cards.get(listingId)
          const accepting =
            accept.isPending && accept.variables?.conversationId === proposal.conversationId
          const rejecting =
            reject.isPending && reject.variables?.conversationId === proposal.conversationId
          const busy = accepting || rejecting

          return (
            <article className="flex flex-wrap items-center gap-4 p-5" key={listingId}>
              <div className="min-w-0 flex-1">
                <Link
                  className="line-clamp-1 font-medium hover:text-brand"
                  params={{ listingId }}
                  to="/listing/$listingId"
                >
                  {card?.title ?? '商品'}
                </Link>
                <p className="mt-1.5 text-ink-3 text-sm">
                  {proposal.buyerName} 点了「我想要」 · {formatRelativeTimeAt(proposal.createdAt)} ·
                  出价{' '}
                  <span className="font-medium text-danger">
                    {formatPrice(proposal.amountCents)}
                  </span>
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <Button asChild size="sm" variant="ghost">
                  <Link
                    params={{ conversationId: proposal.conversationId }}
                    to="/messages/$conversationId"
                  >
                    查看会话
                  </Link>
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => void decide('reject', proposal)}
                  size="sm"
                  variant="outline"
                >
                  {rejecting ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  拒绝
                </Button>
                <Button disabled={busy} onClick={() => void decide('accept', proposal)} size="sm">
                  {accepting ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  同意
                </Button>
              </div>
            </article>
          )
        })}
      </div>
    </Card>
  )
}

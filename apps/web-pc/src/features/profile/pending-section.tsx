import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { Link } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { formatPrice, formatRelativeTimeAt } from '../../lib/format'

/** 段内提示：错误用 warn，决定做完用 success 并可按需指向「我卖出的」。 */
type Notice = { tone: 'success' | 'warn'; text: string; toOrders: boolean }

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
  // 取全量：待确认的申请也可能挂在**已下架**的商品上（卖家收到申请后把它下架了），
  // 那时仍需要标题来渲染这一行。与 `usePendingProposals` 共用同一个查询键。
  const listings = useMyListings(ownerId, 'ALL')
  const accept = useAcceptProposal(ownerId)
  const reject = useRejectProposal(ownerId)
  const [notice, setNotice] = useState<Notice | null>(null)

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
        // 同意之后这一件会从「待确认」消失，所以必须留下结果与去处：
        // 取码入口在订单详情页，不给指路用户就断在这里。
        setNotice({
          tone: 'success',
          text: `已同意 ${proposal.buyerName} 的申请，商品已锁定。`,
          toOrders: true,
        })
      } else {
        await reject.mutateAsync({
          conversationId: proposal.conversationId,
          amountCents: proposal.amountCents,
        })
        setNotice({
          tone: 'success',
          text: `已拒绝 ${proposal.buyerName} 的申请，商品仍在售。`,
          toOrders: false,
        })
      }
    } catch (error) {
      const view = proposalDecisionError(error)
      setNotice({ tone: 'warn', text: view.message, toOrders: false })
      // 409 LISTING_NOT_ACTIVE 可能是「上一次其实成功了」：不猜结论，重新读服务端状态。
      if (view.refresh) {
        await Promise.allSettled([pending.refetch(), listings.refetch()])
      }
    }
  }

  /*
   * 决定已经写进服务端，而「随后这次重读失败」是另一件事：两条信息必须能同时呈现。
   * 否则同意之后重读一失败，刚给出的成功提示与「去我卖出的出示交易码」链接会一起消失，
   * 用户既不知道同意是否生效，也拿不到取码入口。
   */
  const noticeBlock = (className: string) =>
    notice === null ? null : (
      <div
        className={`rounded-xl px-4 py-3 text-sm ${
          notice.tone === 'success' ? 'bg-success-soft text-success' : 'bg-warn-soft text-warn'
        } ${className}`}
        role="status"
      >
        <p>{notice.text}</p>
        {notice.toOrders ? (
          <Link
            className="mt-1.5 inline-block font-medium underline"
            search={{ role: 'seller' }}
            to="/orders"
          >
            去「我卖出的」出示交易码
          </Link>
        ) : null}
      </div>
    )

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
        {noticeBlock('mt-4')}
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

  // 空且无话可说就整段不渲染；刚做完决定时要留着把结果说完
  if (!proposals || (proposals.size === 0 && notice === null)) return null

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

      {noticeBlock('mx-5 mb-4')}

      {proposals.size === 0 ? (
        <p className="border-line border-t px-5 py-4 text-ink-3 text-sm">暂无待确认的申请。</p>
      ) : null}

      <div className="divide-y divide-line border-line border-t">
        {[...proposals.entries()].map(([listingId, proposal]) => {
          const card = cards.get(listingId)
          const accepting =
            accept.isPending && accept.variables?.conversationId === proposal.conversationId
          const rejecting =
            reject.isPending && reject.variables?.conversationId === proposal.conversationId
          const busy = accepting || rejecting
          // 接受要求商品仍是 ACTIVE（服务端条件更新），拒绝不看商品状态 —— 两者不对称
          const acceptable = proposal.listingStatus === 'ACTIVE'
          const listingStatusLabel = proposal.listingStatus === 'OFFLINE' ? '商品已下架' : null

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
                  {listingStatusLabel !== null ? ` · ${listingStatusLabel}` : ''}
                </p>
                {acceptable ? null : (
                  <p className="mt-1 text-ink-3 text-xs">
                    商品已下架，重新上架后才能同意；现在可以直接拒绝。
                  </p>
                )}
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
                {acceptable ? (
                  <Button disabled={busy} onClick={() => void decide('accept', proposal)} size="sm">
                    {accepting ? <Loader2 className="size-3.5 animate-spin" /> : null}
                    同意
                  </Button>
                ) : null}
              </div>
            </article>
          )
        })}
      </div>
    </Card>
  )
}

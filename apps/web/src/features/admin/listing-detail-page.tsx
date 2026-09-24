import { Badge } from '@fish/ui/badge'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Link, useParams } from '@tanstack/react-router'
import { ChevronLeft } from 'lucide-react'
import { formatPrice } from '../../lib/format'
import { categoryLabel, conditionLabel } from '../../lib/labels'
import { AUDIT_ACTION_LABEL, formatDateTime, LISTING_STATUS_LABEL, statusLabel } from './display'
import { GovernancePanel } from './governance-panel'
import { useAdminListing } from './queries'

/**
 * 商品详情（#73 设计 §4.3）：商品 + 图片元数据 + 卖家摘要 + 关联操作日志。
 * 审核记录时间线待 #74 落地。
 */
export function ListingDetailPage() {
  const { listingId } = useParams({ from: '/admin/listings/$listingId' })
  const detail = useAdminListing(listingId)

  if (detail.isPending) return <LoadingState label="正在加载商品详情…" />
  if (detail.isError) {
    return <ErrorState message="商品详情加载失败" onRetry={() => void detail.refetch()} />
  }

  const listing = detail.data

  return (
    <div className="space-y-4">
      <Link
        className="inline-flex items-center gap-1 text-sm text-ink-3 hover:text-ink"
        to="/admin/listings"
      >
        <ChevronLeft className="size-4" /> 返回商品列表
      </Link>

      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 font-semibold text-lg">
              {listing.title}
              <Badge shape="pill" variant={listing.status === 'ACTIVE' ? 'default' : 'secondary'}>
                {statusLabel(LISTING_STATUS_LABEL, listing.status)}
              </Badge>
            </p>
            <p className="mt-1 text-sm text-ink-3">
              {categoryLabel(listing.category)} · {conditionLabel(listing.condition)} ·{' '}
              {listing.urgent ? '急出 ' : ''}
              {listing.negotiable ? '可刀 ' : ''}
              {listing.free ? '免费送' : ''} · 发布 {formatDateTime(listing.createdAt)} · 更新{' '}
              {formatDateTime(listing.updatedAt)}
            </p>
          </div>
          <p className="text-brand font-bold text-xl">{formatPrice(listing.priceCents)}</p>
        </div>
        <p className="mt-3 whitespace-pre-wrap text-sm text-ink-2">{listing.description}</p>
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 font-semibold text-[15px]">图片（{listing.images.length}）</h2>
        {listing.images.length === 0 ? (
          <p className="text-sm text-ink-3">暂无图片</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {listing.images.map((image) => (
              <img
                alt={`图片 ${image.sortOrder}`}
                className="size-20 rounded-lg border border-line object-cover"
                key={image.url}
                src={image.url}
              />
            ))}
          </div>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="mb-2 font-semibold text-[15px]">卖家</h2>
        <p className="text-sm text-ink-2">{listing.seller.nickname}</p>
        <Link
          className="mt-1 inline-block text-sm text-brand"
          params={{ userId: listing.seller.id }}
          to="/admin/users/$userId"
        >
          查看卖家详情
        </Link>
      </Card>

      {/* 交易查询入口（#73 PR4）：交易页的 listingId 是 URL-only 参数，这里正是来源。 */}
      <Card className="p-4">
        <h2 className="mb-2 font-semibold text-[15px]">交易</h2>
        <Link
          className="text-sm text-brand hover:underline"
          search={{ listingId: listing.id }}
          to="/admin/transactions"
        >
          查看该商品的交易
        </Link>
      </Card>

      {/* 治理（#73 PR3）：下架 / 恢复。按钮集合随当前状态收敛——已下架的商品只给
          「恢复」，避免后端必然 409 的死路；交易中 / 已售出的商品不给动作，
          因为后端的条件更新会拒绝，这里提前收起来。恢复的目标状态由后端从
          delist 审计快照取，这里不提供选择器（避免把 RESERVED 恢复成 ACTIVE）。

          「恢复」只看 `governanceDelistedAt`（评审 M3）：OFFLINE + 没有治理下架标记
          的商品是**审核引擎**屏蔽的，恢复路径是人工审核 / 卖家重新送审，治理端点会
         拒绝它。这里如果只看 `status === 'OFFLINE'`，按钮点下去就是必然的 409。 */}
      <GovernancePanel
        actions={
          listing.governanceDelistedAt
            ? [
                {
                  action: 'restore-listing',
                  label: '恢复上架',
                  description: '恢复到被下架前的状态（由下架审计快照决定）',
                },
              ]
            : listing.status === 'ACTIVE' && listing.moderationStatus !== 'BLOCKED'
              ? [
                  {
                    action: 'delist-listing',
                    label: '下架商品',
                    tone: 'danger',
                    description: '商品转为已下架，卖家无法自行修改或上架',
                  },
                ]
              : []
        }
        targetId={listing.id}
      />

      {listing.status === 'ACTIVE' && listing.moderationStatus === 'BLOCKED' ? (
        <Card className="p-4 text-sm text-ink-3">
          该商品已被审核引擎屏蔽，恢复路径是人工审核或卖家修改后重新送审，不在治理动作范围内。
        </Card>
      ) : null}

      <Card className="p-4">
        <h2 className="mb-3 font-semibold text-[15px]">关联 Admin 操作日志</h2>
        {listing.recentAuditLogs.length === 0 ? (
          <EmptyState description="暂无操作日志" emoji="📋" />
        ) : (
          <ul className="divide-y divide-line">
            {listing.recentAuditLogs.map((log) => (
              <li className="flex items-center justify-between gap-3 py-2.5" key={log.id}>
                <div className="min-w-0">
                  <p className="text-sm">{statusLabel(AUDIT_ACTION_LABEL, log.action)}</p>
                  {log.reason ? (
                    <p className="mt-0.5 truncate text-xs text-ink-3">{log.reason}</p>
                  ) : null}
                </div>
                <span className="shrink-0 text-xs text-ink-3">{formatDateTime(log.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

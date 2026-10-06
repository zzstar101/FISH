import type { AdminListingDetail } from '@fish/contracts/admin/schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { ErrorState, LoadingState } from '@fish/ui/states'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { ListingThumb } from '../../components/listing-thumb'
import { PriceText } from '../../components/price-text'
import { categoryLabel, conditionLabel } from '../../lib/labels'
import { ForbiddenInline, NotFoundInline } from './admin-filter'
import { adminLoadView, governanceActionError } from './admin-messages'
import { useAdminListingDetail, useListingDelist, useListingRestore } from './admin-queries'
import { withoutCursor } from './admin-search'
import { auditActionLabelOf, formatAdminDateTime, moderationStatusMeta } from './admin-view'
import type { GovernanceDialogOutput } from './governance-dialog'
import { GovernanceDialog } from './governance-dialog'
import type { ListingsSearch } from './listings-page'

/**
 * 商品详情（#467 验收「详情、审核与治理状态」+ 治理写：下架 / 恢复）。
 *
 * 按钮可见性按契约字段裁决（评审 M3 的存在理由）：
 * - 「恢复上架」只在 `governanceDelistedAt !== null`（被**治理**下架过）时出现——
 *   只被审核引擎屏蔽的商品走 restore 等于用治理端点绕过审核，服务端也会 409。
 * - 「下架」在未被治理下架时可用；服务端对不满足前提的请求返回 409，这里如实透传。
 */
export function ListingDetailPage({
  listingId,
  search,
}: {
  listingId: string
  /** 来源列表的查询条件：返回链接带回去，回到同一视图（#467 五审 P2）。 */
  search: ListingsSearch
}) {
  const detail = useAdminListingDetail(listingId)

  if (detail.isPending) return <LoadingState label="正在加载商品详情…" />
  if (detail.isError) {
    const view = adminLoadView(detail.error, '商品详情加载失败')
    // 403 是权限边界、404 是目标级缺失（#467 五审 P3）：两者都不该给「重试」——
    // 重试改变不了权限，也变不回已删除的商品。
    if (view.kind === 'forbidden') return <ForbiddenInline />
    if (view.kind === 'notFound') return <NotFoundInline label="商品" to="/admin/listings" />
    return <ErrorState message={view.message} onRetry={() => void detail.refetch()} />
  }

  return <ListingDetailView detail={detail.data} listingId={listingId} search={search} />
}

type ListingActionKind = 'delist' | 'restore'

function ListingDetailView({
  detail,
  listingId,
  search,
}: {
  detail: AdminListingDetail
  listingId: string
  search: ListingsSearch
}) {
  const [dialog, setDialog] = useState<ListingActionKind | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const delist = useListingDelist(listingId)
  const restore = useListingRestore(listingId)

  const moderationMeta = moderationStatusMeta(detail.moderationStatus)
  const governanceDelisted = detail.governanceDelistedAt !== null

  async function submit(input: GovernanceDialogOutput, kind: ListingActionKind) {
    setDialogError(null)
    const body = {
      reason: input.reason,
      // 前缀已在弹窗守卫（asSourceReportId）收窄成品牌类型；存在性与目标匹配仍由服务端 404/422 兜底。
      ...(input.sourceReportId !== undefined ? { sourceReportId: input.sourceReportId } : {}),
    }
    try {
      if (kind === 'delist') await delist.mutateAsync(body)
      else await restore.mutateAsync(body)
      setDialog(null)
      setNotice(kind === 'delist' ? '商品已下架' : '商品已恢复')
    } catch (error) {
      const outcome = governanceActionError(error)
      if (outcome.conflict) {
        setDialog(null)
        setNotice(outcome.message)
      } else {
        setDialogError(outcome.message)
      }
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            className="text-ink-3 text-sm hover:text-brand"
            search={withoutCursor(search)}
            to="/admin/listings"
          >
            ← 商品列表
          </Link>
          <h1 className="mt-1 font-semibold text-[26px] tracking-[-0.03em]">{detail.title}</h1>
          <p className="mt-1.5 text-ink-3 text-sm">
            {categoryLabel(detail.category)} · {conditionLabel(detail.condition)} · 卖家{' '}
            <Link
              className="text-brand hover:underline"
              params={{ userId: detail.seller.id }}
              to="/admin/users/$userId"
            >
              {detail.seller.nickname}
            </Link>
            {' · '}
            创建 {formatAdminDateTime(detail.createdAt)} · 更新{' '}
            {formatAdminDateTime(detail.updatedAt)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={moderationMeta.variant}>{moderationMeta.label}</Badge>
          {detail.governanceDelistedAt !== null ? (
            <Badge variant="danger">
              治理下架于 {formatAdminDateTime(detail.governanceDelistedAt)}
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {!governanceDelisted ? (
          <Button
            onClick={() => {
              setDialogError(null)
              setDialog('delist')
            }}
            variant="destructive"
          >
            下架商品
          </Button>
        ) : (
          <Button
            onClick={() => {
              setDialogError(null)
              setDialog('restore')
            }}
            variant="outline"
          >
            恢复上架
          </Button>
        )}
        {detail.moderationStatus === 'REVIEW' ? (
          <Link
            className="rounded-xl bg-brand-soft px-3.5 py-2 font-medium text-brand text-sm hover:bg-brand-soft/70"
            search={{ listingId, tab: 'records' }}
            to="/admin/moderation"
          >
            查看审核记录 →
          </Link>
        ) : null}
      </div>

      {notice !== null ? (
        <p className="rounded-xl bg-warn-soft px-4 py-3 text-sm text-warn" role="status">
          {notice}
        </p>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="gap-3 border border-line p-5">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="font-semibold">商品信息</h2>
            <PriceText cents={detail.priceCents} className="font-bold text-xl" />
          </div>
          <p className="whitespace-pre-wrap text-sm">{detail.description}</p>
          <div className="flex flex-wrap gap-2">
            {detail.images
              .slice()
              .sort((a, b) => a.sortOrder - b.sortOrder)
              .map((image) => (
                <ListingThumb
                  alt={`${detail.title} 图片`}
                  className="size-20 rounded-lg"
                  coverUrl={image.url}
                  key={image.url}
                  listingId={detail.id}
                />
              ))}
            {detail.images.length === 0 ? <p className="text-ink-3 text-sm">无图片</p> : null}
          </div>
          <div className="flex gap-4 text-ink-3 text-xs">
            <span>紧急{detail.urgent ? ' ✓' : ' ✗'}</span>
            <span>可议价{detail.negotiable ? ' ✓' : ' ✗'}</span>
            <span>免费送{detail.free ? ' ✓' : ' ✗'}</span>
          </div>
        </Card>

        <Card className="gap-3 border border-line p-5">
          <h2 className="font-semibold">最近管理操作</h2>
          {detail.recentAuditLogs.length === 0 ? (
            <p className="text-ink-3 text-sm">暂无针对该商品的管理操作记录。</p>
          ) : (
            <ul className="space-y-2.5">
              {detail.recentAuditLogs.map((log) => (
                <li className="text-sm" key={log.id}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{auditActionLabelOf(log.action)}</span>
                    <span className="text-ink-3 text-xs">{formatAdminDateTime(log.createdAt)}</span>
                  </div>
                  {log.reason !== null ? (
                    <p className="mt-0.5 text-ink-3 text-xs">{log.reason}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {dialog !== null ? (
        <GovernanceDialog
          description={
            dialog === 'delist'
              ? `将下架商品「${detail.title}」。下架后公开列表不可见；恢复时回到下架前的状态。`
              : `将恢复商品「${detail.title}」到治理下架前的状态。`
          }
          errorMessage={dialogError}
          onClose={() => setDialog(null)}
          onSubmit={(input) => void submit(input, dialog)}
          pending={dialog === 'delist' ? delist.isPending : restore.isPending}
          requireTarget="listing"
          submitLabel={dialog === 'delist' ? '确认下架' : '确认恢复'}
          title={dialog === 'delist' ? '下架商品' : '恢复上架'}
        />
      ) : null}
    </div>
  )
}

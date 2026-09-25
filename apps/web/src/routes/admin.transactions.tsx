import { createFileRoute } from '@tanstack/react-router'
import { type AdminTransactionsSearch, TransactionsPage } from '../features/admin/transactions-page'

const STATUSES = ['PENDING_MEETUP', 'COMPLETED', 'CANCELLED'] as const
/**
 * URL 日期形态 `YYYY-MM-DD`。只卡月份 1–12 / 日期 1–31，`2026-13-45` 过不了；
 * `2026-02-30` 这种不存在的日期过得了正则但会被 `new Date` 静默滚到 3 月 2 日，
 * 所以下面再回读比对一次（见 `isRealDate`）。
 */
const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
function isRealDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false
  const parsed = new Date(`${value}T00:00:00`)
  const roundTrip =
    `${parsed.getFullYear()}-` +
    `${String(parsed.getMonth() + 1).padStart(2, '0')}-` +
    `${String(parsed.getDate()).padStart(2, '0')}`
  return roundTrip === value
}

/**
 * 交易查询（#73 治理半场 PR4）。
 *
 * 筛选条件写入 URL（刷新 / 复制可复现），值域白名单校验，非法值退回 undefined。
 * `buyerId` / `sellerId` / `listingId` 同样是 URL 参数，但不做白名单化——它们是 uuid，
 * 由用户详情 / 商品详情的「查看交易」链接带进来，原样透传给后端校验（422 由契约负责）。
 */
export const Route = createFileRoute('/admin/transactions')({
  validateSearch: (
    search: Record<string, unknown>,
  ): AdminTransactionsSearch & {
    buyerId?: string
    sellerId?: string
    listingId?: string
  } => {
    const out: AdminTransactionsSearch & {
      buyerId?: string
      sellerId?: string
      listingId?: string
    } = {}
    if (STATUSES.includes(search.status as (typeof STATUSES)[number]))
      out.status = search.status as string
    if (typeof search.q === 'string' && search.q.trim() !== '') out.q = search.q.trim()
    if (typeof search.createdFrom === 'string' && isRealDate(search.createdFrom))
      out.createdFrom = search.createdFrom
    if (typeof search.createdTo === 'string' && isRealDate(search.createdTo))
      out.createdTo = search.createdTo
    if (typeof search.buyerId === 'string' && search.buyerId.trim() !== '')
      out.buyerId = search.buyerId.trim()
    if (typeof search.sellerId === 'string' && search.sellerId.trim() !== '')
      out.sellerId = search.sellerId.trim()
    if (typeof search.listingId === 'string' && search.listingId.trim() !== '')
      out.listingId = search.listingId.trim()
    return out
  },
  component: () => {
    const search = Route.useSearch()
    return (
      <TransactionsPage
        buyerId={search.buyerId}
        listingId={search.listingId}
        search={search}
        sellerId={search.sellerId}
      />
    )
  },
})

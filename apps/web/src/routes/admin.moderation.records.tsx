import { createFileRoute } from '@tanstack/react-router'
import {
  type AdminModerationRecordsSearch,
  ModerationRecordsPage,
} from '../features/admin/moderation-records-page'

const DECISIONS = ['REVIEW', 'ALLOW', 'BLOCK'] as const
/**
 * URL 日期形态 `YYYY-MM-DD`。只卡月份 1–12 / 日期 1–31，`2026-02-30` 这种不存在的
 * 日期过不了正则，`2026-13-45` 也不行；剩下交给下面的日历回读。
 */
const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

/**
 * 形态合法**且**是真实存在的日历日。
 *
 * 正则挡不住 `2026-02-30`：`new Date('2026-02-30T00:00:00')` 会静默滚到 3 月 2 日，
 * 于是筛选窗口整体平移，管理员看到的是一个他没选过的日期范围。回读比对一次即可。
 */
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
 * 审核记录检索（#73 治理半场 PR4）。
 *
 * index 路由（不是 layout）：与 `/admin/moderation/$recordId` 互为兄弟，都挂在 `/admin`
 * 布局下。写成 layout 会让详情页成为它的子路由而永不挂载（见 routes.structure.test.ts）。
 *
 * `listingId` 只在 URL 里出现（从商品详情的「审核记录」链接带进来），表单不暴露 uuid 输入框。
 */
export const Route = createFileRoute('/admin/moderation/records')({
  // 筛选条件写入 URL（#73 设计 §7）：刷新 / 复制都能复现同一组筛选；值域白名单，非法值退回 undefined。
  validateSearch: (search: Record<string, unknown>): AdminModerationRecordsSearch => {
    const out: AdminModerationRecordsSearch = {}
    if (DECISIONS.includes(search.decision as (typeof DECISIONS)[number]))
      out.decision = search.decision as string
    if (typeof search.listingId === 'string' && search.listingId.trim() !== '')
      out.listingId = search.listingId.trim()
    if (typeof search.q === 'string' && search.q.trim() !== '') out.q = search.q.trim()
    if (typeof search.createdFrom === 'string' && isRealDate(search.createdFrom))
      out.createdFrom = search.createdFrom
    if (typeof search.createdTo === 'string' && isRealDate(search.createdTo))
      out.createdTo = search.createdTo
    return out
  },
  component: () => {
    const search = Route.useSearch()
    return <ModerationRecordsPage search={search} />
  },
})

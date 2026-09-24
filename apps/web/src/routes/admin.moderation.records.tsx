import { createFileRoute } from '@tanstack/react-router'
import {
  type AdminModerationRecordsSearch,
  ModerationRecordsPage,
} from '../features/admin/moderation-records-page'

const DECISIONS = ['REVIEW', 'ALLOW', 'BLOCK'] as const
/** URL 日期形态 `YYYY-MM-DD`；顺带卡掉 `2026-13-45` 这种不存在的日期。 */
const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

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
    if (typeof search.createdFrom === 'string' && DATE_PATTERN.test(search.createdFrom))
      out.createdFrom = search.createdFrom
    if (typeof search.createdTo === 'string' && DATE_PATTERN.test(search.createdTo))
      out.createdTo = search.createdTo
    return out
  },
  component: () => {
    const search = Route.useSearch()
    return <ModerationRecordsPage search={search} />
  },
})

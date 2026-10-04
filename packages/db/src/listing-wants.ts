import { type SQL, type SQLWrapper, sql } from 'drizzle-orm'
import { conversations } from './schema/conversations'

/**
 * 商品的「想要数」——**与该商品已建立会话的买家数**，全仓唯一的 SQL 定义。
 *
 * 口径由 #74 / #290 冻结（`docs/design/issue-74-watchers-definition.md`），并由
 * Owner 2026-10-04 拍板：商品卡上的「N 人想要」就取这个数，与卖家在「想要的人」页
 * 看到的名单 `total` 同源。收藏、关注卖家、Wish / Match 一律**不计入**。
 *
 * 为什么收在一个函数里：同一件事在 9 个列表查询里各写一遍，漂移是必然的 ——
 * 某处漏了 `::int` 会让它在驱动里变成字符串、某处写错表就会得出另一个数字，
 * 而页面上两个「想要」对不上时没有任何测试会报警。契约里
 * `ListingCardSchema.wants` 与 watchers 端点的 `total` 因此共用这一份谓词。
 *
 * `conversations_listing_id_buyer_id_uq` 的首列就是 `listing_id`，所以这是每行一次
 * 索引探测（与各列表给封面写的 `listing_images` 关联子查询同一量级），不是 N+1
 * —— 一条 SQL 就把整页的计数带回来。
 *
 * 只按 `listing_id` 过滤、不写 `seller_id`：`conversations_listing_id_seller_id_fk`
 * 这条复合外键保证同一商品的所有会话卖家恒等（`seller_id` 由 `listing_id` 函数决定），
 * 所以这里与 watchers 端点里那句带 `seller_id` 的 `total` 数的是同一批行。
 *
 * `listingId` 必须由调用方给出**带限定**的列引用：drizzle 的 `listings.id` 会渲染成
 * `"listings"."id"`；在裸 SQL（`FROM listings l`）里表名被别名遮住，要传
 * `sql.raw('l.id')`。传裸 `sql\`id\`` 会被解析成子查询作用域里的
 * `listing_images.id` 之类，静默恒为 0（同 `users/store.ts` 封面那处踩过的坑）。
 *
 * 参数类型是 `SQLWrapper`（`SQL` 与 `PgColumn` 都满足），这样 drizzle 的查询构造器里
 * 能直接写 `listingWantsCount(listings.id)`，裸 SQL 里则写 `sql.raw('l.id')`。
 */
export function listingWantsCount(listingId: SQLWrapper): SQL<number> {
  return sql<number>`(SELECT count(*)::int FROM ${conversations} c WHERE c.listing_id = ${listingId})`
}

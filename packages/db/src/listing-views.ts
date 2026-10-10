import { type SQL, type SQLWrapper, sql } from 'drizzle-orm'
import { recommendationEvents } from './schema/recommendation-events'

/**
 * 「浏览量」的统计窗口（天）。改它等于改 `ListingCardSchema.views` 的口径 ——
 * 契约注释、`listing-views.test.ts` 的用例与这里必须一起动。
 */
export const LISTING_VIEWS_WINDOW_DAYS = 30

/**
 * 商品的「浏览量」——**最近 30 天内浏览过该商品的去重人数**，全仓唯一的 SQL 定义。
 *
 * 口径由 Owner 2026-10-10 拍板（#192）：数据源是行为事件表 `recommendation_events` 的
 * `DETAIL_VIEW`（#323 R1 起「点进详情页」就上报一条），**不新增表、不新增列、不加迁移**。
 *
 * ## 为什么是「去重人数」而不是「次数」
 *
 * 商品卡与详情页上并排画的是「浏览 N」与「想要 N」，而「想要」= 已建会话的**买家数**
 * （`@fish/db/listing-wants`）。两个数同量纲，卖家一眼看不出哪个是人数哪个是次数 ——
 * 所以这里也按人去重：登录用户按 `user_id`、未登录按 `anonymous_session_id`
 * （小程序在事件入队时固化它，见 `apps/miniapp/src/features/recommendation/track.ts`）。
 * 同一个人反复点开同一件商品只算一次；刷新页面不会把数字刷高。
 *
 * `COALESCE` 是**逐行**取身份，不是「把同一个人的两种身份合并起来」：一行里两列都有时取
 * `user_id`（客户端登录后仍沿用同一个 `anonymous_session_id`，见
 * `apps/miniapp/src/features/recommendation/session.ts`），但**匿名那一次与登录后那一次是两行、
 * 两个不同的值**（`S` 与 `U`），`count(DISTINCT)` 会把它们算成 **2 个人** —— 也就是
 * 「先匿名逛、再登录看」这条很常见的路径会**高估 1 人**。实测：
 *
 * ```sql
 * select count(distinct coalesce(u, s)) from (values (null::text,'S'), ('U','S')) t(u,s);  -- 2
 * ```
 *
 * 换成 session 优先（`coalesce(anonymous_session_id, user_id)`）能把这种情况合并成 1，代价是
 * **同一账号换设备会被算成 2**。两条路都只能合并一侧，取舍归 Owner；当前实现按拍板的
 * 「登录按 user_id、匿名按 anonymous_session_id」执行。
 *
 * **三条要去认的边界**（都是"人数"这个口径自带的，不是实现缺陷）：
 * - **两列全空的事件不计**：`count(DISTINCT NULL)` 是 0。事件表刻意收这种行（"这件商品被曝光过
 *   多少次"是商品级统计），但它归不到任何一个人身上，所以进不了"去重人数"。
 *   **这种行是会出现的**：`anonymous_session_id` 只在拿到推荐 Feed 响应后才稳定存在
 *   （`features/recommendation/session.ts` 的 180 天 TTL 存储 + 服务端补发），所以未登录、
 *   且从分享卡片/扫码**直接进详情页**（首页 Feed 从未挂载）的用户上报的事件两列皆空 ——
 *   这一次浏览不计入。代价是"浏览 0"同时兼容"真没人看"与"有访客但都没身份"，
 *   属于当前口径的已知损失，不在本谓词里靠猜测补数。
 * - **匿名身份是「设备会话」，不是自然人**：`anonymous_session_id` 是本地存储里 180 天 TTL 的
 *   随机 id，所以同一个人换设备 / 清缓存会被算成两个人；反过来，同一台设备上的两个人算一个人。
 *   这是本仓既有的匿名身份口径，不是这里新引入的近似。
 * - **匿名事件可以被伪造，本谓词不承担防刷**：`POST /recommendations/events` 匿名可写、
 *   `eventId` 由客户端自生成（换一个 UUID 就绕过去），#323 R1 **刻意不做限流**（见
 *   `schema/recommendation-events.ts` 里曝光唯一索引那段说明）。所以换一个
 *   `anonymous_session_id` 就能给某件商品刷出一个"新访客"。要防刷得在**写入口**做限流/校验
 *   （属 #323 埋点域，不在本 PR 范围）；这里只把它记成已知暴露面 —— 本 PR 之前这些事件只喂
 *   推荐训练，现在会变成公开可见的数字，暴露面因此变大。
 *
 * ## 为什么是 30 天滚动窗口，不是累计
 *
 * 事件有 180 天保留期（`RECOMMENDATION_EVENT_RETENTION_DAYS`），累计数在这个系统里没有
 * 可依赖的来源；窗口取 30 天既留得下"这个商品最近热不热"的信息，也让数字有明确边界。
 * **代价要认**：数字会随旧浏览滚出窗口而下降，这是口径本身，不是 bug。
 *
 * ## 只按 `listing_id` + 时间窗过滤，不筛身份
 *
 * 卖家自己点开自己的商品也计入 —— 它是商品级的公开市场信号，与「想要数」同一取向
 * （不按视角给不同的数，否则同一件商品在买家和卖家眼里会出现两个「浏览」）。
 *
 * ## 与 `listingWantsCount` 相同的三条实现约束
 *
 * 1. `::int` 不是装饰：`count(...)` 是 bigint，少了这个 cast，驱动交回来的不是 JS number。
 * 2. `listingId` 必须由调用方给出**带限定**的列引用。理由与全部踩坑记录见
 *    `./listing-wants.ts` 的注释：单表 `.from(listings)` 的 select 列表里 drizzle 把
 *    `listings.id` 渲染成裸 `"id"`，落进子查询作用域后先解析到 `recommendation_events.id`
 *    （条件恒假）→ 静默恒为 0。要限定就**手写那道限定**：单表 drizzle 查询传
 *    `sql.raw('listings.id')`，裸 SQL 传该查询自己的别名（如
 *    `apps/api/src/modules/profile/store.ts` 里 `FROM listings l` 对应 `sql.raw('l.id')`）。
 *    注意 `sql.raw('l.id')` 只在那条裸 SQL 里成立 —— 单表 drizzle 查询里没有 `l` 这个别名，
 *    会直接报 `missing FROM-clause entry for table "l"`。
 * 3. 关联子查询走 `recommendation_events_listing_id_occurred_at_idx` 的
 *    `(listing_id, occurred_at)` 前缀，每行一次索引区间扫描；`event_type` 是区间内的残余过滤。
 *    与「想要数」（唯一索引上的 `count(*)`）的差别是：这里多一次 **DISTINCT 去重排序**，成本随
 *    该商品窗口内的事件数增长。当前 10 个调用点都在各读路径的**主查询**里，一条 SQL 带出整页
 *    计数，不逐卡补查（与「想要数」同一取舍）。
 */
export function listingViewsCount(listingId: SQLWrapper): SQL<number> {
  return sql<number>`(SELECT count(DISTINCT COALESCE(e.user_id::text, e.anonymous_session_id::text))::int
    FROM ${recommendationEvents} e
    WHERE e.listing_id = ${listingId}
      AND e.event_type = 'DETAIL_VIEW'
      AND e.occurred_at >= now() - make_interval(days => ${LISTING_VIEWS_WINDOW_DAYS}))`
}

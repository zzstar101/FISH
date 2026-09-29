/**
 * Recommendation Domain 路由常量（Issue #323 / R1）。
 *
 * 这些是 **API 侧路径**（根级）。Web 侧写相对路径 `/api` + 常量，由 Vite 代理去掉前缀；
 * 小程序没有代理层，用绝对地址拼根级路由（`apps/miniapp/src/lib/api-base.ts`）。
 *
 * 与 `LISTING_ROUTES` **刻意分开**：`GET /listings` 是确定性商品查询，推荐 Feed 是
 * 用户相关、策略版本相关、游标语义也不同的接口（Issue #323 §M7）。
 */
export const RECOMMENDATION_ROUTES = {
  /** 推荐 Feed（R1：透传 newest，带 requestId / strategyVersion）。 */
  feed: '/recommendations/feed',
  /** 行为事件批量写入（匿名可写、202）。 */
  events: '/recommendations/events',
} as const

/**
 * 推荐上下文的自定义请求头。
 *
 * 为什么要 header 而不是 body：上下文要跟着**别人的**请求走（收藏 / 评论 / 发起会话 / 下单
 * 都各有自己的 body 契约），塞进 body 就得给每个契约加字段 —— 那些字段跟该接口的业务语义无关。
 * header 是带外信息：不参与业务校验，缺失时退化成"这次行为没有推荐归因"，而不是 400。
 *
 * `sessionId` 在 Feed 请求上由客户端携带；服务端发现缺失时会补发一个并在响应头里回写，
 * 客户端存下来复用（否则每次请求都是新会话，会话级信号全废）。
 */
export const RECOMMENDATION_HEADERS = {
  /** 匿名会话标识（UUID）。 */
  sessionId: 'x-anonymous-session-id',
  /** 本次行为来自哪次推荐请求（`recommendation_requests.id`）。 */
  requestId: 'x-recommendation-request-id',
  /** 召回通道。 */
  source: 'x-recommendation-source',
  /** 在本次推荐请求里的全局序号。 */
  position: 'x-recommendation-position',
} as const

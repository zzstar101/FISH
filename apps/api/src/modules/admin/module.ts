import type { Db } from '@fish/db/client'
import type { MiddlewareHandler } from 'hono'
import type { LatencyRecorder } from '../../observability/latency'
import type { AuthVariables } from '../auth/middleware'
import type { RestrictionGuard } from '../governance/guard'
import type { GovernanceService } from '../governance/service'
import { createSqlModerationStore } from '../moderation/store'
import { createReportsRouter } from '../reports/router'
import { createReportService } from '../reports/service'
import { createSqlReportStore } from '../reports/store'
import { createListingMediaSettlement } from '../uploads/listing-media-settlement'
import type { MediaStorage } from '../uploads/storage'
import { createRequireAdmin } from './middleware'
import { createAdminRouter } from './router'
import { createAdminService, type RecommendationProcessMetrics } from './service'
import { createSqlAdminStore } from './store'

/**
 * Admin 模块装配入口（#73，设计 §2 / §6）：`app.ts` 只负责 `app.route('/admin', admin.router)`。
 *
 * - 与普通 API 同进程、同数据库；代码按模块隔离，`apps/api/src/modules/admin/**` 只依赖
 *   公开的 auth 上下文（requireAuth）与共享 storage，不直接修改其他 Domain 的内部状态。
 * - 两道守卫在 router 内 `use('*')` 应用：先 `requireAuth`（401），再 `requireAdmin`（403）。
 * - storage 复用 app.ts 创建的唯一实例，「公开 URL 怎么拼」只允许一个实现（与 #6 一致）。
 * - 举报的 Admin 端点复用一个 reports store/service 实例（用户端路由在 app.ts 独立挂载，
 *   共用同一个 service 才能保证「用户提交后立刻能在队列里看到」)。
 */
export function createAdminModule(options: {
  db: Db
  storage: MediaStorage
  requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>
  governance: GovernanceService
  guard: RestrictionGuard
  /**
   * 进程内延迟采样（#323 R6）：与推荐 router 共用 `app.ts` 创建的**同一个**实例——
   * 写侧记样本、读侧出分位数。缺省时 admin service 自建空实例（测试场景）。
   */
  latency?: LatencyRecorder
  /** 推荐埋点的进程内计数（#323 R6，PR-2 注入）：传**读取函数**（`() => recorder.snapshot()`），
   * 而不是启动时的一份快照——否则端点会永远返回 0。 */
  recommendationProcessMetrics?: () => RecommendationProcessMetrics
}) {
  // #286 复审 blocker 1：管理员对 REVIEW 商品的 ALLOW/BLOCK 必须同时结算它引用的审核中图片，
  // 否则人工放行会被卖家下一次「不改图」的文本编辑重新压回人工队列。钩子从 uploads 域注入，
  // moderation 域只负责在决策事务里调用它（见 modules/moderation/store.ts 的 decideWithin）。
  const moderation = createSqlModerationStore(options.db, {
    settleListingMedia: createListingMediaSettlement({ storage: options.storage }),
  })
  const store = createSqlAdminStore(options.db, moderation)
  const requireAdmin = createRequireAdmin({ store })
  const reportStore = createSqlReportStore(options.db)
  const reportsService = createReportService(reportStore)
  const router = createAdminRouter({
    service: createAdminService({
      store,
      storage: options.storage,
      latency: options.latency,
      recommendationProcessMetrics: options.recommendationProcessMetrics,
    }),
    reportsService,
    requireAuth: options.requireAuth,
    requireAdmin,
    governance: options.governance,
  })
  return {
    router,
    /** 用户端举报路由（POST /reports、GET /reports/mine），由 app.ts 挂在 requireAuth 之后。 */
    reportsRouter: createReportsRouter({
      service: reportsService,
      guard: options.guard,
      // requireAuth 保证 userId 已注入；缺失时直接报错，
      // 而不是 `String(undefined)` 把字符串 "undefined" 写进 reporter_id。
      getUserId: (c) => {
        const userId = c.get('userId')
        if (!userId) throw new Error('reports 路由被调用时 userId 缺失（requireAuth 未生效）')
        return String(userId)
      },
    }),
  }
}

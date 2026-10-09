import type { Db } from '@fish/db/client'
import type { MiddlewareHandler } from 'hono'
import type { LatencyRecorder } from '../../observability/latency'
import type { AuthVariables } from '../auth/middleware'
import { createDisputesRouter } from '../disputes/router'
import { createDisputeService } from '../disputes/service'
import { createSqlDisputeStore, type DisputeNotificationWriter } from '../disputes/store'
import { createFeedbackRouter } from '../feedback/router'
import { createFeedbackService } from '../feedback/service'
import { createSqlFeedbackStore } from '../feedback/store'
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
  /**
   * 争议进展通知（#465）。**在争议状态变更的同一事务里**写入（执行器就是那个事务），
   * 不是 best-effort 旁路：结论提交后写通知失败会让当事人永久收不到结果，而库里没有
   * outbox 可以补投（plan §2 冻结口径）。接线层决定「通知怎么写」，本模块只透传。
   */
  notifyDispute?: DisputeNotificationWriter
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
  // 争议（#465）与举报同一姿态：用户端与管理端共用一个 store/service 实例，
  // 可见性口径与状态机只有一套真相。
  const disputesService = createDisputeService({
    store: createSqlDisputeStore(options.db, { notify: options.notifyDispute }),
    storage: options.storage,
  })
  // 意见反馈（#463）同一姿态：用户端与管理端共用一个 service 实例。
  const feedbackService = createFeedbackService(createSqlFeedbackStore(options.db))
  const router = createAdminRouter({
    service: createAdminService({
      store,
      storage: options.storage,
      latency: options.latency,
      recommendationProcessMetrics: options.recommendationProcessMetrics,
    }),
    reportsService,
    disputesService,
    feedbackService,
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
    /** 用户端争议路由（#465），由 app.ts 挂在 requireAuth 之后。 */
    disputesRouter: createDisputesRouter({
      service: disputesService,
      guard: options.guard,
      getUserId: (c) => {
        const userId = c.get('userId')
        if (!userId) throw new Error('disputes 路由被调用时 userId 缺失（requireAuth 未生效）')
        return String(userId)
      },
    }),
    /** 用户端反馈路由（#463），由 app.ts 挂在 requireAuth 之后。 */
    feedbackRouter: createFeedbackRouter({
      service: feedbackService,
      getUserId: (c) => {
        const userId = c.get('userId')
        if (!userId) throw new Error('feedback 路由被调用时 userId 缺失（requireAuth 未生效）')
        return String(userId)
      },
    }),
  }
}

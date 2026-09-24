import type { Db } from '@fish/db/client'
import type { MiddlewareHandler } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import { createSqlModerationStore } from '../moderation/store'
import { createReportsRouter } from '../reports/router'
import { createReportService } from '../reports/service'
import { createSqlReportStore } from '../reports/store'
import type { MediaStorage } from '../uploads/storage'
import { createRequireAdmin } from './middleware'
import { createAdminRouter } from './router'
import { createAdminService } from './service'
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
}) {
  const moderation = createSqlModerationStore(options.db)
  const store = createSqlAdminStore(options.db, moderation)
  const requireAdmin = createRequireAdmin({ store })
  const reportStore = createSqlReportStore(options.db)
  const reportsService = createReportService(reportStore)
  const router = createAdminRouter({
    service: createAdminService({ store, storage: options.storage }),
    reportsService,
    requireAuth: options.requireAuth,
    requireAdmin,
  })
  return {
    router,
    /** 用户端举报路由（POST /reports、GET /reports/mine），由 app.ts 挂在 requireAuth 之后。 */
    reportsRouter: createReportsRouter({
      service: reportsService,
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

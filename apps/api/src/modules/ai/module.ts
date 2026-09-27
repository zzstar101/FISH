import type { Db } from '@fish/db/client'
import type { AiPolishEnv } from '@fish/shared/env'
import type { MiddlewareHandler } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import type { RestrictionGuard } from '../governance/guard'
import { createPolishProvider } from './provider'
import { createAiPolishRouter } from './router'
import { createAiPolishService } from './service'
import { createSqlAiPolishStore } from './store'

/**
 * AI 润色模块装配入口（#141）：`app.ts` 只负责接线，provider / store / service 的拼装在这里。
 *
 * `env` 由进程入口用 `loadAiPolishEnv()` 校验后传入（transport 无默认值、缺配置启动即失败），
 * 所以这里不需要再兜一层配置检查——service 里的 503 只是运行期兜底。
 */
export function createAiPolishModule(options: {
  db: Db
  requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>
  env: AiPolishEnv
  guard: RestrictionGuard
}) {
  const provider = createPolishProvider(options.env)
  const router = createAiPolishRouter({
    service: createAiPolishService({
      store: createSqlAiPolishStore(options.db),
      provider,
      env: options.env,
    }),
    requireAuth: options.requireAuth,
    guard: options.guard,
  })
  return { router }
}

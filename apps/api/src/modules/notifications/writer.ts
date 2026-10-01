import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { jsonParam } from '@fish/db/json'
import type { NotificationPayload, NotificationType } from '@fish/db/schema/notifications'
import { notifications } from '@fish/db/schema/notifications'

/**
 * 业务域写通知的唯一入口（任务一：TX / MODERATION / ACCOUNT 的产生点）。
 *
 * MATCH 由 worker 的匹配引擎在匹配事务里直写（`apps/worker/.../matching/engine.ts`），
 * 不走这里；API 侧的写入点统一经本 helper，保证 id 生成与列形状只有一处。
 *
 * 写入是**尽力而为**的旁路：通知只是 UI 糖，任何失败都不能拖垮触发它的业务操作
 * （提议/接受/审核结论已经落库）。调用方各自 catch（app.ts 的 notify 包装、认证服务的
 * try/catch）—— 本函数自身只管把行写进去。
 *
 * `executor` 收 `Db` 或 drizzle 事务：moderation 的结论与通知**同事务**落库
 * （决策回滚则通知不存在的口径）；其余调用点传 `db` 即可。
 *
 * `jsonParam` 不能省：裸对象在 drizzle 0.45.2 + bun-sql 下会被 stringify 两次，
 * 落库成 `jsonb_typeof = 'string'`，读侧的 `jsonb_typeof(payload) = 'object'` 谓词
 * 会把整行判成不可投影 —— 通知静默消失（详见 `packages/db/src/json.ts`）。
 */
export async function writeNotification(
  executor: Db | Parameters<Parameters<Db['transaction']>[0]>[0],
  input: { userId: string; type: NotificationType; payload: NotificationPayload },
): Promise<void> {
  await executor.insert(notifications).values({
    id: newId(),
    userId: input.userId,
    type: input.type,
    payload: jsonParam(input.payload),
  })
}

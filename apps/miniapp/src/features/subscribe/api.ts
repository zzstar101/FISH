/**
 * 微信订阅消息的端上 API（#462）：模板配置 + 授权结果上报。
 *
 * 两条口径：
 *
 * 1. **模板 ID 由服务端下发**（`GET /subscribe-messages/config`），端上不硬编码。每个 kind
 *    要么是模板 ID、要么是 `null`（未开通）。`null` 的 kind 端上**不弹授权** —— 微信会直接
 *    报错，而且用户看到的是一个永远不会兑现的授权框。
 * 2. **上报的是微信的原始结果**（`accept` / `reject` / `ban` / `filter`），服务端只认
 *    `accept`。端上不做任何"是否算成功"的判断，避免两端各有一套记账口径。
 */
// 必须是第一条：在任何契约（zod schema）模块被求值之前关掉 zod 的 JIT，见该模块的说明
import '@/lib/zod-jitless'
import { SUBSCRIBE_MESSAGE_ROUTES } from '@fish/contracts/subscribe-messages/routes'
import {
  type SubscribeMessageConfig,
  type SubscribeMessageGrantReport,
  type SubscribeMessageGrantsResponse,
  subscribeMessageConfigSchema,
  subscribeMessageGrantsResponseSchema,
} from '@fish/contracts/subscribe-messages/schema'
import { apiRequest } from '@/lib/request'

/**
 * 模板配置的进程内缓存。
 *
 * 为什么缓存：模板 ID 只在运维改 env 并重启 API 时变，而 `requestSubscribeMessage` **必须在
 * 用户点击回调里同步发起**（微信硬约束）—— 每次点击都先 `await` 一次配置请求，等于把那次
 * 调用挪出用户手势，微信侧会直接失败。所以启动时预热一次，点击时同步读缓存。
 */
let cached: SubscribeMessageConfig | null = null
let inFlight: Promise<SubscribeMessageConfig | null> | null = null

/** 同步读缓存（没预热过就是 `null`，调用方据此决定"这次不弹授权"）。 */
export function cachedSubscribeConfig(): SubscribeMessageConfig | null {
  return cached
}

/**
 * 取一次模板配置并缓存。失败返回 `null` 且**不抛**：订阅消息是锦上添花，
 * 配置接口挂掉不该让任何页面报错。
 */
export async function loadSubscribeConfig(): Promise<SubscribeMessageConfig | null> {
  if (cached !== null) return cached
  if (inFlight === null) {
    inFlight = apiRequest(SUBSCRIBE_MESSAGE_ROUTES.config)
      .then((payload) => {
        cached = subscribeMessageConfigSchema.parse(payload)
        return cached
      })
      .catch((error: unknown) => {
        console.warn('[miniapp] 订阅消息配置获取失败（不影响功能）', error)
        return null
      })
      .finally(() => {
        // 失败不缓存：下次进页面还有机会拿到（配置接口挂了是暂时态）。
        inFlight = null
      })
  }
  return inFlight
}

/**
 * 上报一次 `requestSubscribeMessage` 的结果，返回各 kind 剩余次数。
 *
 * `null` = 上报失败/未开通（503），调用方不需要区分：这只影响"还能发几条"的展示，
 * 从不阻塞用户正在做的事。
 */
export async function reportSubscribeGrants(
  report: SubscribeMessageGrantReport,
): Promise<SubscribeMessageGrantsResponse | null> {
  try {
    const payload = await apiRequest(SUBSCRIBE_MESSAGE_ROUTES.grants, {
      method: 'POST',
      body: report,
    })
    return subscribeMessageGrantsResponseSchema.parse(payload)
  } catch (error) {
    console.warn('[miniapp] 订阅消息授权上报失败（不影响功能）', error)
    return null
  }
}

/** 仅测试用：清掉模块级缓存。 */
export function resetSubscribeConfigCacheForTest(): void {
  cached = null
  inFlight = null
}

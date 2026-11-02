import {
  SUBSCRIBE_MESSAGE_GRANT_LIMIT,
  type SubscribeMessageConfig,
  type SubscribeMessageGrantReport,
  type SubscribeMessageGrantsResponse,
  type SubscribeMessageKind,
} from '@fish/contracts/subscribe-messages/schema'
import type { SubscribeMessageTemplatesEnv, WechatEnv } from '@fish/shared/env'
import type { SubscribeMessageStore } from './store'

/**
 * 订阅消息的业务层（#462）：能力开关 + 授权记账。
 *
 * 分两件事看：
 *
 * 1. **能力开关**是「进程配置 → 每个 kind 有没有模板」的一次性推导（`resolveCapability`）。
 *    它同时决定三处行为：`GET config` 下发什么、`POST grants` 是否 503、调度循环是否启动。
 *    只在这里算一次，三处共用，避免"配置接口说开通了、投递却永远不发"。
 * 2. **授权记账**只认 `accept`（Owner 冻结口径）：一次性订阅每「允许」一次 +1，封顶
 *    `SUBSCRIBE_MESSAGE_GRANT_LIMIT`；`reject` / `ban` / `filter` / 未知值都不加。
 */

/** 进程级能力描述。`templateIds[kind] === null` = 该 kind 未开通。 */
export type SubscribeMessageCapability = {
  /** 至少一个模板已配置**且** `WECHAT_TRANSPORT=live` 时才为 true。 */
  enabled: boolean
  templateIds: Record<SubscribeMessageKind, string | null>
}

/** 能力相关的业务异常（目前只有"未开通"）。 */
export class SubscribeMessageError extends Error {
  constructor(
    readonly code: 'SUBSCRIBE_MESSAGES_DISABLED',
    message: string,
    readonly status: 503,
  ) {
    super(message)
    this.name = 'SubscribeMessageError'
  }
}

/**
 * 由 env 推导能力：模板 ID 配好还不够，**必须** `WECHAT_TRANSPORT=live` 才有 access_token
 * （`off`/`stub` 下 `app.ts` 根本不会构造令牌服务），所以两者缺一整个能力关闭。
 *
 * 关闭时不是启动失败：模板要在微信后台用正式 AppID 手工添加，加好之前"还没开通"是正常状态，
 * 端上拿到 `null` 就不弹授权框（见契约注释）。
 */
export function resolveCapability(input: {
  transport: WechatEnv['transport']
  templates: SubscribeMessageTemplatesEnv
}): SubscribeMessageCapability {
  const live = input.transport === 'live'
  const templateIds: Record<SubscribeMessageKind, string | null> = {
    CHAT: live ? input.templates.chat : null,
    TX: live ? input.templates.tx : null,
    REVIEW: live ? input.templates.review : null,
  }
  return {
    enabled: templateIds.CHAT !== null || templateIds.TX !== null || templateIds.REVIEW !== null,
    templateIds,
  }
}

export type SubscribeMessageService = {
  /** `GET /subscribe-messages/config`：每个 kind 的模板 ID 或 `null`。 */
  config(): SubscribeMessageConfig
  /** `POST /me/subscribe-messages/grants`：上报授权结果，返回各 kind 剩余次数。 */
  reportGrants(
    userId: string,
    report: SubscribeMessageGrantReport,
  ): Promise<SubscribeMessageGrantsResponse>
}

export function createSubscribeMessageService(deps: {
  store: SubscribeMessageStore
  capability: SubscribeMessageCapability
}): SubscribeMessageService {
  return {
    config() {
      // 原样返回能力里的模板 ID（含 `null`）：端上只凭它决定"这个 kind 弹不弹授权"。
      return { templates: { ...deps.capability.templateIds } }
    },

    async reportGrants(userId, report) {
      // 能力关闭时 503 而不是静默记账：等模板开通时，那些一次性授权早已随模板变更失效，
      // 记下的次数是假的（见契约注释）。
      if (!deps.capability.enabled) {
        throw new SubscribeMessageError('SUBSCRIBE_MESSAGES_DISABLED', '微信订阅消息暂未开通', 503)
      }

      // 同一个 kind 重复出现按**最后一次**算（契约注释的口径）：端上把
      // `requestSubscribeMessage` 的返回值摊平上报，重复键只可能是端上 bug —— 但"以最后一
      // 次为准"能让这种 bug 的后果停在"这次没加上"，而不是"凭空多出一次额度"。
      const lastStatusByKind = new Map(report.grants.map((grant) => [grant.kind, grant.status]))

      // 只认 `accept`，且只记**该 kind 确实已配置模板**的那些：端上凭 `GET config` 决定弹哪个
      // 模板，所以未配置的 kind 出现在上报里只可能是端上用了旧缓存 —— 记下来也发不出去。
      const accepted = [...lastStatusByKind.entries()]
        .filter(([, status]) => status === 'accept')
        .map(([kind]) => kind)
        .filter((kind) => deps.capability.templateIds[kind] !== null)

      if (accepted.length > 0) {
        await deps.store.addAcceptedGrants(userId, accepted, SUBSCRIBE_MESSAGE_GRANT_LIMIT)
      }

      // 无论这次加没加，都返回**当前**三个 kind 的剩余次数：端上要靠它显示额度、
      // 也可能紧接着再弹一次授权。
      return { remaining: await deps.store.readRemaining(userId) }
    },
  }
}

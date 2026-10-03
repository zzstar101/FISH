/**
 * 发送商品选择页的纯逻辑（#359 3a 审查回合）。
 *
 * 为什么抽出来：页面组件没有渲染测试基建（本仓既有口径），而这两件事必须被用例锁住 ——
 * 幂等键「重试复用、成功才丢弃」，以及失败文案的分档（404 / 409 都不是「再点一次就好」）。
 */

/**
 * 取（或生成）一件商品的发送幂等键。
 *
 * 服务端以 `(senderId, conversationId, clientRequestId)` 去重（#366 的
 * `messageSendKey` + `findMessageByRequestKey`）：**同一件商品的重试必须复用同一个键**，
 * 否则「请求超时但其实已落库」时再点一次会真落第二条商品卡（对方未读 +2），而契约要求的
 * 是重放既有那条。成功后才把键丢弃（见调用点的 `delete`）。
 *
 * 生成器由调用方注入（`@/lib/uuid` 的 `randomUuidV4`，小程序没有 `crypto`），便于测试。
 */
export function sendKeyFor(
  keys: Map<string, string>,
  listingId: string,
  make: () => string,
): string {
  const existing = keys.get(listingId)
  if (existing !== undefined) return existing
  const created = make()
  keys.set(listingId, created)
  return created
}

/**
 * 发送失败的文案分档。
 *
 * 这条路径上服务端会给出四类结论（见 `apps/api/src/modules/messages/service.ts` 与
 * `router.ts`）：商品不可见 / 会话不存在或我不是参与者 / 同键换了商品 / 请求体不合法。
 * 除最后一类外都不是「重试就能好」，所以不能一律说「请重试」。
 */
export function sendFailureText(code: string | null): string {
  switch (code) {
    case 'LISTING_NOT_FOUND':
      return '商品已下架或已售出'
    case 'CONVERSATION_NOT_FOUND':
      return '会话不存在或已结束'
    case 'IDEMPOTENCY_KEY_REUSED':
      return '发送内容有变化，请重新发送'
    default:
      return '发送失败，请重试'
  }
}

/**
 * 这次失败要不要作废幂等键。
 *
 * `IDEMPOTENCY_KEY_REUSED` 的语义是「同一个键配了不同的内容」（服务端指纹比对），
 * 沿用旧键重试只会一直 409 —— 必须换新键，下一次点击才算一次新发送。
 */
export function shouldDropSendKey(code: string | null): boolean {
  return code === 'IDEMPOTENCY_KEY_REUSED'
}

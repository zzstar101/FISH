import { LISTING_ROUTES } from '@fish/contracts/listings/routes'
import { ListingNoSchema, ListingNumberLookupResponseSchema } from '@fish/contracts/listings/schema'
import { ApiError, apiRequest } from '../../lib/api-client'

/**
 * 公开编号（#217 / #382）：「这串输入是不是商品编号」与「按编号精确查一件商品」。
 *
 * 判据只有一处来源：契约 `ListingNoSchema`（`^[1-9][0-9]{11}$`，首位非 0）。**不在这里重写
 * 正则** —— 契约放宽 / 收紧编号格式时这里自动跟着变。编号一律按字符串处理，永不数字强转。
 */

/** 是否为合法商品编号（trim 后判）。合法才允许走 by-number 端点。 */
export function isListingNumberQuery(value: string): boolean {
  return ListingNoSchema.safeParse(value.trim()).success
}

/**
 * 「像编号但不合法」的行内提示（纯数字、长度 9–14、却不满足契约）。
 *
 * 验收要求「输入不是合法编号（长度 / 字符不符）时不发请求，直接给提示」：这类输入大概率是
 * 用户在敲编号（敲少 / 敲多了一位、把开头 0 也带上），直接当关键词模糊搜会让人困惑。
 * 窗口取 9–14 位：更短的数字串（如「12345」）更像普通关键词，不打扰。
 * 返回 null 表示不是这种输入，不给提示。
 */
export function numberQueryHint(value: string): string | null {
  const trimmed = value.trim()
  if (isListingNumberQuery(trimmed)) return null
  if (!/^\d{9,14}$/.test(trimmed)) return null
  return '这串数字像商品编号但不合法：编号是 12 位数字且首位不为 0，已按关键词搜索。'
}

/** by-number 端点路径拼装。 */
export function listingNumberPath(listingNo: string): string {
  return LISTING_ROUTES.byNumber(listingNo)
}

/**
 * 按编号精确查一件商品，返回 canonical `lst_...` ID。
 *
 * **只把 404 `LISTING_NOT_FOUND` 收敛成 null**（编号不存在 / 商品已下架 / 对当前访客不可见——
 * 服务端对三者统一返回这个 404，不做存在性 oracle）；其余一律抛出：
 * 429 / 503 要走「稍后再试」而不是「没这件商品」，代理层的裸 404（api-client 会包成
 * `INTERNAL_ERROR`）也不能被当成业务空态。调用点虽已用 `isListingNumberQuery` 把关，
 * 这里再校验一次入参：编号是用户输入，不能未加验证就拼进 URL 路径
 * （与 `features/listing-detail/api.ts` 对 `ListingIdSchema` 的做法一致）。
 */
export async function findListingByNumber(
  listingNo: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const parsed = ListingNoSchema.safeParse(listingNo)
  if (!parsed.success) throw new Error('非法的商品编号，拒绝发起 by-number 请求')
  try {
    const payload = await apiRequest(listingNumberPath(parsed.data), { signal })
    return ListingNumberLookupResponseSchema.parse(payload).id
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && error.code === 'LISTING_NOT_FOUND') {
      return null
    }
    throw error
  }
}

/** 编号查询失败的行内文案（429 优先消费服务端的 `retryAfterSeconds`）。 */
export function lookupErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'LISTING_LOOKUP_RATE_LIMITED') {
      return error.retryAfterSeconds === undefined
        ? '查询太频繁，请稍后再试'
        : `查询太频繁，请 ${error.retryAfterSeconds} 秒后再试`
    }
    if (error.status === 503) return '暂时无法查询编号，请稍后再试'
    return error.message
  }
  return '网络异常，请稍后重试'
}

/** fetch 的 abort 不算失败：那是调用方自己取消的（输入变了 / 组件卸载了）。 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * 编号解析的 phase。`hit` 由容器负责跳详情；`miss` 渲染业务空态；
 * `error` 是 429 / 503 / 网络这类「等一下再试」的失败。
 */
export type NumberLookupPhase =
  | { kind: 'idle' }
  | { kind: 'loading'; listingNo: string }
  | { kind: 'miss'; listingNo: string }
  | { kind: 'hit'; listingId: string }
  | { kind: 'error'; message: string }

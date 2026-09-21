/**
 * 愿望域 API（许愿页 / 发布页）。
 *
 * 路径一律取自契约常量（`@fish/contracts/wishes/routes`），响应一律用契约 schema
 * 收口 —— 形状漂移在解析处就炸，而不是渲染到页面上才炸。
 *
 * `/wishes` 整条挂在 `requireAuth` 之下（`apps/api/src/app.ts`），必须登录。
 */
import { WISH_ROUTES } from '@fish/contracts/wishes/routes'
import {
  type WishCreateInput,
  type WishDto,
  type WishPoolItem,
  wishDtoSchema,
  wishListResponseSchema,
  wishPoolResponseSchema,
} from '@fish/contracts/wishes/schema'
import { apiRequest } from '@/lib/request'
import { collectWishPages } from './paging'

/** 契约 `wishListQuerySchema` 的 `pageSize` 上限是 50。 */
const MY_WISHES_PAGE_SIZE = 50

/** 翻页上限：`total` 异常时不至于死循环（1000 条已远超真实用量）。 */
const MY_WISHES_MAX_PAGES = 20

/**
 * 我的愿望（全部状态，服务端按创建时间倒序）。
 *
 * 契约的 `pageSize` 上限是 50，而愿望数没有上限（同时 ACTIVE 限 10 条，但
 * CLOSED / FULFILLED 会一直累积），所以按 `total` **翻页取全**（`collectWishPages`）：
 * 只取第一页会让老愿望静默消失，而许愿页的 tab 与二级筛选计数都是从这份列表现算的。
 */
export async function fetchMyWishes(): Promise<WishDto[]> {
  return collectWishPages(async (page) => {
    const payload = wishListResponseSchema.parse(
      await apiRequest(WISH_ROUTES.base, {
        query: { page, pageSize: MY_WISHES_PAGE_SIZE },
      }),
    )
    return { items: payload.items, total: payload.total }
  }, MY_WISHES_MAX_PAGES)
}

/** 单个愿望（匹配结果页要拿它的关键词 / 预算 / 状态）。非本人或不存在都会报错。 */
export async function fetchWish(id: string): Promise<WishDto> {
  const payload = await apiRequest(WISH_ROUTES.detail(id))
  return wishDtoSchema.parse(payload)
}

/** 愿望池：全站聚合（k-匿名门槛由服务端把关），只有聚合数字、没有所有者信息。 */
export async function fetchWishPool(): Promise<WishPoolItem[]> {
  const payload = await apiRequest(WISH_ROUTES.pool)
  return wishPoolResponseSchema.parse(payload).items
}

/**
 * 发布愿望。
 *
 * 失败由调用方按 `ApiError.code` 展示，不在这一层吞掉：
 * `CONFLICT`(409) = 同时 ACTIVE 的愿望达上限；`VALIDATION_ERROR` / `BAD_REQUEST` = 输入不合法。
 */
export async function createWish(input: WishCreateInput): Promise<WishDto> {
  const payload = await apiRequest(WISH_ROUTES.base, { method: 'POST', body: input })
  return wishDtoSchema.parse(payload)
}

/** 关闭愿望：ACTIVE → CLOSED（服务端校验归属，非本人 / 已终态都会报错）。 */
export async function closeWish(id: string): Promise<WishDto> {
  const payload = await apiRequest(WISH_ROUTES.close(id), { method: 'POST' })
  return wishDtoSchema.parse(payload)
}

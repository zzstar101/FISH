/**
 * 「这串输入是不是商品编号」的判据（#217 的 12 位 `listingNo`）。
 *
 * 与 Web 端 `apps/web/src/features/search/number-query.ts` 同一口径，判据只有一处来源：
 * 契约 `ListingNoSchema`（`^[1-9][0-9]{11}$`，首位非 0）。**不在这里重写正则** ——
 * 契约放宽 / 收紧编号格式时，两端一起跟着变，而不是一端悄悄不认了。
 *
 * 纯函数、零依赖（不 import `@/lib/request`）：搜索页拿它做「编号精确查询 / 关键词搜索」
 * 的路由，测试可以直接加载本模块。
 */
import { ListingNoSchema } from '@fish/contracts/listings/schema'

export function isListingNumberQuery(value: string): boolean {
  return ListingNoSchema.safeParse(value.trim()).success
}

import { ListingNoSchema } from '@fish/contracts/listings/schema'

/** 只有完整合法的 12 位商品编号才走精确查询；其它输入继续走普通关键词。 */
export function isListingNumberQuery(value: string): boolean {
  return ListingNoSchema.safeParse(value.trim()).success
}

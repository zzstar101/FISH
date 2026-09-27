import { eq } from 'drizzle-orm'
import type { Db } from '../client'
import { newListingNo } from '../listing-no'
import { listingNumbers } from '../schema/listing-numbers'

/** Test fixtures bypass the listing service, but must obey the production reservation invariant. */
export async function reserveTestListingNo(db: Db, listingId: string): Promise<bigint> {
  const existing = await db
    .select({ listingNo: listingNumbers.listingNo })
    .from(listingNumbers)
    .where(eq(listingNumbers.listingId, listingId))
    .limit(1)
  if (existing[0]) return existing[0].listingNo

  for (let i = 0; i < 16; i++) {
    const candidate = newListingNo()
    const inserted = await db
      .insert(listingNumbers)
      .values({ listingNo: candidate, listingId })
      .onConflictDoNothing({ target: listingNumbers.listingNo })
      .returning({ listingNo: listingNumbers.listingNo })
    if (inserted[0]) return inserted[0].listingNo
  }
  throw new Error('测试商品编号已耗尽重试次数')
}

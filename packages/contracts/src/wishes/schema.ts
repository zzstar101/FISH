import { z } from 'zod'
import { UserIdSchema, WishIdSchema } from '../system/public-id'

/** Wish Domain Contract（Issue #7）。前端和 API 只依赖本目录的字段定义。 */

export const wishStatusSchema = z.enum(['ACTIVE', 'CLOSED', 'FULFILLED'])
export type WishStatus = z.infer<typeof wishStatusSchema>

// 协调点⑤：与 packages/db 的 listing_category 枚举（listings 单一来源）逐值对齐；
// listings contract 落地后迁移为共享枚举引用，避免两处维护。
export const wishCategorySchema = z.enum([
  'DIGITAL',
  'BOOKS',
  'BEAUTY',
  'DAILY',
  'SPORTS',
  'APPAREL',
  'TRANSPORT',
  'OTHER',
])
export type WishCategory = z.infer<typeof wishCategorySchema>

const keywordSchema = z
  .string()
  .trim()
  .min(2, '关键词至少 2 个字符')
  .max(30, '关键词最多 30 个字符')
  .refine((keyword) => /[^\s\p{P}]/u.test(keyword), '关键词不能只有空白或标点')
  .transform((keyword) => keyword.toLowerCase())

const budgetMinSchema = z.number().int().nonnegative()
const budgetMaxSchema = z.number().int().positive()

export const wishCreateInputSchema = z
  .object({
    keyword: keywordSchema,
    category: wishCategorySchema,
    budgetMinCents: budgetMinSchema,
    budgetMaxCents: budgetMaxSchema,
    description: z.string().max(500).optional(),
    acceptSimilar: z.boolean().default(true),
  })
  .strict()
  .refine((wish) => wish.budgetMaxCents >= wish.budgetMinCents, {
    message: 'budgetMaxCents 必须 ≥ budgetMinCents',
    path: ['budgetMaxCents'],
  })
export type WishCreateInput = z.infer<typeof wishCreateInputSchema>

export const wishUpdateInputSchema = z
  .object({
    keyword: keywordSchema.optional(),
    category: wishCategorySchema.optional(),
    budgetMinCents: budgetMinSchema.optional(),
    budgetMaxCents: budgetMaxSchema.optional(),
    description: z.string().max(500).nullable().optional(),
    acceptSimilar: z.boolean().optional(),
  })
  .strict()
  .refine(
    (wish) =>
      wish.budgetMinCents === undefined ||
      wish.budgetMaxCents === undefined ||
      wish.budgetMaxCents >= wish.budgetMinCents,
    { message: 'budgetMaxCents 必须 ≥ budgetMinCents', path: ['budgetMaxCents'] },
  )
export type WishUpdateInput = z.infer<typeof wishUpdateInputSchema>

export const wishDtoSchema = z.object({
  id: WishIdSchema,
  userId: UserIdSchema,
  keyword: z.string(),
  category: wishCategorySchema,
  budgetMinCents: z.number().int(),
  budgetMaxCents: z.number().int(),
  description: z.string().nullable(),
  acceptSimilar: z.boolean(),
  status: wishStatusSchema,
  /** 匹配数，读取 matches 表实时计数（#8 产出匹配结果）。 */
  matchCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type WishDto = z.infer<typeof wishDtoSchema>

export const wishListQuerySchema = z.object({
  status: wishStatusSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(50).default(20),
})
export type WishListQuery = z.infer<typeof wishListQuerySchema>

export const wishListResponseSchema = z.object({
  items: z.array(wishDtoSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
})
export type WishListResponse = z.infer<typeof wishListResponseSchema>

export const wishPoolItemSchema = z.object({
  keyword: z.string(),
  category: wishCategorySchema,
  wantCount: z.number().int().nonnegative(),
  medianBudgetCents: z.number().int(),
})
export type WishPoolItem = z.infer<typeof wishPoolItemSchema>

export const wishPoolResponseSchema = z.object({ items: z.array(wishPoolItemSchema) })
export type WishPoolResponse = z.infer<typeof wishPoolResponseSchema>

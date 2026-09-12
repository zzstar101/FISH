import { z } from 'zod'

/**
 * Wish Domain Contract（Issue #7）。
 * 由 Wish Owner（Coast-87）维护；前端对接只依赖本目录，字段变更走 PR 反馈。
 */

export const wishStatusSchema = z.enum(['ACTIVE', 'CLOSED', 'FULFILLED'])
export type WishStatus = z.infer<typeof wishStatusSchema>

// 协调点⑤：listings contract 落地后迁移为共享分类枚举引用，避免两处维护。
export const wishCategorySchema = z.enum([
  'electronics',
  'books',
  'daily',
  'clothing',
  'sports',
  'beauty',
  'other',
])
export type WishCategory = z.infer<typeof wishCategorySchema>

const trimmedKeyword = z
  .string()
  .trim()
  .min(2)
  .max(30)
  .refine((k) => /[^\s\p{P}]/u.test(k), '关键词不能只有空白或标点')

const wishCreateInputObject = z.object({
  keyword: trimmedKeyword,
  category: wishCategorySchema,
  budgetMinCents: z.number().int().nonnegative(),
  budgetMaxCents: z.number().int().positive(),
  description: z.string().max(500).optional(),
  acceptSimilar: z.boolean().default(true),
})

export const wishCreateInputSchema = wishCreateInputObject.refine(
  (w) => w.budgetMaxCents >= w.budgetMinCents,
  { message: 'budgetMaxCents 必须 ≥ budgetMinCents' },
)
export type WishCreateInput = z.infer<typeof wishCreateInputSchema>

// 编辑全字段可选；strict 拒绝 status 等未声明字段，状态迁移只走 close/fulfill 端点。
export const wishUpdateInputSchema = wishCreateInputObject
  .extend({ acceptSimilar: z.boolean().optional() })
  .partial()
  .strict()
  .refine(
    (w) =>
      w.budgetMinCents === undefined ||
      w.budgetMaxCents === undefined ||
      w.budgetMaxCents >= w.budgetMinCents,
    { message: 'budgetMaxCents 必须 ≥ budgetMinCents' },
  )
export type WishUpdateInput = z.infer<typeof wishUpdateInputSchema>

export const wishDtoSchema = z.object({
  id: z.string(),
  userId: z.string(),
  keyword: z.string(),
  category: wishCategorySchema,
  budgetMinCents: z.number().int(),
  budgetMaxCents: z.number().int(),
  description: z.string().nullable(),
  acceptSimilar: z.boolean(),
  status: wishStatusSchema,
  /** P0 先固定 0，等匹配结果表（Dev A）就绪后接入，见 Issue #7 设计方案阶段 5。 */
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

export const wishPoolResponseSchema = z.object({
  items: z.array(wishPoolItemSchema),
})
export type WishPoolResponse = z.infer<typeof wishPoolResponseSchema>

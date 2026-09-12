import { describe, expect, test } from 'bun:test'
import {
  wishCreateInputSchema,
  wishDtoSchema,
  wishPoolResponseSchema,
  wishStatusSchema,
  wishUpdateInputSchema,
} from './schema'

const validCreate = {
  keyword: '机械键盘',
  category: 'electronics',
  budgetMinCents: 10000,
  budgetMaxCents: 20000,
} as const

describe('wishCreateInputSchema', () => {
  test('accepts a valid input and applies acceptSimilar default', () => {
    const parsed = wishCreateInputSchema.parse(validCreate)
    expect(parsed.acceptSimilar).toBe(true)
    expect(parsed.keyword).toBe('机械键盘')
  })

  test('trims keyword', () => {
    const parsed = wishCreateInputSchema.parse({ ...validCreate, keyword: '  机械键盘  ' })
    expect(parsed.keyword).toBe('机械键盘')
  })

  test('rejects a keyword shorter than 2 chars', () => {
    expect(wishCreateInputSchema.safeParse({ ...validCreate, keyword: '键' }).success).toBe(false)
  })

  test('rejects a keyword of only whitespace or punctuation', () => {
    expect(wishCreateInputSchema.safeParse({ ...validCreate, keyword: '!!!' }).success).toBe(false)
    expect(wishCreateInputSchema.safeParse({ ...validCreate, keyword: '   ' }).success).toBe(false)
  })

  test('rejects budgetMaxCents below budgetMinCents', () => {
    const input = { ...validCreate, budgetMinCents: 20000, budgetMaxCents: 10000 }
    expect(wishCreateInputSchema.safeParse(input).success).toBe(false)
  })

  test('rejects non-integer budgets', () => {
    expect(wishCreateInputSchema.safeParse({ ...validCreate, budgetMaxCents: 100.5 }).success).toBe(
      false,
    )
  })

  test('rejects an unknown category', () => {
    expect(wishCreateInputSchema.safeParse({ ...validCreate, category: 'vehicle' }).success).toBe(
      false,
    )
  })
})

describe('wishUpdateInputSchema', () => {
  test('accepts an empty patch', () => {
    expect(wishUpdateInputSchema.parse({})).toEqual({})
  })

  test('accepts partial fields', () => {
    const parsed = wishUpdateInputSchema.parse({ budgetMaxCents: 30000 })
    expect(parsed.budgetMaxCents).toBe(30000)
  })

  test('rejects a status field (not editable via update)', () => {
    const parsed = wishUpdateInputSchema.safeParse({ status: 'CLOSED' })
    expect(parsed.success).toBe(false)
  })
})

describe('wishStatusSchema', () => {
  test('rejects an unknown status', () => {
    expect(wishStatusSchema.safeParse('EXPIRED').success).toBe(false)
  })
})

describe('wishDtoSchema', () => {
  test('parses a full dto with nullable description and iso dates', () => {
    const dto = {
      id: '0d9c6f2a-1f3e-4a5b-8c7d-6e5f4a3b2c1d',
      userId: '9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d',
      keyword: '机械键盘',
      category: 'electronics',
      budgetMinCents: 10000,
      budgetMaxCents: 20000,
      description: null,
      acceptSimilar: true,
      status: 'ACTIVE',
      matchCount: 0,
      createdAt: '2026-09-12T03:40:10.000Z',
      updatedAt: '2026-09-12T03:40:10.000Z',
    }
    expect(wishDtoSchema.parse(dto).status).toBe('ACTIVE')
  })
})

describe('wishPoolResponseSchema', () => {
  test('parses aggregated pool items', () => {
    const body = {
      items: [
        { keyword: '机械键盘', category: 'electronics', wantCount: 7, medianBudgetCents: 20000 },
      ],
    }
    expect(wishPoolResponseSchema.parse(body).items[0]?.wantCount).toBe(7)
  })
})

import { describe, expect, test } from 'bun:test'
import { budgetLabel, formatWishBudgetCents } from './match-list'

describe('match budget label', () => {
  test('treats a zero lower bound as no lower bound, not as a free item', () => {
    expect(budgetLabel(0, 10_000)).toBe('≤ ¥100')
    expect(budgetLabel(0, null)).toBe('不限')
    expect(budgetLabel(0, 0)).toBe('¥0')
    expect(budgetLabel(10_000, 20_000)).toBe('¥100 ~ ¥200')
    expect(budgetLabel(null, 20_000)).toBe('≤ ¥200')
    expect(formatWishBudgetCents(0)).toBe('¥0')
  })
})

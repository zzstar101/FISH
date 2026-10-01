import { describe, expect, test } from 'bun:test'
import { initialAmountValue, proposalAmountCents, proposalAmountError } from './propose-model'

describe('initialAmountValue', () => {
  test('prefills the asking price with two decimals', () => {
    expect(initialAmountValue(2000, false)).toBe('20.00')
    expect(initialAmountValue(1999, false)).toBe('19.99')
  })

  test('free listings always start at 0', () => {
    expect(initialAmountValue(0, true)).toBe('0')
  })
})

describe('proposalAmountCents', () => {
  test('accepts integer and two-decimal amounts', () => {
    expect(proposalAmountCents('20', false)).toBe(2000)
    expect(proposalAmountCents('20.5', false)).toBe(2050)
    expect(proposalAmountCents('0', false)).toBe(0)
  })

  test('rejects malformed input instead of coercing it', () => {
    expect(proposalAmountCents('', false)).toBeNull()
    expect(proposalAmountCents('abc', false)).toBeNull()
    expect(proposalAmountCents('-1', false)).toBeNull()
    expect(proposalAmountCents('20.555', false)).toBeNull()
  })

  test('honours the contract price ceiling', () => {
    expect(proposalAmountCents('100000', false)).toBe(10_000_000)
    expect(proposalAmountCents('100000.01', false)).toBeNull()
  })

  test('free listings are pinned to 0 regardless of the input box', () => {
    expect(proposalAmountCents('999', true)).toBe(0)
  })
})

describe('proposalAmountError', () => {
  test('reports nothing for a usable amount', () => {
    expect(proposalAmountError('20', false)).toBeNull()
  })

  test('free listings cannot produce an amount error — the input is disabled', () => {
    expect(proposalAmountError('garbage', true)).toBeNull()
  })

  test('reports the field error for malformed input', () => {
    expect(proposalAmountError('20.555', false)).toBe('请填写正确金额（最多两位小数）')
  })
})

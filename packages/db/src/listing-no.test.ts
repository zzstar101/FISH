import { expect, test } from 'bun:test'
import { newListingNo } from './listing-no'

test('cryptographic listing references remain twelve decimal digits with nonzero leading digit', () => {
  const values = Array.from({ length: 50 }, newListingNo)
  for (const value of values) expect(value.toString()).toMatch(/^[1-9][0-9]{11}$/)
})

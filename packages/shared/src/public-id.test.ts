import { describe, expect, test } from 'bun:test'
import { decodePublicId, encodePublicId, isPublicId, PUBLIC_ID_PREFIX } from './public-id'

const uuid = '01930000-0000-7000-8000-000000000011'

describe('Public ID / UUIDv7 boundary', () => {
  test('deterministic TypeID round-trip and strict resource prefix', () => {
    const listing = encodePublicId(PUBLIC_ID_PREFIX.listing, uuid)
    expect(listing).toMatch(/^lst_[0-7][0-9a-hjkmnp-tv-z]{25}$/)
    expect(encodePublicId(PUBLIC_ID_PREFIX.listing, uuid)).toBe(listing)
    expect(decodePublicId(PUBLIC_ID_PREFIX.listing, listing)).toBe(uuid)
    expect(isPublicId(PUBLIC_ID_PREFIX.listing, listing)).toBe(true)
    expect(isPublicId(PUBLIC_ID_PREFIX.user, listing)).toBe(false)
    expect(() => decodePublicId(PUBLIC_ID_PREFIX.user, listing)).toThrow()
  })

  test('rejects malformed, non-canonical and non-v7 encodings', () => {
    const id = encodePublicId(PUBLIC_ID_PREFIX.listing, uuid)
    for (const malformed of [
      uuid,
      id.toUpperCase(),
      id.replace('lst_', 'lst_8'),
      id.replace('lst_', 'lst_i'),
      `lst_${id.slice(4)}x`,
      `lst_${'0'.repeat(26)}`,
    ]) {
      expect(isPublicId(PUBLIC_ID_PREFIX.listing, malformed)).toBe(false)
      expect(() => decodePublicId(PUBLIC_ID_PREFIX.listing, malformed)).toThrow()
    }
    expect(() =>
      encodePublicId(PUBLIC_ID_PREFIX.listing, '00000000-0000-4000-8000-000000000001'),
    ).toThrow()
  })
})

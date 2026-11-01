import { describe, expect, test } from 'bun:test'
import { fromUUID, TypeID } from 'typeid-js'
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

  // #406 第 4 项：本地 seed / 手写演示数据用了 v4 或非规范 UUID 时，服务端只回 500
  // INTERNAL_ERROR；日志里必须能直接看出是哪一个值违约，否则只能从 500 反推。
  test('非规范 UUIDv7 的报错带上出错的值（#406 第 4 项）', () => {
    const v4 = '00000000-0000-4000-8000-000000000001'
    expect(() => encodePublicId(PUBLIC_ID_PREFIX.listing, v4)).toThrow(v4)
    expect(() => encodePublicId(PUBLIC_ID_PREFIX.listing, v4)).toThrow('UUIDv7')
  })

  // 微信小程序真机 JS 运行时没有 `TextEncoder` 全局（开发者工具模拟器有）。typeid-js 的
  // `fromString` 解码依赖它，真机上每个 Public ID 校验都失败，登录响应的 `usr_` 也过不了契约。
  test('没有 TextEncoder 全局时仍能解码与校验（小程序真机）', () => {
    const expected = encodePublicId(PUBLIC_ID_PREFIX.user, uuid)
    const original = globalThis.TextEncoder
    Reflect.deleteProperty(globalThis, 'TextEncoder')
    try {
      expect(typeof globalThis.TextEncoder).toBe('undefined')
      const id = encodePublicId(PUBLIC_ID_PREFIX.user, uuid)
      expect(id).toBe(expected)
      expect(decodePublicId(PUBLIC_ID_PREFIX.user, id)).toBe(uuid)
      expect(isPublicId(PUBLIC_ID_PREFIX.user, id)).toBe(true)
      // 等长变异才会走到自写的后缀解码：首位溢出 128 bit、非法字符、非 v7 版本位
      expect(isPublicId(PUBLIC_ID_PREFIX.user, `usr_8${id.slice(5)}`)).toBe(false)
      expect(isPublicId(PUBLIC_ID_PREFIX.user, `usr_${id.slice(4, 29)}u`)).toBe(false)
      const v4 = fromUUID('01930000-0000-4000-8000-000000000011', PUBLIC_ID_PREFIX.user)
      expect(v4).toHaveLength(id.length)
      expect(isPublicId(PUBLIC_ID_PREFIX.user, v4)).toBe(false)
    } finally {
      Object.defineProperty(globalThis, 'TextEncoder', {
        value: original,
        writable: true,
        configurable: true,
        enumerable: false,
      })
    }
  })

  test('自实现的后缀解码与 typeid-js 逐值一致', () => {
    for (let i = 0; i < 500; i += 1) {
      const v7 = Bun.randomUUIDv7()
      const id = encodePublicId(PUBLIC_ID_PREFIX.message, v7)
      expect(decodePublicId(PUBLIC_ID_PREFIX.message, id)).toBe(v7)
      expect(TypeID.fromString(id, PUBLIC_ID_PREFIX.message).toUUID()).toBe(v7)
    }
  })
})

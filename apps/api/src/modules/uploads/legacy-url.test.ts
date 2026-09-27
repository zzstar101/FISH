import { expect, test } from 'bun:test'
import { legacyMediaKey, legacyMediaToken } from './legacy-url'

const key =
  'listings/01930000-0000-4000-8000-000000000001/01930000-0000-4000-8000-000000000002.webp'
const secret = 'a-secret-for-test-purposes-longer-than-32-characters'

test('旧对象键可稳定封装为不暴露 UUID 的 URL token，密钥或 token 不匹配时拒绝', () => {
  const token = legacyMediaToken(key, secret)
  expect(token).toBe(legacyMediaToken(key, secret))
  expect(token).not.toContain('01930000')
  expect(legacyMediaKey(token, secret)).toBe(key)
  expect(legacyMediaKey(token, `${secret}wrong`)).toBeNull()
  expect(legacyMediaKey(`${token.slice(0, -1)}!`, secret)).toBeNull()
  expect(legacyMediaKey(Buffer.from(key).toString('base64url'), secret)).toBeNull()
})

test('只能封装历史 listings 图片，不能签任意对象或路径遍历', () => {
  expect(() => legacyMediaToken('chat-media-final/secret.jpg', secret)).toThrow()
  expect(() => legacyMediaToken(`listings/../${key}`, secret)).toThrow()
})

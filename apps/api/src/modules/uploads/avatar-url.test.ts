import { expect, test } from 'bun:test'
import { publicAvatarUrl } from './avatar-url'
import { legacyMediaKey } from './legacy-url'

const secret = 'test-secret-for-old-avatars'
const config = {
  s3PublicUrl: 'https://storage.example/fish',
  webOrigin: 'https://fish.example',
  secret,
}
const key = 'listings/11111111-1111-4111-8111-111111111111/old.webp'

test('historical avatar is proxied without disclosing the UUID and remains readable by the legacy decoder', () => {
  const url = publicAvatarUrl(`${config.s3PublicUrl}/${key}`, config)
  expect(url).toMatch(/^https:\/\/fish\.example\/api\/uploads\/legacy\//)
  expect(url).not.toContain('11111111-1111-4111-8111-111111111111')
  expect(legacyMediaKey(url?.split('/').at(-1) ?? '', secret)).toBe(key)
})

test('untrusted or unrecognized UUID-bearing avatar URLs fail closed without leaking IDs', () => {
  expect(publicAvatarUrl(`https://attacker.example/${key}`, config)).toBeNull()
  expect(publicAvatarUrl(`${config.s3PublicUrl}/${key}?id=1`, config)).toBeNull()
  expect(
    publicAvatarUrl(`${config.s3PublicUrl}/${key}`, { ...config, secret: undefined }),
  ).toBeNull()
  expect(publicAvatarUrl('https://cdn.example/avatar.png', config)).toBe(
    'https://cdn.example/avatar.png',
  )
  expect(publicAvatarUrl('not-a-url', config)).toBeNull()
})

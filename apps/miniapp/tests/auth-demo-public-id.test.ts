import { expect, test } from 'bun:test'
import { MeSchema } from '@fish/contracts/auth/user'

Object.assign(globalThis, { __DEMO_AUTH__: true })
const { DEMO_USER } = await import('../src/features/auth/demo')

test('演示登录态使用与真实 /me 相同的公开用户 ID 契约', () => {
  expect(MeSchema.safeParse(DEMO_USER).success).toBe(true)
})

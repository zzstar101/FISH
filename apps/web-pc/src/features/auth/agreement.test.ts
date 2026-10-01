import { expect, test } from 'bun:test'
import { INITIAL_LOGIN_AGREEMENT_ACCEPTED } from './agreement'

test('登录页不默认替用户勾选同意协议', () => {
  expect(INITIAL_LOGIN_AGREEMENT_ACCEPTED).toBe(false)
})

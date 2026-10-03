import { describe, expect, test } from 'bun:test'
import { CURRENT_USER_ID } from '@/lib/demo-user-id'
import { ME, USER_BY_ID, USERS } from '@/mock/users'

/**
 * `CURRENT_USER_ID`（`src/lib/demo-user-id.ts`）与 mock fixture 里的「我」必须指向同一个人。
 *
 * 这条等式**不是**靠 re-export 保证的：`ME = getUser(CURRENT_USER_ID)`，而 `getUser` 对
 * 未知 id 会回退到 `USERS[0]`（`src/mock/users.ts`），所以把 `'u-alan'` 从 `USERS` 里删掉
 * 时 `ME.id` 会静默变成另一个演示用户，而 `CURRENT_USER_ID` 还是 `'u-alan'`。
 * 那种漂移会让详情页的归属判断（`pkg-browse/pages/listing-detail/index.tsx` 的
 * `ownerViewUserId`）把别人的商品当成「我的」，且没有任何报错。
 */
describe('演示身份常量 CURRENT_USER_ID 与 fixture 一致', () => {
  test('CURRENT_USER_ID 能解析到 ME，且不是 getUser 的 USERS[0] 兜底', () => {
    expect(USER_BY_ID[CURRENT_USER_ID]).toBeDefined()
    expect(USERS.some((user) => user.id === CURRENT_USER_ID)).toBe(true)
    expect(ME.id).toBe(CURRENT_USER_ID)
  })
})

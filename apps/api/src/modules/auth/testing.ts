import type { AccountDeletionState } from '@fish/contracts/account-deletion/schema'
import type { Db } from '@fish/db/client'
import { users } from '@fish/db/schema/users'
import { createSessions } from './session'

let serial = 0

export interface TestUserOptions {
  nickname?: string
  role?: 'USER' | 'ADMIN'
  authStatus?: 'UNVERIFIED' | 'VERIFIED'
  accountStatus?: AccountDeletionState
}

export interface TestUserSession {
  userId: string
  uid: string
  nickname: string
  /** 可直接放进请求头的 `fish_session=...`。 */
  cookie: string
}

/**
 * 测试专用：直接落 `users` 行并签发一条会话，返回可用 cookie（#703）。
 *
 * 注册 / 密码登录随凭据列一起下线，测试不再能走 `POST /auth/register` 造登录态；
 * 这里用与生产相同的两条写入（users + sessions）重建同一效果，且不依赖微信上游。
 */
export async function createTestUser(
  db: Db,
  options: TestUserOptions = {},
): Promise<TestUserSession> {
  serial += 1
  const nickname = options.nickname ?? `测试用户${serial}`
  const inserted = await db
    .insert(users)
    .values({
      nickname,
      role: options.role ?? 'USER',
      authStatus: options.authStatus ?? 'UNVERIFIED',
      ...(options.authStatus === 'VERIFIED' ? { verifiedAt: new Date() } : {}),
      ...(options.accountStatus === undefined ? {} : { accountStatus: options.accountStatus }),
    })
    .returning({ id: users.id, uid: users.uid, nickname: users.nickname })
  const row = inserted[0]
  if (!row) throw new Error('INSERT users 未返回行')
  const { token } = await createSessions(db).create(row.id)
  return {
    userId: row.id,
    uid: row.uid,
    nickname: row.nickname,
    cookie: `fish_session=${token}`,
  }
}

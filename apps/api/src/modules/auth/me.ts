import type { Me } from '@fish/contracts/auth/user'
import type { users } from '@fish/db/schema/users'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { publicAvatarUrl } from '../uploads/avatar-url'

export type UserRow = typeof users.$inferSelect

/** `199****5678` 之外不再有第二种手机号脱敏；实现冻结在契约里（`auth/phone.ts`）。 */
export function maskPhone(phone: string): string {
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`
}

/**
 * DB 行 → 对外 DTO。`student_no` 与 `password_hash` 永不经过这里（#3：不公开完整学号）。
 *
 * `avatarUrl` 在库里是无约束 `text`，契约声明它是 `z.url()`；
 * 值域外的历史值一律降级为 `null`，否则前端按 `MeSchema` 解析 `/me` 会直接抛错、登录态全挂。
 * 手机号只出派生态 `phoneBound` / `maskedPhone`，明文不出服务端（#86 C 节）。
 */
export function toMe(row: UserRow): Me {
  return {
    id: encodePublicId(PUBLIC_ID_PREFIX.user, row.id),
    nickname: row.nickname,
    avatarUrl: publicAvatarUrl(row.avatarUrl),
    authStatus: row.authStatus,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    phoneBound: row.phone !== null,
    maskedPhone: row.phone ? maskPhone(row.phone) : null,
  }
}

import { AVATARS } from './images'
import type { MockUser } from './types'

/**
 * 用户 fixture。昵称 / 校区沿用仓库 seed 的演示账号：
 * 202101000001 阿岚（肇庆 / VERIFIED）、202101000002 小北（肇庆 / UNVERIFIED）、
 * 202101000003 橙子（广州 / VERIFIED）。
 *
 * `CURRENT_USER_ID` 是「我」——设计稿视角下我是卖家（详情页有卖家卡片、
 * 消息页有买家来问），因此当前用户取阿岚。
 */
export const CURRENT_USER_ID = 'u-alan'

export const USERS: MockUser[] = [
  {
    id: 'u-alan',
    nickname: '阿岚',
    avatarUrl: AVATARS[0] ?? '',
    campus: '肇庆',
    authStatus: 'VERIFIED',
    soldCount: 9,
    goodRate: 100,
  },
  {
    id: 'u-xiaobei',
    nickname: '小北',
    avatarUrl: AVATARS[1] ?? '',
    campus: '肇庆',
    authStatus: 'UNVERIFIED',
    soldCount: 3,
    goodRate: 98,
  },
  {
    id: 'u-chengzi',
    nickname: '橙子',
    avatarUrl: AVATARS[2] ?? '',
    campus: '广州',
    authStatus: 'VERIFIED',
    soldCount: 21,
    goodRate: 99,
  },
  {
    id: 'u-susu',
    nickname: '苏苏',
    avatarUrl: AVATARS[3] ?? '',
    campus: '肇庆',
    authStatus: 'VERIFIED',
    soldCount: 5,
    goodRate: 100,
  },
  {
    id: 'u-linyi',
    nickname: '林一',
    avatarUrl: AVATARS[4] ?? '',
    campus: '肇庆',
    authStatus: 'UNVERIFIED',
    soldCount: 1,
    goodRate: 100,
  },
  {
    id: 'u-soda',
    nickname: '苏打水',
    avatarUrl: AVATARS[5] ?? '',
    campus: '肇庆',
    authStatus: 'VERIFIED',
    soldCount: 7,
    goodRate: 97,
  },
  {
    id: 'u-qiqi',
    nickname: '琪琪',
    avatarUrl: AVATARS[6] ?? '',
    campus: '广州',
    authStatus: 'VERIFIED',
    soldCount: 12,
    goodRate: 100,
  },
  {
    id: 'u-zhou',
    nickname: '老周',
    avatarUrl: AVATARS[7] ?? '',
    campus: '肇庆',
    authStatus: 'UNVERIFIED',
    soldCount: 4,
    goodRate: 96,
  },
]

export const USER_BY_ID: Record<string, MockUser> = Object.fromEntries(
  USERS.map((user) => [user.id, user]),
)

export function getUser(id: string): MockUser {
  const found = USER_BY_ID[id]
  if (found) return found
  const fallback = USERS[0]
  if (!fallback) throw new Error('USERS 为空：mock 数据未初始化')
  return fallback
}

export const ME = getUser(CURRENT_USER_ID)

export function isMe(userId: string): boolean {
  return userId === CURRENT_USER_ID
}

/** 校园认证徽章：认证徽章只在 VERIFIED 时展示（与契约 authStatus 判据一致） */
export function isVerified(userId: string): boolean {
  return getUser(userId).authStatus === 'VERIFIED'
}

/** 校区显示文案：设计稿详情页写「肇庆校区」 */
export function campusLabel(userId: string): string {
  return `${getUser(userId).campus}校区`
}

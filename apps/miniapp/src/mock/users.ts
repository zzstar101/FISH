import { AVATARS } from './images'
import type { MockUser } from './types'

/**
 * 用户 fixture。昵称沿用仓库 seed 的演示账号：
 * 202101000001 阿岚（VERIFIED）、202101000002 小北（UNVERIFIED）、
 * 202101000003 橙子（VERIFIED）。
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
    authStatus: 'VERIFIED',
    soldCount: 9,
    goodRate: 100,
  },
  {
    id: 'u-xiaobei',
    nickname: '小北',
    avatarUrl: AVATARS[1] ?? '',
    authStatus: 'UNVERIFIED',
    soldCount: 3,
    goodRate: 98,
  },
  {
    id: 'u-chengzi',
    nickname: '橙子',
    avatarUrl: AVATARS[2] ?? '',
    authStatus: 'VERIFIED',
    soldCount: 21,
    goodRate: 99,
  },
  {
    id: 'u-susu',
    nickname: '苏苏',
    avatarUrl: AVATARS[3] ?? '',
    authStatus: 'VERIFIED',
    soldCount: 5,
    goodRate: 100,
  },
  {
    id: 'u-linyi',
    nickname: '林一',
    avatarUrl: AVATARS[4] ?? '',
    authStatus: 'UNVERIFIED',
    soldCount: 1,
    goodRate: 100,
  },
  {
    id: 'u-soda',
    nickname: '苏打水',
    avatarUrl: AVATARS[5] ?? '',
    authStatus: 'VERIFIED',
    soldCount: 7,
    goodRate: 97,
  },
  {
    id: 'u-qiqi',
    nickname: '琪琪',
    avatarUrl: AVATARS[6] ?? '',
    authStatus: 'VERIFIED',
    soldCount: 12,
    goodRate: 100,
  },
  {
    id: 'u-zhou',
    nickname: '老周',
    avatarUrl: AVATARS[7] ?? '',
    authStatus: 'UNVERIFIED',
    soldCount: 4,
    goodRate: 96,
  },

  /* ---- A/B/C/D 组 14 张设计稿里反复出现的人物 ----
     设计稿自述「示例数据为占位，非真实账号」，这些是稿件的占位人物；
     登记成 fixture 是为了让新页面上的头像首字 / 昵称与稿子一致。
     AVATARS 只有 8 张，超出的取模复用。 */
  {
    id: 'u-lin',
    nickname: '林知遥',
    avatarUrl: AVATARS[8 % AVATARS.length] ?? '',
    authStatus: 'VERIFIED',
    soldCount: 27,
    goodRate: 98,
  },
  {
    id: 'u-zhouyan',
    nickname: '周予安',
    avatarUrl: AVATARS[9 % AVATARS.length] ?? '',
    authStatus: 'VERIFIED',
    soldCount: 15,
    goodRate: 99,
  },
  {
    id: 'u-zhangyu',
    nickname: '张屿',
    avatarUrl: AVATARS[10 % AVATARS.length] ?? '',
    authStatus: 'VERIFIED',
    soldCount: 8,
    goodRate: 100,
  },
  {
    id: 'u-suyiran',
    nickname: '苏亦然',
    avatarUrl: AVATARS[11 % AVATARS.length] ?? '',
    authStatus: 'VERIFIED',
    soldCount: 12,
    goodRate: 97,
  },
  {
    id: 'u-xuche',
    nickname: '许澈',
    avatarUrl: AVATARS[12 % AVATARS.length] ?? '',
    authStatus: 'UNVERIFIED',
    soldCount: 2,
    goodRate: 100,
  },
  {
    id: 'u-hexu',
    nickname: '何叙',
    avatarUrl: AVATARS[13 % AVATARS.length] ?? '',
    authStatus: 'VERIFIED',
    soldCount: 6,
    goodRate: 98,
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

/**
 * 查得到就返回，查不到返回 `null`。
 *
 * 与 `getUser` 的区别是**不兜底**。为什么必须另有一个：
 * `getUser` 对未知 id 会回退到 `USERS[0]`（这是一个真实存在的演示用户，还带认证勾），
 * 用于 mock 演示没问题；但真实接口的列表卡**没有卖家字段**
 * （见 `features/listing/adapt.ts` 的铁律 2，那里的 `sellerId` 是空串 `NO_SELLER`），
 * 一旦把空串喂给 `getUser`，卡片上就会出现一个**完全捏造的卖家**。
 * 所以凡是要把「卖家可能不存在」这个事实表达出来的调用方，一律用这个函数。
 */
export function findUser(id: string): MockUser | null {
  if (!id) return null
  return USER_BY_ID[id] ?? null
}

export const ME = getUser(CURRENT_USER_ID)

export function isMe(userId: string): boolean {
  return userId === CURRENT_USER_ID
}

/** 校园认证徽章：认证徽章只在 VERIFIED 时展示（与契约 authStatus 判据一致） */
export function isVerified(userId: string): boolean {
  return getUser(userId).authStatus === 'VERIFIED'
}

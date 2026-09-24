/**
 * 「我的关注」的演示数据（**只在演示构建里用**，见 `./load.ts`）。
 *
 * 数据照设计稿 `小程序1版following.html` 的 5 条，**条数必须与「我的」页数字栏对得上**：
 * `features/fetchers.ts` 的 `demoProfile()` 给 `followCount: 5`，本文件就是那 5 个人。
 * 不这么做的话演示时会出现「数字栏 5、点进去 3 人」这种自相矛盾（方案 §2.3）。
 *
 * 行内字段只有**稿里画出来的三样**：昵称 / 个性签名 / 最近活跃，外加头像色块与认证勾。
 * **刻意不含校区与院系** —— 与「想要的人」（`pages/watchers`）同一隐私口径
 * （Issue #123：公开字段不泄漏私有校园身份）。
 *
 * 头像是 `src/mock/blocks.ts` 的 `AVATAR_BLOCKS`（1×1 PNG 的 data URI，由设计令牌生成），
 * 色值下标与稿里的 `--av-2 / --av-1 / --av-4 / --av-3 / --av-5` 一一对应。
 */
import { AVATAR_BLOCKS } from '@/mock/blocks'

/** 关注列表里的一行（演示态；真实数据到位后应由契约投影，字段名不承诺稳定） */
export type FollowingPerson = {
  id: string
  nickname: string
  /**
   * 演示用的**占位色块**（data URI），不是真头像。
   *
   * 刻意不叫 `avatarUrl`：契约的真实头像字段（`PublicUserProfileSchema.avatarUrl`）
   * 到位后要**新加一个字段**，而不是复用这个 —— 因为两者的渲染规则不同：
   * 占位色块要垫在首字下面（稿的「色圈 + 首字」是两层），真头像要独占，
   * 首字不能再压上去。字段名分开，接端点的人就必须显式决定这件事。
   */
  placeholderBlock: string
  /** 已认证：行内渲染认证勾，未认证整块不占位 */
  verified: boolean
  /** 个性签名（稿里单行省略；真实口径只展示首行） */
  bio: string
  /** 最近活跃（演示文案） */
  seenLabel: string
  /** 互相关注（双向关系）；`false` = 单向「已关注」——两态必须区分（稿决策④） */
  mutual: boolean
}

/** 头像色块：越界时给空串（页面按「没有图」走首字兜底），不编一个颜色 */
function block(index: number): string {
  return AVATAR_BLOCKS[index] ?? ''
}

export const FOLLOW_DEMO: FollowingPerson[] = [
  {
    id: 'P01',
    nickname: '周予安',
    placeholderBlock: block(1),
    verified: true,
    bio: '收书收耳机，价格好商量',
    seenLabel: '13 分钟前来过鱼小应',
    mutual: true,
  },
  {
    id: 'P02',
    nickname: '林知遥',
    placeholderBlock: block(0),
    verified: true,
    bio: '数码控，常年出闲置，支持校内面交',
    seenLabel: '2 小时前来过鱼小应',
    mutual: false,
  },
  {
    id: 'P03',
    nickname: '苏亦然',
    placeholderBlock: block(3),
    verified: true,
    bio: '相机玩家，出闲置回血',
    seenLabel: '7 小时前来过鱼小应',
    mutual: true,
  },
  {
    id: 'P04',
    nickname: '张屿',
    placeholderBlock: block(2),
    verified: true,
    bio: '考研上岸了，参考书全套出',
    seenLabel: '昨天来过鱼小应',
    mutual: false,
  },
  {
    id: 'P05',
    nickname: '许澈',
    placeholderBlock: block(4),
    verified: false,
    bio: '囤积癖晚期，正在清仓',
    seenLabel: '3 天前来过鱼小应',
    mutual: false,
  },
]

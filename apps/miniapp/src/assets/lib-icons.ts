/**
 * 图标资产出口（唯一入口）。
 *
 * 来源：`D:\index\组件库\SVG图标库`（380 个 24×24 **填充式**矢量图标）
 * 由 `D:\FISH\miniprogram\tools\build-lib-icons.mjs` 光栅化成 PNG，
 * 再按需拷进 `src/assets/lib-icons/`。真源与生成器在 miniprogram（不进包）。
 *
 * 约定：页面与组件**只从这里取图标**，不要直接 import 具体 png。
 * 换图标 = 改生成器的映射表 + 重新生成，业务代码零改动。
 *
 * ⚠️ 这里**只导入当前实际用到的图标**（44 个）。
 * 需要新图标时：在 `build-lib-icons.mjs` 的映射表里确认条目 →
 * 运行 `node tools/build-lib-icons.mjs` → 把 PNG 拷进本目录 → 在此加一行 import。
 * 不要为了「以后可能用得上」预先全量导入。
 */
import backInk from '@/assets/lib-icons/back-ink@3x.png'
import bellInk from '@/assets/lib-icons/bell-ink@3x.png'
import book from '@/assets/lib-icons/book@3x.png'
import camera from '@/assets/lib-icons/camera@3x.png'
import catApparel from '@/assets/lib-icons/cat-apparel@3x.png'
import catBeauty from '@/assets/lib-icons/cat-beauty@3x.png'
import catBooks from '@/assets/lib-icons/cat-books@3x.png'
import catDaily from '@/assets/lib-icons/cat-daily@3x.png'
import catDigital from '@/assets/lib-icons/cat-digital@3x.png'
import catOther from '@/assets/lib-icons/cat-other@3x.png'
import catSports from '@/assets/lib-icons/cat-sports@3x.png'
import catTransport from '@/assets/lib-icons/cat-transport@3x.png'
import category from '@/assets/lib-icons/category@3x.png'
import checkMuted from '@/assets/lib-icons/check-muted@3x.png'
import chevronDownMuted from '@/assets/lib-icons/chevron-down-muted@3x.png'
import chevronRightMuted from '@/assets/lib-icons/chevron-right-muted-solid@3x.png'
import chevronUpMuted from '@/assets/lib-icons/chevron-up-muted@3x.png'
import closeInk from '@/assets/lib-icons/close-ink-solid@3x.png'
import commentMuted from '@/assets/lib-icons/comment-muted@3x.png'
import deleteIcon from '@/assets/lib-icons/delete@3x.png'
import heartMuted from '@/assets/lib-icons/heart-muted@3x.png'
import heartOn from '@/assets/lib-icons/heart-on@3x.png'
import historyMuted from '@/assets/lib-icons/history-muted@3x.png'
import moreInk from '@/assets/lib-icons/more-ink@3x.png'
import order from '@/assets/lib-icons/order@3x.png'
import orderMuted from '@/assets/lib-icons/order-muted@3x.png'
import plus from '@/assets/lib-icons/plus@3x.png'
import plusInk from '@/assets/lib-icons/plus-ink@3x.png'
import rank from '@/assets/lib-icons/rank@3x.png'
import safeAccent from '@/assets/lib-icons/safe-accent@3x.png'
import search from '@/assets/lib-icons/search@3x.png'
import send from '@/assets/lib-icons/send@3x.png'
import settingsMuted from '@/assets/lib-icons/settings-muted@3x.png'
import share from '@/assets/lib-icons/share@3x.png'
import starLine from '@/assets/lib-icons/star-line@3x.png'
import tabHome from '@/assets/lib-icons/tab-home@3x.png'
import tabHomeOn from '@/assets/lib-icons/tab-home-on@3x.png'
import tabMessage from '@/assets/lib-icons/tab-message@3x.png'
import tabMessageOn from '@/assets/lib-icons/tab-message-on@3x.png'
import tabProfile from '@/assets/lib-icons/tab-profile@3x.png'
import tabProfileOn from '@/assets/lib-icons/tab-profile-on@3x.png'
import tabWish from '@/assets/lib-icons/tab-wish@3x.png'
import tabWishOn from '@/assets/lib-icons/tab-wish-on@3x.png'
import verifiedAccent from '@/assets/lib-icons/verified-accent@3x.png'

export const ICONS = {
  /* TabBar（未选中灰 / 选中品牌蓝） */
  tabHome,
  tabHomeOn,
  tabWish,
  tabWishOn,
  tabMessage,
  tabMessageOn,
  tabProfile,
  tabProfileOn,

  /* 导航与操作 */
  backInk,
  search,
  closeInk,
  moreInk,
  plus,
  plusInk,
  chevronRightMuted,
  chevronDownMuted,
  chevronUpMuted,
  checkMuted,
  delete: deleteIcon,

  /* 内容与状态 */
  bellInk,
  camera,
  category,
  book,
  share,
  starLine,
  commentMuted,
  heartMuted,
  heartOn,
  historyMuted,
  order,
  orderMuted,
  settingsMuted,
  send,
  rank,
  safeAccent,
  verifiedAccent,

  /* 商品一级分类（首页横滑圆盘） */
  catBooks,
  catDigital,
  catDaily,
  catApparel,
  catSports,
  catTransport,
  catBeauty,
  catOther,
} as const

export type IconName = keyof typeof ICONS

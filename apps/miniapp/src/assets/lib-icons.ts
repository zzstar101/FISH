/**
 * 图标资产出口（唯一入口）。
 *
 * 来源分两处，页面不需要关心区别：
 * 1. `D:\index\组件库\SVG图标库`（380 个 24×24 **填充式**矢量图标）
 *    → `D:\FISH\miniprogram\tools\build-lib-icons.mjs` 直接光栅化成 PNG。
 *    等价于「切图 + 去白底」，但边缘是解析式抗锯齿、任意倍率都清晰，也不会把分割线抠进来。
 * 2. 设计稿自身抽出的几何（`build-icons.mjs`）：库内没有等价图形的少数几个，
 *    例如「更多」在库里是毛绒玩具而不是省略号、返回/上下箭头库里没有。
 *    这些以 `-ink` / `-accent` / `-muted` 后缀命名，同时说明了来源。
 *
 * 约定：页面与组件**只从这里取图标**，不要直接 import 具体 png。
 * 换图标 = 改工具的映射表 + 重新生成，业务代码零改动。
 *
 * 文件位置：包内副本在 `src/assets/lib-icons/`；真源与生成器在 `D:\FISH\miniprogram`（不进包）。
 */
import backInk from '@/assets/lib-icons/back-ink@3x.png'
import bellInk from '@/assets/lib-icons/bell-ink@3x.png'
import book from '@/assets/lib-icons/book@3x.png'
import browse from '@/assets/lib-icons/browse@3x.png'
import browseMuted from '@/assets/lib-icons/browse-muted@3x.png'
import camera from '@/assets/lib-icons/camera@3x.png'
import cart from '@/assets/lib-icons/cart@3x.png'
import catApparel from '@/assets/lib-icons/cat-apparel@3x.png'
import catBeauty from '@/assets/lib-icons/cat-beauty@3x.png'
import catBooks from '@/assets/lib-icons/cat-books@3x.png'
import catDaily from '@/assets/lib-icons/cat-daily@3x.png'
import catDigital from '@/assets/lib-icons/cat-digital@3x.png'
import catOther from '@/assets/lib-icons/cat-other@3x.png'
import catSports from '@/assets/lib-icons/cat-sports@3x.png'
import catTransport from '@/assets/lib-icons/cat-transport@3x.png'
import category from '@/assets/lib-icons/category@3x.png'
import chat from '@/assets/lib-icons/chat@3x.png'
import chatWhite from '@/assets/lib-icons/chat-white@3x.png'
import checkMuted from '@/assets/lib-icons/check-muted@3x.png'
import chevronDownInk from '@/assets/lib-icons/chevron-down-ink@3x.png'
import chevronDownMuted from '@/assets/lib-icons/chevron-down-muted@3x.png'
import chevronRightAccent from '@/assets/lib-icons/chevron-right-accent@3x.png'
import chevronRightMuted from '@/assets/lib-icons/chevron-right-muted-solid@3x.png'
import chevronUpAccent from '@/assets/lib-icons/chevron-up-accent@3x.png'
import chevronUpMuted from '@/assets/lib-icons/chevron-up-muted@3x.png'
import clock from '@/assets/lib-icons/clock@3x.png'
import closeInk from '@/assets/lib-icons/close-ink-solid@3x.png'
import comment from '@/assets/lib-icons/comment@3x.png'
import commentMuted from '@/assets/lib-icons/comment-muted@3x.png'
import coupon from '@/assets/lib-icons/coupon@3x.png'
import credit from '@/assets/lib-icons/credit@3x.png'
import deleteIcon from '@/assets/lib-icons/delete@3x.png'
import doc from '@/assets/lib-icons/doc@3x.png'
import docMuted from '@/assets/lib-icons/doc-muted@3x.png'
import editImage from '@/assets/lib-icons/edit-image@3x.png'
import gift from '@/assets/lib-icons/gift@3x.png'
import heart from '@/assets/lib-icons/heart@3x.png'
import heartMuted from '@/assets/lib-icons/heart-muted@3x.png'
import heartOn from '@/assets/lib-icons/heart-on@3x.png'
import heartWhite from '@/assets/lib-icons/heart-white@3x.png'
import history from '@/assets/lib-icons/history@3x.png'
import historyMuted from '@/assets/lib-icons/history-muted@3x.png'
import hot from '@/assets/lib-icons/hot@3x.png'
import image from '@/assets/lib-icons/image@3x.png'
import imageMuted from '@/assets/lib-icons/image-muted@3x.png'
import location from '@/assets/lib-icons/location@3x.png'
import locationPin from '@/assets/lib-icons/location-pin@3x.png'
import moreInk from '@/assets/lib-icons/more-ink@3x.png'
import order from '@/assets/lib-icons/order@3x.png'
import orderMuted from '@/assets/lib-icons/order-muted@3x.png'
import plus from '@/assets/lib-icons/plus@3x.png'
import plusAccent from '@/assets/lib-icons/plus-accent@3x.png'
import plusInk from '@/assets/lib-icons/plus-ink@3x.png'
import rank from '@/assets/lib-icons/rank@3x.png'
import safe from '@/assets/lib-icons/safe@3x.png'
import safeAccent from '@/assets/lib-icons/safe-accent@3x.png'
import scan from '@/assets/lib-icons/scan@3x.png'
import search from '@/assets/lib-icons/search@3x.png'
import send from '@/assets/lib-icons/send@3x.png'
import settings from '@/assets/lib-icons/settings@3x.png'
import settingsMuted from '@/assets/lib-icons/settings-muted@3x.png'
import share from '@/assets/lib-icons/share@3x.png'
import starLine from '@/assets/lib-icons/star-line@3x.png'
import study from '@/assets/lib-icons/study@3x.png'
import tabHome from '@/assets/lib-icons/tab-home@3x.png'
import tabHomeOn from '@/assets/lib-icons/tab-home-on@3x.png'
import tabMessage from '@/assets/lib-icons/tab-message@3x.png'
import tabMessageOn from '@/assets/lib-icons/tab-message-on@3x.png'
import tabProfile from '@/assets/lib-icons/tab-profile@3x.png'
import tabProfileOn from '@/assets/lib-icons/tab-profile-on@3x.png'
import tabWish from '@/assets/lib-icons/tab-wish@3x.png'
import tabWishOn from '@/assets/lib-icons/tab-wish-on@3x.png'
import verifiedAccent from '@/assets/lib-icons/verified-accent@3x.png'
import wallet from '@/assets/lib-icons/wallet@3x.png'
import walletMuted from '@/assets/lib-icons/wallet-muted@3x.png'

export const ICONS = {
  /* 导航与账户 */
  tabHome,
  tabHomeOn,
  tabWish,
  tabWishOn,
  tabMessage,
  tabMessageOn,
  tabProfile,
  tabProfileOn,
  search,
  scan,
  bellInk,
  settings,
  settingsMuted,
  heart,
  heartOn,
  heartMuted,
  heartWhite,
  share,
  starLine,
  location,
  locationPin,
  /* 电商与交易 */
  cart,
  order,
  orderMuted,
  coupon,
  wallet,
  walletMuted,
  gift,
  credit,
  /* 工具与状态 */
  safe,
  safeAccent,
  hot,
  rank,
  /* 社交与互动 */
  browse,
  browseMuted,
  comment,
  commentMuted,
  chat,
  chatWhite,
  /* 时间与媒体 */
  history,
  historyMuted,
  clock,
  delete: deleteIcon,
  image,
  imageMuted,
  doc,
  docMuted,
  /* 应用与内容 */
  send,
  category,
  book,
  study,
  /* 行业与生活 */
  camera,
  /* 设计稿抽出（库内无等价图形） */
  plus,
  plusAccent,
  plusInk,
  backInk,
  moreInk,
  closeInk,
  chevronRightAccent,
  chevronRightMuted,
  chevronDownInk,
  chevronDownMuted,
  chevronUpAccent,
  chevronUpMuted,
  checkMuted,
  verifiedAccent,
  editImage,
  /* 商品一级分类 */
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

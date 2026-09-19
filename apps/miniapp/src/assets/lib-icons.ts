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
 * `build-lib-icons.mjs` 里 `local: true` 的几条（lock / warn / refresh / key / mail /
 * info / check-circle / camera-off / voice-wave / plus-line）走的是 tools/src/icons/
 * 下的本地几何：图标库里确实没有语义对应的图形，按待设计页面.md §5 的约定
 * 「缺什么列出来由实现侧补」，而不是拿一个「看起来差不多」的顶替。
 *
 * 约定：页面与组件**只从这里取图标**，不要直接 import 具体 png。
 * 换图标 = 改工具的映射表 + 重新生成，业务代码零改动。
 *
 * 文件位置：包内副本在 `src/assets/lib-icons/`；真源与生成器在 `D:\FISH\miniprogram`（不进包）。
 */
import ai from '@/assets/lib-icons/ai@3x.png'
import app from '@/assets/lib-icons/app@3x.png'
import appMuted from '@/assets/lib-icons/app-muted@3x.png'
import backInk from '@/assets/lib-icons/back-ink@3x.png'
import bellInk from '@/assets/lib-icons/bell-ink@3x.png'
import book from '@/assets/lib-icons/book@3x.png'
import bookMuted from '@/assets/lib-icons/book-muted@3x.png'
import box from '@/assets/lib-icons/box@3x.png'
import browse from '@/assets/lib-icons/browse@3x.png'
import browseMuted from '@/assets/lib-icons/browse-muted@3x.png'
import camera from '@/assets/lib-icons/camera@3x.png'
import cameraOff from '@/assets/lib-icons/camera-off@3x.png'
import card from '@/assets/lib-icons/card@3x.png'
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
import chatInk from '@/assets/lib-icons/chat-ink@3x.png'
import chatWhite from '@/assets/lib-icons/chat-white@3x.png'
import checkAccent from '@/assets/lib-icons/check-accent@3x.png'
import checkCircle from '@/assets/lib-icons/check-circle@3x.png'
import checkCircleWhite from '@/assets/lib-icons/check-circle-white@3x.png'
import checkMuted from '@/assets/lib-icons/check-muted@3x.png'
import checkWhite from '@/assets/lib-icons/check-white@3x.png'
import chevronDownMuted from '@/assets/lib-icons/chevron-down-muted@3x.png'
import chevronRightMuted from '@/assets/lib-icons/chevron-right-muted-solid@3x.png'
import chevronUpMuted from '@/assets/lib-icons/chevron-up-muted@3x.png'
import clock from '@/assets/lib-icons/clock@3x.png'
import clockInk from '@/assets/lib-icons/clock-ink@3x.png'
import clockMuted from '@/assets/lib-icons/clock-muted@3x.png'
import closeInk from '@/assets/lib-icons/close-ink-solid@3x.png'
import comment from '@/assets/lib-icons/comment@3x.png'
import commentMuted from '@/assets/lib-icons/comment-muted@3x.png'
import coupon from '@/assets/lib-icons/coupon@3x.png'
import credit from '@/assets/lib-icons/credit@3x.png'
import deleteIcon from '@/assets/lib-icons/delete@3x.png'
import doc from '@/assets/lib-icons/doc@3x.png'
import docInk from '@/assets/lib-icons/doc-ink@3x.png'
import docMuted from '@/assets/lib-icons/doc-muted@3x.png'
import editAccent from '@/assets/lib-icons/edit-accent@3x.png'
import editImage from '@/assets/lib-icons/edit-image@3x.png'
import feedback from '@/assets/lib-icons/feedback@3x.png'
import feedbackMuted from '@/assets/lib-icons/feedback-muted@3x.png'
import file from '@/assets/lib-icons/file@3x.png'
import gift from '@/assets/lib-icons/gift@3x.png'
import heartMuted from '@/assets/lib-icons/heart-muted@3x.png'
import heartOn from '@/assets/lib-icons/heart-on@3x.png'
import heartWhite from '@/assets/lib-icons/heart-white@3x.png'
import history from '@/assets/lib-icons/history@3x.png'
import historyMuted from '@/assets/lib-icons/history-muted@3x.png'
import hot from '@/assets/lib-icons/hot@3x.png'
import image from '@/assets/lib-icons/image@3x.png'
import imageMuted from '@/assets/lib-icons/image-muted@3x.png'
import info from '@/assets/lib-icons/info@3x.png'
import infoMuted from '@/assets/lib-icons/info-muted@3x.png'
import key from '@/assets/lib-icons/key@3x.png'
import location from '@/assets/lib-icons/location@3x.png'
import locationPin from '@/assets/lib-icons/location-pin@3x.png'
import lock from '@/assets/lib-icons/lock@3x.png'
import lockWhite from '@/assets/lib-icons/lock-white@3x.png'
import mail from '@/assets/lib-icons/mail@3x.png'
import mic from '@/assets/lib-icons/mic@3x.png'
import micWhite from '@/assets/lib-icons/mic-white@3x.png'
import moon from '@/assets/lib-icons/moon@3x.png'
import moreInk from '@/assets/lib-icons/more-ink@3x.png'
import order from '@/assets/lib-icons/order@3x.png'
import orderMuted from '@/assets/lib-icons/order-muted@3x.png'
import personAdd from '@/assets/lib-icons/person-add@3x.png'
import plus from '@/assets/lib-icons/plus@3x.png'
import plusInk from '@/assets/lib-icons/plus-ink@3x.png'
import plusLine from '@/assets/lib-icons/plus-line@3x.png'
import power from '@/assets/lib-icons/power@3x.png'
import profileBought from '@/assets/lib-icons/profile-bought@3x.png'
import profileFollow from '@/assets/lib-icons/profile-follow@3x.png'
import profileHeart from '@/assets/lib-icons/profile-heart@3x.png'
import profileHistory from '@/assets/lib-icons/profile-history@3x.png'
import profileOnsale from '@/assets/lib-icons/profile-onsale@3x.png'
import profileOrder from '@/assets/lib-icons/profile-order@3x.png'
import profileReview from '@/assets/lib-icons/profile-review@3x.png'
import profileSold from '@/assets/lib-icons/profile-sold@3x.png'
import profileWish from '@/assets/lib-icons/profile-wish@3x.png'
import qr from '@/assets/lib-icons/qr@3x.png'
import rank from '@/assets/lib-icons/rank@3x.png'
import readallAccent from '@/assets/lib-icons/readall-accent@3x.png'
import readallMuted from '@/assets/lib-icons/readall-muted@3x.png'
import refresh from '@/assets/lib-icons/refresh@3x.png'
import safeAccent from '@/assets/lib-icons/safe-accent@3x.png'
import safeMuted from '@/assets/lib-icons/safe-muted@3x.png'
import scan from '@/assets/lib-icons/scan@3x.png'
import scanAccent from '@/assets/lib-icons/scan-accent@3x.png'
import search from '@/assets/lib-icons/search@3x.png'
import send from '@/assets/lib-icons/send@3x.png'
import serviceMuted from '@/assets/lib-icons/service-muted@3x.png'
import settingsMuted from '@/assets/lib-icons/settings-muted@3x.png'
import share from '@/assets/lib-icons/share@3x.png'
import shieldLine from '@/assets/lib-icons/shield-line@3x.png'
import shieldWhite from '@/assets/lib-icons/shield-white@3x.png'
import starAccent from '@/assets/lib-icons/star-accent@3x.png'
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
import user from '@/assets/lib-icons/user@3x.png'
import verifiedAccent from '@/assets/lib-icons/verified-accent@3x.png'
import voiceWave from '@/assets/lib-icons/voice-wave@3x.png'
import walletMuted from '@/assets/lib-icons/wallet-muted@3x.png'
import warn from '@/assets/lib-icons/warn@3x.png'
import warnInk from '@/assets/lib-icons/warn-ink@3x.png'

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
  plusLine,
  chevronRightMuted,
  chevronDownMuted,
  chevronUpMuted,
  checkMuted,
  checkAccent,
  checkWhite,
  checkCircle,
  checkCircleWhite,
  delete: deleteIcon,
  refresh,
  scan,
  qr,

  /* 账号 / 认证 */
  user,
  lock,
  lockWhite,
  card,
  mail,
  key,
  shieldLine,
  shieldWhite,
  safeAccent,
  safeMuted,
  verifiedAccent,
  personAdd,

  /* 内容与状态 */
  bellInk,
  camera,
  cameraOff,
  category,
  book,
  bookMuted,
  share,
  starLine,
  starAccent,
  commentMuted,
  comment,
  heartMuted,
  heartOn,
  heartWhite,
  historyMuted,
  history,
  clock,
  clockInk,
  clockMuted,
  order,
  orderMuted,
  settingsMuted,
  send,
  rank,
  hot,
  ai,
  info,
  infoMuted,
  warn,
  warnInk,
  power,
  moon,
  feedback,
  feedbackMuted,
  app,
  appMuted,
  doc,
  docInk,
  docMuted,
  file,
  image,
  imageMuted,
  readallAccent,
  readallMuted,
  box,
  browse,
  browseMuted,
  chat,
  chatInk,
  chatWhite,
  mic,
  micWhite,
  voiceWave,
  location,
  locationPin,
  cart,
  coupon,
  credit,
  gift,
  walletMuted,
  study,
  editImage,

  /* 「我的」页 3版稿（图标卡片 / 帮助与设置行 / 头部编辑与扫码） */
  profileHeart,
  profileHistory,
  profileFollow,
  profileWish,
  profileOrder,
  profileOnsale,
  profileSold,
  profileBought,
  profileReview,
  editAccent,
  scanAccent,
  serviceMuted,

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

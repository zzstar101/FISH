/**
 * 图标资产出口（唯一入口）。**本文件由 `tools/icons/build.ts` 生成，不要手改。**
 *
 * 真源：`tools/icons/glyphs/*.svg`（字形）× `tools/icons/manifest.ts`（每个字形用到的语义色）。
 * 重出图：`bun run --filter @fish/miniapp icons`。
 *
 * 命名 = 字形 + 语义色：`Brand` 品牌蓝 / `Fg` 主文字 / `Muted` 次要灰 / `White` 反白 /
 * `Danger` 警示红；`tab*Brand`（TabBar 选中态）与 `entry*Brand`（「我的」交易入口）是加粗描边 + 半透明错位填充。页面与组件**只从这里取图标**，不要直接 import 具体 png。
 * 显示尺寸只用 24 / 32 / 40 / 48（SCSS px = rpx）四档；字形在 72px 画布里按 `GLYPH_ZOOM`
 * 放大到占满画布的 83%–93%，所以想要更大的图标请改 `GLYPH_ZOOM` 重出图，不要抬高显示尺寸。
 */
import backFg from '@/assets/lib-icons/back-fg@3x.png'
import bellFg from '@/assets/lib-icons/bell-fg@3x.png'
import boxMuted from '@/assets/lib-icons/box-muted@3x.png'
import cameraMuted from '@/assets/lib-icons/camera-muted@3x.png'
import cartFg from '@/assets/lib-icons/cart-fg@3x.png'
import catApparelBrand from '@/assets/lib-icons/cat-apparel-brand@3x.png'
import catBeautyBrand from '@/assets/lib-icons/cat-beauty-brand@3x.png'
import catBooksBrand from '@/assets/lib-icons/cat-books-brand@3x.png'
import catDailyBrand from '@/assets/lib-icons/cat-daily-brand@3x.png'
import catDigitalBrand from '@/assets/lib-icons/cat-digital-brand@3x.png'
import catOtherBrand from '@/assets/lib-icons/cat-other-brand@3x.png'
import catSportsBrand from '@/assets/lib-icons/cat-sports-brand@3x.png'
import catTransportBrand from '@/assets/lib-icons/cat-transport-brand@3x.png'
import chatFg from '@/assets/lib-icons/chat-fg@3x.png'
import chatWhite from '@/assets/lib-icons/chat-white@3x.png'
import checkBrand from '@/assets/lib-icons/check-brand@3x.png'
import checkCircleBrand from '@/assets/lib-icons/check-circle-brand@3x.png'
import checkDoubleBrand from '@/assets/lib-icons/check-double-brand@3x.png'
import checkDoubleMuted from '@/assets/lib-icons/check-double-muted@3x.png'
import checkWhite from '@/assets/lib-icons/check-white@3x.png'
import chevronDownMuted from '@/assets/lib-icons/chevron-down-muted@3x.png'
import chevronRightMuted from '@/assets/lib-icons/chevron-right-muted@3x.png'
import chevronUpMuted from '@/assets/lib-icons/chevron-up-muted@3x.png'
import clockFg from '@/assets/lib-icons/clock-fg@3x.png'
import clockMuted from '@/assets/lib-icons/clock-muted@3x.png'
import closeFg from '@/assets/lib-icons/close-fg@3x.png'
import commentMuted from '@/assets/lib-icons/comment-muted@3x.png'
import crownBrand from '@/assets/lib-icons/crown-brand@3x.png'
import docFg from '@/assets/lib-icons/doc-fg@3x.png'
import docMuted from '@/assets/lib-icons/doc-muted@3x.png'
import editBrand from '@/assets/lib-icons/edit-brand@3x.png'
import entryBoughtBrand from '@/assets/lib-icons/entry-bought-brand@3x.png'
import entryOnsaleBrand from '@/assets/lib-icons/entry-onsale-brand@3x.png'
import entryReportBrand from '@/assets/lib-icons/entry-report-brand@3x.png'
import entryReviewBrand from '@/assets/lib-icons/entry-review-brand@3x.png'
import entrySoldBrand from '@/assets/lib-icons/entry-sold-brand@3x.png'
import feedbackFg from '@/assets/lib-icons/feedback-fg@3x.png'
import feedbackMuted from '@/assets/lib-icons/feedback-muted@3x.png'
import fileFg from '@/assets/lib-icons/file-fg@3x.png'
import gridFg from '@/assets/lib-icons/grid-fg@3x.png'
import headsetMuted from '@/assets/lib-icons/headset-muted@3x.png'
import heartFillBrand from '@/assets/lib-icons/heart-fill-brand@3x.png'
import heartMuted from '@/assets/lib-icons/heart-muted@3x.png'
import heartWhite from '@/assets/lib-icons/heart-white@3x.png'
import homeMuted from '@/assets/lib-icons/home-muted@3x.png'
import imageMuted from '@/assets/lib-icons/image-muted@3x.png'
import infoFg from '@/assets/lib-icons/info-fg@3x.png'
import infoMuted from '@/assets/lib-icons/info-muted@3x.png'
import keyFg from '@/assets/lib-icons/key-fg@3x.png'
import keyboardFg from '@/assets/lib-icons/keyboard-fg@3x.png'
import lockFg from '@/assets/lib-icons/lock-fg@3x.png'
import mailFg from '@/assets/lib-icons/mail-fg@3x.png'
import micFg from '@/assets/lib-icons/mic-fg@3x.png'
import orderFg from '@/assets/lib-icons/order-fg@3x.png'
import orderMuted from '@/assets/lib-icons/order-muted@3x.png'
import plusBrand from '@/assets/lib-icons/plus-brand@3x.png'
import plusWhite from '@/assets/lib-icons/plus-white@3x.png'
import powerDanger from '@/assets/lib-icons/power-danger@3x.png'
import qrFg from '@/assets/lib-icons/qr-fg@3x.png'
import refreshBrand from '@/assets/lib-icons/refresh-brand@3x.png'
import scanBrand from '@/assets/lib-icons/scan-brand@3x.png'
import searchMuted from '@/assets/lib-icons/search-muted@3x.png'
import settingsMuted from '@/assets/lib-icons/settings-muted@3x.png'
import shareFg from '@/assets/lib-icons/share-fg@3x.png'
import shieldBrand from '@/assets/lib-icons/shield-brand@3x.png'
import shieldCheckBrand from '@/assets/lib-icons/shield-check-brand@3x.png'
import shieldFg from '@/assets/lib-icons/shield-fg@3x.png'
import shieldMuted from '@/assets/lib-icons/shield-muted@3x.png'
import sparkleBrand from '@/assets/lib-icons/sparkle-brand@3x.png'
import starBrand from '@/assets/lib-icons/star-brand@3x.png'
import tabHomeBrand from '@/assets/lib-icons/tab-home-brand@3x.png'
import tabHomeMuted from '@/assets/lib-icons/tab-home-muted@3x.png'
import tabMeBrand from '@/assets/lib-icons/tab-me-brand@3x.png'
import tabMeMuted from '@/assets/lib-icons/tab-me-muted@3x.png'
import tabMessageBrand from '@/assets/lib-icons/tab-message-brand@3x.png'
import tabMessageMuted from '@/assets/lib-icons/tab-message-muted@3x.png'
import tabWishBrand from '@/assets/lib-icons/tab-wish-brand@3x.png'
import tabWishMuted from '@/assets/lib-icons/tab-wish-muted@3x.png'
import tagMuted from '@/assets/lib-icons/tag-muted@3x.png'
import trashFg from '@/assets/lib-icons/trash-fg@3x.png'
import trashWhite from '@/assets/lib-icons/trash-white@3x.png'
import userAddBrand from '@/assets/lib-icons/user-add-brand@3x.png'
import userFg from '@/assets/lib-icons/user-fg@3x.png'
import verifiedBrand from '@/assets/lib-icons/verified-brand@3x.png'
import warnDanger from '@/assets/lib-icons/warn-danger@3x.png'
import warnFg from '@/assets/lib-icons/warn-fg@3x.png'
import wishMuted from '@/assets/lib-icons/wish-muted@3x.png'

export const ICONS = {
  tabHomeMuted,
  tabHomeBrand,
  tabWishMuted,
  tabWishBrand,
  tabMessageMuted,
  tabMessageBrand,
  tabMeMuted,
  tabMeBrand,
  entryOnsaleBrand,
  entrySoldBrand,
  entryBoughtBrand,
  entryReviewBrand,
  entryReportBrand,
  backFg,
  closeFg,
  searchMuted,
  plusBrand,
  plusWhite,
  chevronRightMuted,
  chevronDownMuted,
  chevronUpMuted,
  checkBrand,
  checkWhite,
  checkCircleBrand,
  checkDoubleBrand,
  checkDoubleMuted,
  trashFg,
  trashWhite,
  refreshBrand,
  scanBrand,
  qrFg,
  shareFg,
  editBrand,
  userAddBrand,
  lockFg,
  mailFg,
  keyFg,
  shieldBrand,
  shieldMuted,
  shieldFg,
  shieldCheckBrand,
  verifiedBrand,
  bellFg,
  cameraMuted,
  imageMuted,
  tagMuted,
  starBrand,
  heartMuted,
  heartWhite,
  heartFillBrand,
  commentMuted,
  chatFg,
  chatWhite,
  feedbackFg,
  feedbackMuted,
  clockFg,
  clockMuted,
  orderFg,
  orderMuted,
  boxMuted,
  docFg,
  docMuted,
  fileFg,
  gridFg,
  crownBrand,
  sparkleBrand,
  infoFg,
  infoMuted,
  warnFg,
  warnDanger,
  powerDanger,
  settingsMuted,
  headsetMuted,
  micFg,
  keyboardFg,
  cartFg,
  catBooksBrand,
  catDigitalBrand,
  catDailyBrand,
  catApparelBrand,
  catSportsBrand,
  catTransportBrand,
  catBeautyBrand,
  catOtherBrand,
  homeMuted,
  wishMuted,
  userFg,
} as const

export type IconName = keyof typeof ICONS

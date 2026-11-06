/**
 * 图标清单：每一行 = 一个字形 × 它在页面里真正用到的语义色。
 *
 * - 字形真源：`tools/icons/glyphs/<glyph>.svg`（24×24 网格、1.75 描边、圆头圆角、单色，
 *   画在 4–20 的内容框里；出图时 `build.ts` 的 `GLYPH_ZOOM` 会把 viewBox 收紧到这个框附近
 *   （字形最大边占到画布 83%–93%，显示尺寸四档不变），所以真源继续按 4–20 画，
 *   不要为了"看起来更大"把字形画出这个框；`heart-fill` 是同一轮廓的实心版，只给「已收藏」用；
 *   `tab-*`（TabBar）与 `entry-*`（「我的」交易入口格）是带填充的字形：主体带 `fill="accentColor"`
 *   的错位填充块，只在 `brand` 下显色）。
 * - 颜色只认这里的 5 个语义名，值与 `src/styles/_token-vars.scss` 的令牌一一对应；
 *   页面不再挑具体色值，换色 = 改这里的 tone + 重出图。
 * - 产物：`src/assets/lib-icons/<glyph>-<tone>@3x.png` 与出口 `ICONS.<glyph><Tone>`
 *   （如 `chevron-right` × `muted` → `ICONS.chevronRightMuted`），名字与颜色一一对应。
 *
 * 新增图标：先画 svg，再在这里登记要用的 tone，跑 `bun run --filter @fish/miniapp icons`。
 * 不用的 tone 不要登记 —— `tests/lib-icons.test.ts` 会拦「导出了但没人引用」的条目。
 * 显示尺寸只用 24/32/40/48 四档；各档适用哪种场景见 `apps/miniapp/DESIGN.md` §6
 * 「图标显示尺寸四档的场景口径」（草案，待 Owner 拍板）。
 */
export const TONES = {
  brand: '#4285FF', // --brand
  fg: '#17233D', // --fg
  muted: '#71809C', // --muted
  white: '#FFFFFF', // 深色/品牌色底上的反白
  danger: '#FF5F6D', // --danger：仅退出登录、警示
} as const

/** 字形里 `fill="accentColor"` 的填充块：`brand` 下画成半透明品牌蓝（描边同时加粗到 2），其它语义色下不画 */
export const ACCENT_OPACITY = 0.35

export type Tone = keyof typeof TONES

export const MANIFEST: Record<string, readonly Tone[]> = {
  /* TabBar：同一字形，未选中 = 灰色线稿，选中 = 品牌蓝加粗描边 + 浅品牌蓝错位填充；
     「出物」凸起钮用 plus × white */
  'tab-home': ['muted', 'brand'],
  'tab-wish': ['muted', 'brand'],
  'tab-message': ['muted', 'brand'],
  'tab-me': ['muted', 'brand'],
  /* 「我的」交易入口格：在售 / 卖出 / 买入 / 评价 / 举报，与 TabBar 选中态同一画法 */
  'entry-onsale': ['brand'],
  'entry-sold': ['brand'],
  'entry-bought': ['brand'],
  'entry-review': ['brand'],
  'entry-report': ['brand'],

  /* 导航与操作 */
  back: ['fg'],
  close: ['fg'],
  search: ['muted'],
  plus: ['brand', 'white'],
  'chevron-right': ['muted'],
  'chevron-down': ['muted'],
  'chevron-up': ['muted'],
  check: ['brand', 'white'],
  'check-circle': ['brand'],
  'check-double': ['brand', 'muted'],
  trash: ['fg', 'white'],
  refresh: ['brand'],
  scan: ['brand'],
  qr: ['fg'],
  share: ['fg'],
  edit: ['brand'],

  /* 账号 / 认证 / 安全 */
  'user-add': ['brand'],
  lock: ['fg'],
  mail: ['fg'],
  key: ['fg'],
  shield: ['brand', 'muted', 'fg'],
  'shield-check': ['brand'],
  verified: ['brand'],

  /* 内容与状态 */
  bell: ['fg'],
  camera: ['muted', 'white'], // white：头像相机角标压在品牌蓝圆底上（白图才看得清）
  image: ['muted'],
  tag: ['muted'],
  star: ['brand'],
  heart: ['muted', 'white'],
  'heart-fill': ['brand'],
  comment: ['muted'],
  chat: ['fg', 'white'],
  feedback: ['fg', 'muted'],
  clock: ['fg', 'muted'],
  order: ['fg', 'muted'],
  box: ['muted'],
  doc: ['fg', 'muted'],
  file: ['fg'],
  grid: ['fg'],
  crown: ['brand'],
  sparkle: ['brand'],
  info: ['fg', 'muted'],
  warn: ['fg', 'danger'],
  power: ['danger'],
  settings: ['muted'],
  headset: ['muted'],
  mic: ['fg'],
  keyboard: ['fg'],
  cart: ['fg'],

  /* 商品一级分类（首页横滑圆盘 / 许愿分类） */
  'cat-books': ['brand'],
  'cat-digital': ['brand'],
  'cat-daily': ['brand'],
  'cat-apparel': ['brand'],
  'cat-sports': ['brand'],
  'cat-transport': ['brand'],
  'cat-beauty': ['brand'],
  'cat-other': ['brand'],
  /* 页面内的线性小图：约饭地点、识图结果「许愿」入口、头像占位 */
  home: ['muted'],
  wish: ['muted'],
  user: ['fg'],
}

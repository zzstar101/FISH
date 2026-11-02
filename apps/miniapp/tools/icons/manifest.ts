/**
 * 图标清单：每一行 = 一个字形 × 它在页面里真正用到的语义色。
 *
 * - 字形真源：`tools/icons/glyphs/<glyph>.svg`（24×24 网格、1.75 描边、圆头圆角、单色，
 *   画在 4–20 的内容框里；`heart-fill` 是同一轮廓的实心版，只给「已收藏」用；
 *   `tab-*` 是 TabBar 专用字形，主体带 `fill="accentColor"` 的错位填充块，只在 `duo` 下显色）。
 * - 颜色只认这里的语义名（单色 5 个 + TabBar 选中态的双色 `duo`），值与 `src/styles/_token-vars.scss` 的令牌一一对应；
 *   页面不再挑具体色值，换色 = 改这里的 tone + 重出图。
 * - 产物：`src/assets/lib-icons/<glyph>-<tone>@3x.png` 与出口 `ICONS.<glyph><Tone>`
 *   （如 `chevron-right` × `muted` → `ICONS.chevronRightMuted`），名字与颜色一一对应。
 *
 * 新增图标：先画 svg，再在这里登记要用的 tone，跑 `bun run --filter @fish/miniapp icons`。
 * 不用的 tone 不要登记 —— `tests/lib-icons.test.ts` 会拦「导出了但没人引用」的条目。
 */
export const TONES = {
  brand: '#4285FF', // --brand
  fg: '#17233D', // --fg
  muted: '#71809C', // --muted
  white: '#FFFFFF', // 深色/品牌色底上的反白
  danger: '#FF5F6D', // --danger：仅退出登录、警示
  /** 双色：描边 --fg（加粗到 2）+ 错位填充 --brand。只给 TabBar 选中态，同一 svg 出 muted 即未选中态 */
  duo: '#17233D',
} as const

/** 字形里 `fill="accentColor"` 的填充块：只有 `duo` 时显色，其它语义色下不画 */
export const ACCENT = TONES.brand

export type Tone = keyof typeof TONES

export const MANIFEST: Record<string, readonly Tone[]> = {
  /* TabBar：同一字形，未选中 = 灰色线稿，选中 = 深色加粗描边 + 品牌蓝错位填充；
     「出物」凸起钮用 plus × white */
  'tab-home': ['muted', 'duo'],
  'tab-wish': ['muted', 'duo'],
  'tab-message': ['muted', 'duo'],
  'tab-me': ['muted', 'duo'],
  home: ['muted'],
  wish: ['muted'],
  user: ['fg'],

  /* 导航与操作 */
  back: ['fg'],
  close: ['fg'],
  search: ['muted'],
  plus: ['brand', 'white'],
  'chevron-right': ['muted'],
  'chevron-down': ['muted'],
  'chevron-up': ['muted'],
  check: ['brand', 'muted', 'white'],
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
  camera: ['muted'],
  image: ['muted'],
  tag: ['brand', 'muted'],
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
  download: ['brand'],
  upload: ['brand'],

  /* 商品一级分类（首页横滑圆盘 / 许愿分类） */
  'cat-books': ['brand'],
  'cat-digital': ['brand'],
  'cat-daily': ['brand'],
  'cat-apparel': ['brand'],
  'cat-sports': ['brand'],
  'cat-transport': ['brand'],
  'cat-beauty': ['brand'],
  'cat-other': ['brand'],
}

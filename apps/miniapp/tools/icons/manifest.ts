/**
 * 图标清单：每一行 = 一个字形 × 它在页面里真正用到的语义色。
 *
 * - 字形真源：`tools/icons/glyphs/<glyph>.svg`（24×24 网格、1.75 描边、圆头圆角、单色，
 *   画在 4–20 的内容框里；`-fill` 后缀是同一轮廓的实心版，只给「选中 / 已收藏」这类状态用）。
 * - 颜色只认这里的 5 个语义名，值与 `src/styles/_token-vars.scss` 的令牌一一对应；
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
} as const

export type Tone = keyof typeof TONES

export const MANIFEST: Record<string, readonly Tone[]> = {
  /* TabBar：未选中描边灰 / 选中实心品牌蓝；「出物」凸起钮用 plus × white */
  home: ['muted'],
  'home-fill': ['brand'],
  wish: ['muted'],
  'wish-fill': ['brand'],
  message: ['muted'],
  'message-fill': ['brand'],
  user: ['fg', 'muted'],
  'user-fill': ['brand'],

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

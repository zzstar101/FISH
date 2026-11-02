import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { ICONS } from '@/assets/lib-icons'

/**
 * 认证标识的**两档形态契约**（#534）。
 *
 * 端上「已认证」只用两种视觉，按容器场景分档，**不允许第三种形态回流**：
 * 1. **大徽章 `BADGE.verified`**（设计稿「认证」3D 徽章，独立出口 `@/assets/badge`）：
 *    我的页、商品详情卖家行、订单卡昵称右侧；
 * 2. **小图标 `ICONS.verifiedBrand`**（头像角标 / 列表小勾 / 认证页等小尺寸位）：
 *    product-card、settings、verify、user 主页、following、favorites、watchers。
 *
 * 大徽章为什么不进 `ICONS`：`ICONS` 是 `tools/icons` 生成的**单色语义图标**（字形 × 语义色，
 * 显示尺寸只走 24/32/40/48 正方形四档，清单外的文件生成时会删掉）。这张是设计稿的多色
 * **横向**成品图（275×108，非正方形），登记进去会被当成新字形重建、或被生成器按清单删除。
 * 所以它走独立目录 + 独立出口，本文件同时钉住「它不许回流进 ICONS」、原图字节、按比例
 * 的显示尺寸 —— 独立出口不是为了让通用图标断言放过它。
 *
 * 历史上漂过的三种形态：「我的」页纯文字无图标、商品详情卖家位用中性灰勾 `checkMuted`、
 * 订单卡用 CSS 手绘蓝圆勾。这类漂移 lint / typecheck / 功能单测全绿，只有人眼能看出来，
 * 所以按本仓既有手法（`order-list-state.test.ts` 的源码字符串断言）钉住调用点。
 */
const SRC = new URL('../src/', import.meta.url)
const SRC_DIR = SRC.pathname

async function source(relPath: string): Promise<string> {
  return await Bun.file(new URL(relPath, SRC)).text()
}

/** 取包含 `anchor` 的片段：从 `anchor` 起、到其后第一个 `end` 止（找不到返回空串） */
function slice(sourceText: string, anchor: string, end: string, maxLength = 600): string {
  const start = sourceText.indexOf(anchor)
  if (start === -1) return ''
  const endAt = sourceText.indexOf(end, start + anchor.length)
  const stop = endAt === -1 ? start + maxLength : Math.min(endAt + end.length, start + maxLength)
  return sourceText.slice(start, stop)
}

/** 扫 `src/**\/*.{ts,tsx}`，返回源码里出现 `needle` 的文件（相对 `src/`，已排序） */
async function consumersOf(needle: string): Promise<string[]> {
  const glob = new Bun.Glob('**/*.{ts,tsx}')
  const files: string[] = []
  for await (const file of glob.scan({ cwd: SRC_DIR })) {
    if ((await Bun.file(new URL(file, SRC)).text()).includes(needle)) files.push(file)
  }
  return files.sort()
}

/** scss 里 `.cls { … }` 这一条规则的声明文本 */
async function scssBlock(relPath: string, cls: string): Promise<string> {
  const text = await source(relPath)
  const start = text.indexOf(`.${cls} {`)
  if (start === -1) return ''
  return text.slice(start, text.indexOf('}', start))
}

function pxOf(decls: string, prop: 'width' | 'height'): number | null {
  const m = new RegExp(`(?:^|[;{\\s])${prop}:\\s*(\\d+)px;`).exec(decls)
  return m?.[1] === undefined ? null : Number(m[1])
}

/** PNG 头里的画布尺寸（IHDR 前 8 字节），不引第三方解码 */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

const BADGE_ASSET = 'assets/badge/verified-badge@3x.png'
/** 设计稿原图字节的 sha256：换图必须走设计稿重出，不允许随手缩图覆盖 */
const BADGE_SHA256 = '7cb679e483804ecd7a53779b04ffee6d9310fed053c885771f92441bbe1601fc'
/** 设计稿徽章画布：275×108（比例 2.546），横向成品图，**不是**图标正方形四档 */
const BADGE_DESIGN = { width: 275, height: 108 }

/** 大徽章的三个消费点：容器 scss 类名 → 设计尺寸（高度压在昵称字号之下） */
const BADGE_DISPLAY = [
  {
    tsx: 'pages/profile/index.tsx',
    scss: 'pages/profile/index.scss',
    cls: 'profile__auth-badge',
    width: 87,
    height: 34,
  },
  {
    tsx: 'components/order-list/index.tsx',
    scss: 'components/order-list/index.scss',
    cls: 'orders__vbadge',
    width: 61,
    height: 24,
  },
  {
    tsx: 'pkg-browse/pages/listing-detail/index.tsx',
    scss: 'pkg-browse/pages/listing-detail/index.scss',
    cls: 'detail__stick',
    width: 61,
    height: 24,
  },
] as const

describe('大徽章资产（#534：设计稿「认证」整图，独立出口 @/assets/badge）', () => {
  test('资产在独立目录里，原图像素与字节都没被改过', async () => {
    const bytes = new Uint8Array(await Bun.file(new URL(BADGE_ASSET, SRC)).arrayBuffer())
    expect(pngSize(bytes)).toEqual(BADGE_DESIGN)
    expect(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')).toBe(BADGE_SHA256)
  })

  test('出口 @/assets/badge 只导出这一个键，且指向该资产', async () => {
    const exit = await source('assets/badge/index.ts')
    expect(exit).toContain("import verifiedBadge from './verified-badge@3x.png'")
    expect(exit).toContain('export const BADGE')
    expect(exit).toContain('verified: verifiedBadge,')
  })

  test('大徽章没有回流进生成的 ICONS（生成器会把它当字形重建 / 按清单删掉）', () => {
    expect(Object.keys(ICONS)).not.toContain('verifiedBadge')
    expect(
      readdirSync(new URL('assets/lib-icons', SRC)).filter((f) => f.includes('verified-badge')),
    ).toEqual([])
    expect(readdirSync(new URL('../tools/icons/glyphs', import.meta.url))).not.toContain(
      'verified-badge.svg',
    )
  })

  test('大徽章的消费点白名单：只有我的页 / 订单卡 / 详情卖家行，新增必须显式登记', async () => {
    expect(await consumersOf('BADGE.verified')).toEqual(BADGE_DISPLAY.map((e) => e.tsx).sort())
  })

  test('大徽章的显示尺寸按设计稿比例缩放（非正方形，不拉伸、不留白）', async () => {
    const design = BADGE_DESIGN.width / BADGE_DESIGN.height
    for (const entry of BADGE_DISPLAY) {
      const decls = await scssBlock(entry.scss, entry.cls)
      expect({ cls: entry.cls, decls: decls !== '' }).toEqual({ cls: entry.cls, decls: true })
      const width = pxOf(decls, 'width')
      const height = pxOf(decls, 'height')
      expect({ cls: entry.cls, width, height }).toEqual({
        cls: entry.cls,
        width: entry.width,
        height: entry.height,
      })
      // 横向成品图：宽高比为原图比例（容差 1%，aspectFit 下才不变形不留白）
      const ratio = (width ?? 0) / (height ?? 1)
      expect({ cls: entry.cls, withinOnePercent: Math.abs(ratio / design - 1) < 0.01 }).toEqual({
        cls: entry.cls,
        withinOnePercent: true,
      })
    }
  })
})

describe('认证标识形态契约（#534：昵称行大徽章 + 小尺寸小图标两档）', () => {
  test('「我的」页：已认证渲染设计稿徽章，且徽章与未认证胶囊都可点进认证页', async () => {
    const text = await source('pages/profile/index.tsx')
    const verifiedBranch = slice(text, '{verified ? (', ') : (')
    expect(verifiedBranch).not.toBe('')
    expect(verifiedBranch).toContain('BADGE.verified')
    expect(verifiedBranch).toContain('profile__auth-badge')
    expect(verifiedBranch).toContain('onClick={openVerify}')
    // 未认证分支：引导文案 + 同样进认证页（用文案锚点取窗口，避免撞上前面的其它三元）
    const labelAt = text.indexOf('未认证，前往认证')
    expect(labelAt).toBeGreaterThan(-1)
    const unverifiedWindow = text.slice(Math.max(0, labelAt - 400), labelAt + 200)
    expect(unverifiedWindow).toContain('onClick={openVerify}')
  })

  test('「我的」页：徽章在昵称行之外（昵称下方单独一行）', async () => {
    const text = await source('pages/profile/index.tsx')
    const nameRow = slice(text, 'className="profile__name-row"', 'profile__auth-badge')
    expect(nameRow).not.toBe('')
    // name-row 在徽章之前就已闭合，徽章不属于它
    expect(nameRow).not.toContain('{verified ? (')
  })

  test('商品详情卖家位：已验证用设计稿徽章，不再用灰勾 checkMuted', async () => {
    const block = slice(
      await source('pkg-browse/pages/listing-detail/index.tsx'),
      "data.seller.authStatus === 'VERIFIED'",
      ') : null}',
    )
    expect(block).not.toBe('')
    expect(block).toContain('BADGE.verified')
    expect(block).not.toContain('ICONS.checkMuted')
  })

  test('订单卡：已认证徽章用设计稿「认证」图，不再是 CSS 手绘勾', async () => {
    const block = slice(
      await source('components/order-list/index.tsx'),
      'item.counterpart.verified',
      '/>',
    )
    expect(block).not.toBe('')
    expect(block).toContain('BADGE.verified')
    expect(block).toContain('orders__vbadge')
  })

  test('订单卡样式：不再自绘圆底与伪元素勾（交给徽章资产）', async () => {
    const scss = await source('components/order-list/index.scss')
    const start = scss.indexOf('.orders__vbadge {')
    expect(start).toBeGreaterThan(-1)
    const block = scss.slice(start, scss.indexOf('}', start))
    expect(block).not.toContain('border-radius')
    expect(block).not.toContain('background')
    expect(scss).not.toContain('.orders__vbadge::after')
  })

  test('小图标档（verifiedBrand）消费点是白名单：新增必须显式登记', async () => {
    // 头像角标 / 列表小勾 / 认证页等小尺寸位；昵称行一律走大徽章 BADGE.verified
    expect(await consumersOf('ICONS.verifiedBrand')).toEqual([
      'components/product-card/index.tsx',
      'pkg-auth/pages/settings/index.tsx',
      'pkg-auth/pages/verify/index.tsx',
      'pkg-browse/pages/favorites/index.tsx',
      'pkg-browse/pages/following/index.tsx',
      'pkg-browse/pages/user/index.tsx',
      'pkg-browse/pages/watchers/index.tsx',
    ])
  })

  test('checkMuted（灰勾）已无消费点，也不再由生成器产出', async () => {
    expect(await consumersOf('ICONS.checkMuted')).toEqual([])
    expect(Object.keys(ICONS)).not.toContain('checkMuted')
    expect(readdirSync(new URL('assets/lib-icons', SRC))).not.toContain('check-muted@3x.png')
  })
})

import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { ICONS } from '@/assets/lib-icons'
import { MANIFEST } from '../tools/icons/manifest'

/**
 * 认证标识的**形态契约**（#534 立约，#563 收口）。
 *
 * 端上「已认证」只有一个视觉成品图，**不允许第二种形态回流**：
 * **大徽章 `BADGE.verified`**（设计稿「认证」3D 徽章，独立出口 `@/assets/badge`）——
 * 我的页、商品详情卖家行、订单卡昵称右侧、认证页说明卡，以及 #563 并过来的列表 / 卡片语境：
 * product-card、收藏、关注、想要的人、TA 的主页（页头昵称行 + 导航标题）。
 *
 * 唯一还留在旧档 `ICONS.verifiedBrand`（12 角多边形 + 勾，72×72 生成器图标）的位是
 * **设置页的头像角标**（`pkg-auth/pages/settings`，40×40 绝对定位）：横向成品图塞不进
 * 头像右下角那 40×40 的角标位，改行内要先动账号行版式，Owner 决定本票不碰。
 * 图标的定义与生成清单同样不动（退役另开票）—— 所以 `ICONS.verifiedBrand` 仍在出口里，
 * 只是端上不应再有新的消费点。
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

/**
 * 取包含 `anchor` 的片段：从 `anchor` 起、到其后第一个 `end` 止。
 *
 * **找不到锚点或结束符一律返回空串**（调用方断言 `not.toBe('')` 即转红）。以前找不到 `end`
 * 会退化成「从 anchor 起 600 字符窗口」，结果断言读到的是别处的代码却仍然绿 —— 实测两处
 * 锚点原始距离已达 712 字符，那条「徽章在昵称行之外」的断言等于没生效。
 */
function slice(sourceText: string, anchor: string, end: string): string {
  const start = sourceText.indexOf(anchor)
  if (start === -1) return ''
  const endAt = sourceText.indexOf(end, start + anchor.length)
  if (endAt === -1) return ''
  return sourceText.slice(start, endAt + end.length)
}

/**
 * 去掉注释后的源码：断言只该看**代码**，不该看说明文字。
 *
 * 以前 `consumersOf()` / `places` / `aspectFit` / 「不许出现 `已认证`」全是对**全文**的纯子串
 * 匹配，于是注释里的字面量会被当成代码 —— 实测两种后果：
 * 1) 在白名单文件里补一句「与 `BADGE.verified` 同一张图」的说明注释 → `places` 与 `aspectFit`
 *    两条**双双误报**，报错文字是「消费位数量不对」，把人引向完全错误的方向；
 * 2) 本仓既有注释风格就是 `{/* 已认证徽章（#534）：… *\/}`（见
 *    `apps/miniapp/src/components/order-list/index.tsx:431`），逼得「为什么撤掉外壳」只能写进
 *    scss，tsx 侧零解释 —— 后面维护的人只读 tsx 就不知道这里曾有两层装饰。
 *
 * 剥的是 `/* … *\/`（含 JSX 的 `{/* … *\/}`）与 `//` 行注释；`//` 前是冒号/反斜杠时不动，
 * 避免把 `https://` 这类字符串截断。
 *
 * **限制（别指望它字符串安全）**：纯正则、不认字符串字面量。
 * - 跨字符串的 `/*` `*\/` 会被当注释吃掉中间代码（如 `'a/*b'` + `'c*\/d'`）；
 * - 字符串/模板串里的 `//` 会被截断，实测全仓唯一真实触发是
 *   `apps/miniapp/src/features/chat/realtime.ts:109`（截成 `` return `${scheme} ``），
 *   该行不含任何被本文件守卫的字面量，所以今天无影响；
 * - 反过来，注释里现在**可以**正常提及 `BADGE.verified` / `已认证`，不会被计成消费点。
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/gm, '$1')
}

/** 扫 `src/**\/*.{ts,tsx}`，返回**代码里**出现 `needle` 的文件（相对 `src/`，已排序） */
async function consumersOf(needle: string): Promise<string[]> {
  const glob = new Bun.Glob('**/*.{ts,tsx}')
  const files: string[] = []
  for await (const file of glob.scan({ cwd: SRC_DIR })) {
    const text = stripComments(await Bun.file(new URL(file, SRC)).text())
    if (text.includes(needle)) files.push(file)
  }
  return files.sort()
}

/**
 * 从 tsx 文本里取出所有当作类名候选的 token：双引号 / 单引号 / 模板串字面量都算。
 *
 * 只认 `className="…"` 双引号形态会漏掉 `` className={`wt__badge`} ``（对抗性审查实测：
 * 不带文案时静默通过），所以这里按「所有字符串字面量」取 token，再按空格与 `${}` 拆开。
 */
function classTokens(text: string): string[] {
  return [...text.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)]
    .flatMap((m) => (m[1] ?? m[2] ?? m[3] ?? '').split(/[\s${}]+/))
    .filter(Boolean)
}

/** scss 里 `.cls { … }` 这一条规则的声明文本（同样先剥注释，与别处判据一致） */
async function scssBlock(relPath: string, cls: string): Promise<string> {
  const text = stripComments(await source(relPath))
  const start = text.indexOf(`.${cls} {`)
  if (start === -1) return ''
  return text.slice(start, text.indexOf('}', start))
}

/** 按**代码内容**扫 `src/**\/*.{ts,tsx,scss}`，返回出现 `needle` 的文件（相对 `src/`，已排序） */
async function filesMentioning(needle: string): Promise<string[]> {
  const glob = new Bun.Glob('**/*.{ts,tsx,scss}')
  const files: string[] = []
  for await (const file of glob.scan({ cwd: SRC_DIR })) {
    const text = stripComments(await Bun.file(new URL(file, SRC)).text())
    if (text.includes(needle)) files.push(file)
  }
  return files.sort()
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

/**
 * 大徽章的消费点：容器 scss 类名 → 设计尺寸（高度压在昵称字号之下）；新增必须登记。
 *
 * `places` 是**该 tsx 里 `<Image>` 的个数**（同一文件两处共用一套尺寸时合并成一条，
 * 例如 TA 主页的导航标题与页头昵称行）。按 tsx 汇总后与源码里 `BADGE.verified` 的
 * 出现次数对齐 —— 少换一处（#563 那种「只换页头、漏掉导航标题」）会直接转红。
 */
const BADGE_DISPLAY = [
  {
    tsx: 'pages/profile/index.tsx',
    scss: 'pages/profile/index.scss',
    cls: 'profile__auth-badge',
    width: 87,
    height: 34,
    places: 1,
  },
  {
    tsx: 'components/order-list/index.tsx',
    scss: 'components/order-list/index.scss',
    cls: 'orders__vbadge',
    width: 61,
    height: 24,
    places: 1,
  },
  {
    tsx: 'pkg-browse/pages/listing-detail/index.tsx',
    scss: 'pkg-browse/pages/listing-detail/index.scss',
    cls: 'detail__stick',
    width: 61,
    height: 24,
    places: 1,
  },
  {
    // 认证页「徽章展示位置」说明卡：它教用户徽章长什么样，必须与真实渲染同资产同尺寸
    tsx: 'pkg-auth/pages/verify/index.tsx',
    scss: 'pkg-auth/pages/verify/index.scss',
    cls: 'verify__badge',
    width: 87,
    height: 34,
    places: 1,
  },
  {
    tsx: 'pkg-auth/pages/verify/index.tsx',
    scss: 'pkg-auth/pages/verify/index.scss',
    cls: 'verify__badge-inline',
    width: 61,
    height: 24,
    places: 1,
  },
  {
    // #563 起：商品卡（首页 / 搜索 / 相关推荐 / 识图结果共用的卖家行）
    tsx: 'components/product-card/index.tsx',
    scss: 'components/product-card/index.scss',
    cls: 'pcard__tick',
    width: 61,
    height: 24,
    places: 1,
  },
  {
    tsx: 'pkg-browse/pages/favorites/index.tsx',
    scss: 'pkg-browse/pages/favorites/index.scss',
    cls: 'fav__tick',
    width: 61,
    height: 24,
    places: 1,
  },
  {
    tsx: 'pkg-browse/pages/following/index.tsx',
    scss: 'pkg-browse/pages/following/index.scss',
    cls: 'fw__tick',
    width: 61,
    height: 24,
    places: 1,
  },
  {
    // 两处：导航居中标题（`.uhome__badge-ic--nav`）与页头昵称行，共用同一个尺寸类
    tsx: 'pkg-browse/pages/user/index.tsx',
    scss: 'pkg-browse/pages/user/index.scss',
    cls: 'uhome__badge-ic',
    width: 61,
    height: 24,
    places: 2,
  },
  {
    tsx: 'pkg-browse/pages/watchers/index.tsx',
    scss: 'pkg-browse/pages/watchers/index.scss',
    cls: 'wt__badge-ic',
    width: 61,
    height: 24,
    places: 1,
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

  test('大徽章的消费点白名单：只有已登记的消费点，新增必须显式登记', async () => {
    // 两种写法都算消费：`BADGE.verified` 与 `BADGE['verified']`。
    // 判据是「代码里出现该字面量」—— `consumersOf` 内部已 `stripComments`，所以注释里
    // 可以正常提及（例如 `features/following/load.ts` 的字段说明），不会被计成消费点。
    const viaDot = await consumersOf('BADGE.verified')
    const viaIndex = await consumersOf("BADGE['verified']")
    expect([...new Set([...viaDot, ...viaIndex])].sort()).toEqual(
      [...new Set(BADGE_DISPLAY.map((e) => e.tsx))].sort(),
    )
    // 绕过出口直连 png：扫**内容**且覆盖 ts/tsx/scss（`consumersOf` 只 glob ts/tsx，
    // 拿它扫 `.png` 是空转的；过滤文件路径也拦不住，本意是过滤内容）。唯一合法引用点是出口自己。
    expect(await filesMentioning('verified-badge@3x.png')).toEqual(['assets/badge/index.ts'])
  })

  test('大徽章的每个 <Image> 都是 aspectFit（比例正确但 mode 写错一样会拉伸）', async () => {
    for (const tsx of [...new Set(BADGE_DISPLAY.map((e) => e.tsx))]) {
      const text = stripComments(await source(tsx))
      const tails = text.split('BADGE.verified').slice(1)
      expect({ tsx, consumed: tails.length > 0 }).toEqual({ tsx, consumed: true })
      for (const tail of tails) {
        const tag = tail.slice(0, tail.indexOf('>'))
        expect({ tsx, aspectFit: tag.includes('mode="aspectFit"') }).toEqual({
          tsx,
          aspectFit: true,
        })
      }
    }
  })

  test('每个登记的消费位都真在用它（按 tsx 汇总 `places`，user 页两处缺一即红）', async () => {
    const expected = new Map<string, number>()
    for (const entry of BADGE_DISPLAY) {
      expected.set(entry.tsx, (expected.get(entry.tsx) ?? 0) + entry.places)
    }
    for (const [tsx, places] of expected) {
      const text = stripComments(await source(tsx))
      expect({ tsx, places: text.split('BADGE.verified').length - 1 }).toEqual({ tsx, places })
    }
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

describe('认证标识形态契约（#563 起：列表 / 卡片一律大徽章，仅设置页头像角标保留小图标）', () => {
  test('「我的」页：已认证渲染设计稿徽章，且徽章与未认证胶囊都可点进认证页', async () => {
    const text = await source('pages/profile/index.tsx')
    const verifiedBranch = slice(text, '{verified ? (', ') : (')
    expect(verifiedBranch).not.toBe('')
    expect(verifiedBranch).toContain('BADGE.verified')
    expect(verifiedBranch).toContain('profile__auth-badge')
    expect(verifiedBranch).toContain('onClick={openVerify}')
    // 未认证分支：锚在胶囊元素自身（以前用「文案前 400 字符」的窗口，会读到已认证徽章的
    // onClick，于是删掉胶囊自己的 onClick 也全绿）
    const unverified = slice(text, '<View className="profile__auth"', '</View>')
    expect(unverified).not.toBe('')
    expect(unverified).toContain('未认证，前往认证')
    expect(unverified).toContain('onClick={openVerify}')
  })

  test('「我的」页：徽章在昵称行之外（昵称下方单独一行）', async () => {
    const text = await source('pages/profile/index.tsx')
    // 取 name-row（到其后**第一个** `</View>` 为止；当前 name-row 内只有自闭合的 <Image/>，
    // 所以第一个 `</View>` 就是它自己的；若将来 name-row 里出现嵌套 View，这里会变窄，需改正向断言）
    const nameRow = slice(text, 'className="profile__name-row"', '</View>')
    expect(nameRow).not.toBe('')
    expect(nameRow).not.toContain('{verified ? (')
    expect(nameRow).not.toContain('profile__auth-badge')
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
    // 只盯 `.orders__vbadge::after` 会被「另挂一个类名 / 嵌在规则内」绕过：整个文件不许再出现
    // 任何伪元素，也不许再出现旧的角标类名（历史上那套 CSS 手绘圆勾就是这两个特征）
    expect(scss).not.toContain('::after')
    expect(scss).not.toContain('::before')
    expect(scss).not.toContain('orders__av-badge')
  })

  test('旧档小图标（verifiedBrand）只剩设置页头像角标：新增必须显式登记', async () => {
    // 列表 / 卡片 / 昵称行一律走大徽章 `BADGE.verified`（#563）。设置页那个 40×40 的
    // 头像角标位塞不进横向成品图，Owner 决定本票不碰；其余任何新的小图标消费点都要
    // 先回到这条白名单上讨论。
    expect(await consumersOf('ICONS.verifiedBrand')).toEqual(['pkg-auth/pages/settings/index.tsx'])
  })

  test('胶囊外壳与白写字不许回流（watchers / TA 主页）：成品图自带「认证」字样，再叠一层就是两层装饰', async () => {
    // 光靠「`BADGE.verified` 出现次数 + 尺寸比例」挡不住结构性回退：把「胶囊 + 小勾 + 已认证」
    // 外壳**加回去**并不会改动徽章节点本身，数量与尺寸都不变（对抗性审查变异 M7 实测：加回外壳
    // 后 11 pass / 3 fail，与干净基线完全一致，零转红）。所以这里立否定断言，钉死外壳类名与
    // 白写文案都不许再出现 —— 与 #534 对订单卡「不许再有手绘圆勾」用的是同一套写法。
    const shells = [
      {
        tsx: 'pkg-browse/pages/watchers/index.tsx',
        scss: 'pkg-browse/pages/watchers/index.scss',
        shell: 'wt__badge',
      },
      {
        tsx: 'pkg-browse/pages/user/index.tsx',
        scss: 'pkg-browse/pages/user/index.scss',
        shell: 'uhome__badge',
      },
    ] as const
    for (const { tsx, scss, shell } of shells) {
      const text = stripComments(await source(tsx))
      const classes = classTokens(text)
      // `<外壳>-ic`（成品图节点）是合法的；非法的是裸外壳类名与它的 `--nav` 修饰符
      expect({
        tsx,
        shells: classes.filter((c) => c === shell || c.startsWith(`${shell}--`)),
      }).toEqual({ tsx, shells: [] })
      expect({ tsx, label: text.includes('已认证') }).toEqual({ tsx, label: false })
      // 样式侧同理：外壳规则整块删掉，不留死样式给下一个人「复活」用
      const style = stripComments(await source(scss))
      expect({
        scss,
        dead: [`.${shell} {`, `.${shell}--`].filter((needle) => style.includes(needle)),
      }).toEqual({ scss, dead: [] })
    }
  })

  test('类名判据认得出模板字面量与不带白写文案的外壳（判据自身的回归用例）', () => {
    // 只认 `className="…"` 双引号形态时，`className={`wt__badge`}` 且不带文案会静默通过
    // （另一条「不许出现 已认证」兜不住它），所以判据改成扫所有字符串 / 模板串字面量。
    const flagged = (src: string) =>
      classTokens(stripComments(src)).filter(
        (c) => c === 'wt__badge' || c.startsWith('wt__badge--'),
      )
    expect(flagged('<Image className={`wt__badge`} />')).toEqual(['wt__badge'])
    expect(flagged('<View className="wt__badge" />')).toEqual(['wt__badge'])
    expect(flagged("<View className='wt__badge--nav' />")).toEqual(['wt__badge--nav'])
    expect(flagged('{/* 说明里的 wt__badge 不算 */}')).toEqual([])
    // 合法的成品图节点与无关注释都不该被误伤
    expect(flagged('<Image className="wt__badge-ic" />')).toEqual([])
    expect(flagged('// 以前是 wt__badge 外壳\n<Image className="wt__badge-ic" />')).toEqual([])
  })

  test('checkMuted（灰勾）已无消费点，也不再由生成器产出', async () => {
    expect(await consumersOf('ICONS.checkMuted')).toEqual([])
    expect(Object.keys(ICONS)).not.toContain('checkMuted')
    expect(readdirSync(new URL('assets/lib-icons', SRC))).not.toContain('check-muted@3x.png')
    // 生成器真源：manifest 里 `check` 不许再有 muted 色调（否则下次 `icons` 会把它产回来；
    // 以前只靠 lib-icons.test.ts 跨文件代偿，本文件这条标题承诺其实没生效）
    expect(MANIFEST.check).not.toContain('muted')
  })
})

/**
 * #675：商品详情底部操作栏「立即购买」的图标语义。
 *
 * 现象：该钮画的是心形（修前是 `ICONS.heartFillBrand`），与同屏左侧收藏钮 `.detail__fav`
 * 的 `heartMuted` / `heartFillBrand` 共用同一符号 —— 「购买」这种不可逆动作被配上
 * 「喜欢 / 收藏」语义，会被读成「加入收藏」。
 *
 * 本仓 `apps/miniapp/tests/` 没有 Taro 组件渲染基建（页面加载真 `@tarojs/taro` 会抛
 * `ENABLE_INNER_HTML is not defined`，见 `tests/conversation-unread-wiring.test.ts` 文件头），
 * 页面接线只能读源码文本钉住 —— 手法同 `tests/conversation-tx-bar-wiring.test.ts`。
 *
 * 钉三件事：
 * 1. 「立即购买」钮的图标是 cart 字形，出现 heart 一律算回归；
 * 2. 收藏钮继续是 heart 字形 —— 心形只留给收藏，两处不互相借用；
 * 3. 该钮是浅底 `.detail__btn--ghost`（`background: var(--surface)`），所以图标取 fg 语义色
 *    `cartFg`。若哪天它改回品牌实底 `.detail__btn--solid`（`background: var(--grad-brand)` +
 *    `color: #fff`），这里会红，提醒换反白色 —— 深色字形压在品牌渐变上会发暗。
 */
import { describe, expect, test } from 'bun:test'

const PAGE = new URL('../src/pkg-browse/pages/listing-detail/index.tsx', import.meta.url)

/** 剥掉注释再断言：注释里留一份同名语句不能冒充实现（先例 `back-top-scroll-source.test.ts`）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
}

async function pageSource(): Promise<string> {
  return stripComments(await Bun.file(PAGE).text()).replace(/\s+/g, ' ')
}

/** 取 `from` 到其后第一次出现的 `to`（含 `to`）之间的片段。 */
function between(code: string, from: string, to: string): string {
  const start = code.indexOf(from)
  expect(start, `页面里应出现 ${from}`).toBeGreaterThanOrEqual(0)
  const end = code.indexOf(to, start)
  expect(end, `${to} 应出现在 ${from} 之后`).toBeGreaterThanOrEqual(0)
  return code.slice(start, end + to.length)
}

/**
 * 买家形态「立即购买」钮那一段：从它的 className（带 `${` 的 ghost 变体，与卖家「管理」钮的
 * 静态 `detail__btn--ghost"` 区分开）到文案 `<Text>`。
 */
const buyBlock = async () =>
  between(await pageSource(), 'detail__btn detail__btn--ghost${', "'立即购买'")

describe('商品详情底栏「立即购买」的图标语义（#675）', () => {
  test('购买钮用购物车图标，不再借用 heart', async () => {
    const block = await buyBlock()
    expect(block).toContain('src={ICONS.cartFg}')
    expect(block).not.toMatch(/heart/i)
  })

  test('购买钮是浅底 ghost，图标据此取深色语义色（反白只在品牌实底上成立）', async () => {
    const block = await buyBlock()
    const icon = /src=\{ICONS\.(\w+)\}/.exec(block)?.[1]
    expect(icon, '购买钮应有图标').toBeString()
    // 现在是浅底 ghost：反白字形会白压白、直接消失。若哪天改回品牌实底（`color: #fff` +
    // 品牌渐变），下面两条立刻红 —— 那时才该换成反白色。
    // 不断言 `block` 含 `detail__btn--ghost`：`buyBlock()` 的切点就是它，那样是恒真断言。
    expect(block).not.toContain('detail__btn--solid')
    expect(icon).not.toMatch(/White$/)
  })

  test('收藏钮继续是 heart —— 心形只留给收藏，两处不互相借用', async () => {
    expect(await pageSource()).toContain('src={faved ? ICONS.heartFillBrand : ICONS.heartMuted}')
  })
})

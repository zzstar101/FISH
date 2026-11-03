import { describe, expect, test } from 'bun:test'
import { outOfMarketLabel } from '../src/features/listing/status-mark'

/**
 * 已售 / 已下架商品卡的标记文案与接线（#566）。
 *
 * 文案与「哪些状态算已出局」是纯函数，直接测；两处卡片的形态（灰罩、状态角标、文字置灰）
 * 分两层读源码钉住：`.tsx` 管**接的哪份数据**、`.scss` 管**视觉真的在**——只读 `.tsx` 时
 * 删掉整段灰罩样式也照样全绿（#575 复审 M1 的实测结论）。仓库没有 Taro 组件渲染基建，
 * 读源码的先例见 `comments-wiring.test.ts` / `user-list-end.test.ts`。
 *
 * 置灰断言按**选择器块**钉（#575 复审 L4）：只断言文件里出现过 `color: var(--muted);`，
 * 同文件别的规则（`.pcard__want`）就能满足它；把 `.pcard--out .pcard__who` 改名成
 * `.pcard__whoGONE` 也照样全绿 —— 那正是要防的「置灰悄悄掉了」。
 *
 * 钉的三条都是最容易在重构里悄悄丢掉的：
 *
 * 1. **`RESERVED` 不算已出局**：它只是「有人拍下、还没成交」，盖上灰罩等于告诉人卖掉了；
 * 2. **角标二选一**：状态角标与「0 元送 / 急出」必须互斥 —— 同一角上叠两个徽标会互相压字；
 * 3. **角标文案来自函数返回值**：硬编码成字面量就等于多出第二个来源。
 */
describe('outOfMarketLabel —— 哪些状态要打「已出局」标记', () => {
  test('已售出 / 已下架各自给一句', () => {
    expect(outOfMarketLabel('SOLD')).toBe('卖掉了')
    expect(outOfMarketLabel('OFFLINE')).toBe('下架了')
  })

  test('在售与待成交不打标记（`RESERVED` 只是有人拍下，仍在售卖流程里）', () => {
    expect(outOfMarketLabel('ACTIVE')).toBeNull()
    expect(outOfMarketLabel('RESERVED')).toBeNull()
  })
})

async function read(relative: string): Promise<string> {
  return Bun.file(new URL(relative, import.meta.url)).text()
}

/** 把源码里的换行与缩进压成单空格，便于对整条选择器 + 声明的**形状**断言。 */
function flatten(code: string): string {
  return code.replace(/\s+/g, ' ')
}

describe('卡片接线 —— 灰罩 / 状态角标 / 文字置灰', () => {
  test('共享卡片：已出局时压灰罩、换状态角标（与「0 元送 / 急出」二选一）', async () => {
    const code = await read('../src/components/product-card/index.tsx')

    expect(code).toContain('outOfMarketLabel(listing.status)')
    expect(code).toContain('pcard pcard--out')
    expect(code).toContain('className="pcard__shade"')
    // 角标文案必须来自 `outLabel`，不能是写死的字面量
    expect(code).toContain('<Text className="pcard__mark">{outLabel}</Text>')
    // 状态角标在前、badge 落在 else 分支：两者不会同时渲染
    expect(code).toContain(': listing.badge ? (')
  })

  test('共享卡片的样式：中性遮罩令牌、文字置灰、成色印章改走中性轮廓', async () => {
    const scss = await read('../src/components/product-card/index.scss')

    // 压暗走 `--scrim-cover`（票面的「50% 灰」= 中性压暗），罩层不吃点击
    expect(scss).toContain('.pcard__shade {')
    expect(scss).toContain('background: var(--scrim-cover);')
    expect(scss).toContain('pointer-events: none;')
    // 文字置灰：五枚文字的选择器与颜色写在**同一条规则**里，少一枚就红
    expect(flatten(scss)).toContain(
      '.pcard--out .pcard__title, .pcard--out .pcard__cond, .pcard--out .pcard__price, ' +
        '.pcard--out .pcard__want, .pcard--out .pcard__who { color: var(--muted); }',
    )
    // 成色印章自带青色印底，只置灰字会得到「灰字压青底」；中性轮廓（透明底 + 描边 + 灰字）
    expect(flatten(scss)).toContain(
      '.pcard--out .pcard__cond { background: transparent; border: 1px solid var(--line); ' +
        'color: var(--muted); }',
    )
  })

  test('他人主页自绘卡：同一套形态（状态角标压过 free / hot）', async () => {
    const code = await read('../src/pkg-browse/pages/user/index.tsx')

    expect(code).toContain('outOfMarketLabel(item.status)')
    expect(code).toContain('uhome__card uhome__card--out')
    expect(code).toContain('className="uhome__shade"')
    expect(code).toContain('<Text className="uhome__corner uhome__corner--out">{outLabel}</Text>')
    // 灰罩挂在图片占位里，不参与布局（`uhome__img` 的高度是定值）
    expect(code).toContain(': item.free ? (')
  })

  test('他人主页自绘卡的样式：同一枚遮罩令牌 + 文字置灰', async () => {
    const scss = await read('../src/pkg-browse/pages/user/index.scss')

    expect(scss).toContain('.uhome__shade {')
    expect(scss).toContain('background: var(--scrim-cover);')
    expect(scss).toContain('.uhome__corner--out {')
    // 五枚文字的选择器与颜色同一条规则（改名 / 删一枚都红，见文件头 L4 的说明）
    expect(flatten(scss)).toContain(
      '.uhome__card--out .uhome__ptitle, .uhome__card--out .uhome__pprice, ' +
        '.uhome__card--out .uhome__porig, .uhome__card--out .uhome__pwant, ' +
        '.uhome__card--out .uhome__ptime { color: var(--muted); }',
    )
  })
})

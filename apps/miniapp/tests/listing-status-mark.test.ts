import { describe, expect, test } from 'bun:test'
import { outOfMarketLabel } from '../src/features/listing/status-mark'

/**
 * 已售 / 已下架商品卡的标记文案与接线（#566）。
 *
 * 文案与「哪些状态算已出局」是纯函数，直接测；三处形态（共享卡片的灰罩 + 角标 + 文字置灰、
 * 他人主页自绘卡的同一套）只能读源码文本钉住 —— 仓库没有 Taro 组件渲染基建，
 * 先例见 `comments-wiring.test.ts` / `user-list-end.test.ts`。
 *
 * 钉的两条都是最容易在重构里悄悄丢掉的：
 *
 * 1. **`RESERVED` 不算已出局**：它只是「有人拍下、还没成交」，盖上灰罩等于告诉人卖掉了；
 * 2. **角标二选一**：状态角标与「0 元送 / 急出」必须互斥 —— 同一角上叠两个徽标会互相压字。
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

describe('卡片接线 —— 灰罩 / 状态角标 / 文字置灰', () => {
  test('共享卡片：已出局时压灰罩、换状态角标（与「0 元送 / 急出」二选一）', async () => {
    const code = await read('../src/components/product-card/index.tsx')

    expect(code).toContain('outOfMarketLabel(listing.status)')
    expect(code).toContain('pcard pcard--out')
    expect(code).toContain('className="pcard__shade"')
    expect(code).toContain('className="pcard__mark"')
    // 状态角标在前、badge 落在 else 分支：两者不会同时渲染
    expect(code).toContain(': listing.badge ? (')
  })

  test('他人主页自绘卡：同一套形态（状态角标压过 free / hot）', async () => {
    const code = await read('../src/pkg-browse/pages/user/index.tsx')

    expect(code).toContain('outOfMarketLabel(item.status)')
    expect(code).toContain('uhome__card uhome__card--out')
    expect(code).toContain('className="uhome__shade"')
    expect(code).toContain('uhome__corner--out')
    // 灰罩挂在图片占位里，不参与布局（`uhome__img` 的高度是定值）
    expect(code).toContain(': item.free ? (')
  })
})

import { describe, expect, test } from 'bun:test'

/**
 * 「已认证」徽章的**形态契约**（#534 防回归）。
 *
 * 被钉的事实：端上同一语义只允许一种形态 —— `ICONS.verifiedAccent`。历史上漂过三次：
 * 「我的」页只有纯文字、商品详情卖家位用中性灰勾 `checkMuted`、订单卡用 CSS 手绘蓝圆勾。
 * 这类漂移 lint / typecheck / 功能单测全绿，只有人眼能看出来，所以按本仓既有手法
 * （`order-list-state.test.ts` 的源码字符串断言）钉住调用点。
 */
const SRC = new URL('../src/', import.meta.url)

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

describe('认证徽章形态契约（#534：唯一形态 = verifiedAccent）', () => {
  test('「我的」页：已认证渲染「认证」3D 徽章（verifiedBadge），未认证仍是文字胶囊', async () => {
    const text = await source('pages/profile/index.tsx')
    const verifiedBranch = slice(text, '{verified ? (', 'profile__auth-txt')
    expect(verifiedBranch).not.toBe('')
    expect(verifiedBranch).toContain('ICONS.verifiedBadge')
    expect(verifiedBranch).toContain('profile__auth-badge')
    // 未认证分支保持引导胶囊（同一个 ternary 的 else 侧）
    expect(text).toContain('未认证，前往认证')
  })

  test('商品详情卖家位：已验证用设计稿「认证」徽章（verifiedBadge），不再用灰勾 checkMuted', async () => {
    const block = slice(
      await source('pkg-browse/pages/listing-detail/index.tsx'),
      "data.seller.authStatus === 'VERIFIED'",
      ') : null}',
    )
    expect(block).not.toBe('')
    expect(block).toContain('ICONS.verifiedBadge')
    expect(block).not.toContain('checkMuted')
  })

  test('订单卡：已认证徽章用设计稿「认证」图（verifiedBadge），不再是 CSS 手绘勾', async () => {
    const block = slice(
      await source('components/order-list/index.tsx'),
      'item.counterpart.verified',
      '/>',
    )
    expect(block).not.toBe('')
    expect(block).toContain('ICONS.verifiedBadge')
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

  test('checkMuted 在 miniapp 已无消费点（避免第二种形态回流）', async () => {
    const glob = new Bun.Glob('**/*.tsx')
    const consumers: string[] = []
    for await (const file of glob.scan({ cwd: SRC.pathname })) {
      const text = await Bun.file(new URL(file, SRC)).text()
      if (text.includes('ICONS.checkMuted')) consumers.push(file)
    }
    expect(consumers).toEqual([])
  })
})

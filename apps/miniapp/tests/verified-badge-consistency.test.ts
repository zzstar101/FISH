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
  test('「我的」页认证胶囊：已认证渲染 verifiedAccent 徽章', async () => {
    const block = slice(
      await source('pages/profile/index.tsx'),
      'className="profile__auth"',
      '</View>',
    )
    expect(block).not.toBe('')
    expect(block).toContain('{verified ?')
    expect(block).toContain('ICONS.verifiedAccent')
    expect(block).toContain('profile__auth-badge')
  })

  test('商品详情卖家位：已验证用 verifiedAccent，不再用灰勾 checkMuted', async () => {
    const block = slice(
      await source('pkg-browse/pages/listing-detail/index.tsx'),
      "data.seller.authStatus === 'VERIFIED'",
      ') : null}',
    )
    expect(block).not.toBe('')
    expect(block).toContain('ICONS.verifiedAccent')
    expect(block).not.toContain('checkMuted')
  })

  test('订单卡：已认证角标用 verifiedAccent 图片，不是 CSS 手绘勾', async () => {
    const block = slice(
      await source('components/order-list/index.tsx'),
      'item.counterpart.verified',
      '/>',
    )
    expect(block).not.toBe('')
    expect(block).toContain('ICONS.verifiedAccent')
    expect(block).toContain('orders__av-badge')
  })

  test('订单卡样式：不再自绘圆底与伪元素勾（交给徽章资产）', async () => {
    const scss = await source('components/order-list/index.scss')
    const start = scss.indexOf('.orders__av-badge {')
    expect(start).toBeGreaterThan(-1)
    const block = scss.slice(start, scss.indexOf('}', start))
    expect(block).not.toContain('border-radius')
    expect(block).not.toContain('background')
    expect(scss).not.toContain('.orders__av-badge::after')
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

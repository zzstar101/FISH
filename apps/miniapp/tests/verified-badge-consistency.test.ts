import { describe, expect, test } from 'bun:test'

/**
 * 认证标识的**两档形态契约**（#534）。
 *
 * 端上「已认证」只用两种视觉，按容器场景分档，**不允许第三种形态回流**：
 * 1. **大徽章 `verifiedBadge`**（设计稿「认证」3D 徽章，昵称行）：我的页、商品详情卖家行、订单卡昵称右侧；
 * 2. **小图标 `verifiedAccent`**（头像角标 / 列表小勾 / 认证页等小尺寸位）：
 *    product-card、settings、verify、user 主页、following、favorites、watchers。
 *
 * 历史上漂过的三种形态：「我的」页纯文字无图标、商品详情卖家位用中性灰勾 `checkMuted`、
 * 订单卡用 CSS 手绘蓝圆勾。这类漂移 lint / typecheck / 功能单测全绿，只有人眼能看出来，
 * 所以按本仓既有手法（`order-list-state.test.ts` 的源码字符串断言）钉住调用点。
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

describe('认证标识形态契约（#534：昵称行大徽章 + 小尺寸小图标两档）', () => {
  test('「我的」页：已认证渲染设计稿徽章，且徽章与未认证胶囊都可点进认证页', async () => {
    const text = await source('pages/profile/index.tsx')
    const verifiedBranch = slice(text, '{verified ? (', ') : (')
    expect(verifiedBranch).not.toBe('')
    expect(verifiedBranch).toContain('ICONS.verifiedBadge')
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
    expect(block).toContain('ICONS.verifiedBadge')
    expect(block).not.toContain('checkMuted')
  })

  test('订单卡：已认证徽章用设计稿「认证」图，不再是 CSS 手绘勾', async () => {
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

  test('小图标档（verifiedAccent）消费点是白名单：新增必须显式登记', async () => {
    const glob = new Bun.Glob('**/*.{ts,tsx}')
    const consumers: string[] = []
    for await (const file of glob.scan({ cwd: SRC.pathname })) {
      const text = await Bun.file(new URL(file, SRC)).text()
      if (text.includes('ICONS.verifiedAccent')) consumers.push(file)
    }
    // 头像角标 / 列表小勾 / 认证页等小尺寸位；昵称行一律走大徽章 verifiedBadge
    expect(consumers.sort()).toEqual([
      'components/product-card/index.tsx',
      'pkg-auth/pages/settings/index.tsx',
      'pkg-auth/pages/verify/index.tsx',
      'pkg-browse/pages/favorites/index.tsx',
      'pkg-browse/pages/following/index.tsx',
      'pkg-browse/pages/user/index.tsx',
      'pkg-browse/pages/watchers/index.tsx',
    ])
  })

  test('checkMuted（灰勾）在认证相关消费点已无使用', async () => {
    const glob = new Bun.Glob('**/*.{ts,tsx}')
    const consumers: string[] = []
    for await (const file of glob.scan({ cwd: SRC.pathname })) {
      const text = await Bun.file(new URL(file, SRC)).text()
      if (text.includes('ICONS.checkMuted')) consumers.push(file)
    }
    expect(consumers).toEqual([])
  })
})

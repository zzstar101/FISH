/**
 * 「想要的人」页**行内动作**的接线层回归。
 *
 * 仓库没有 Taro 组件渲染基建，页面级行为只能读源码文本钉住（同
 * `tests/following-wiring.test.ts`）。这里钉两条：
 *
 * 1. **点一行就打开该买家与这件商品的会话**。契约 `chatWatchersResponseSchema.items[]`
 *    带 `conversationId`（一人一条，服务端按 `(listing_id, buyer_id)` 唯一），页面必须
 *    用它拼 `/pkg-social/pages/conversation/index?id=cnv_…` —— 不能去猜、也不能按
 *    「商品 + 买家」再拉一次列表找 id。
 * 2. **动作钮不挂第二个 handler**：点区在整行，钮只做视觉提示。两个 handler 做同一件事时，
 *    点在钮上会触发两次 `navigateTo`（小程序允许同一路由叠两层，用户要连按两次返回）。
 */
import { describe, expect, test } from 'bun:test'

async function source(): Promise<string> {
  return Bun.file(new URL('../src/pkg-browse/pages/watchers/index.tsx', import.meta.url)).text()
}

describe('想要的人：行内动作 → 该买家的会话', () => {
  test('行上带 conversationId 并跳会话页', async () => {
    const code = await source()

    // 解构出契约字段（缺了它就说明页面还在用旧形状）
    expect(code).toContain('conversationId')
    // 跳转目标是小程序的会话页，参数就是契约给的会话 id。断言的是**模板串的字面文本**
    // （`${conversationId}` 是页面源码里那一段，不是本文件要插值）。
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 断言对象是页面源码里的字面量 `${...}` 文本
    expect(code).toContain('/pkg-social/pages/conversation/index?id=${conversationId}')
  })

  test('动作钮不重复挂 handler（点区只在整行）', async () => {
    const code = await source()

    const rowStart = code.indexOf('className="wt__row"')
    expect(rowStart).toBeGreaterThanOrEqual(0)
    const actionStart = code.indexOf('className="wt__act"', rowStart)
    expect(actionStart).toBeGreaterThanOrEqual(0)
    const actionEnd = code.indexOf('</View>', actionStart)
    const actionBlock = code.slice(actionStart, actionEnd)

    expect(actionBlock).not.toContain('onClick')
    expect(actionBlock).not.toContain('navigateTo')
  })
})

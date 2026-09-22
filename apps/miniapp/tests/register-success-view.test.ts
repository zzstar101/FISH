import { describe, expect, test } from 'bun:test'
import { registerSuccessView } from '../src/pages/register-success/view'

/**
 * 注册成功页「认证状态 → 文案 + 主按钮出口」的映射（#177 审查收口）。
 *
 * 这一页有一个**防御性**的已认证分支。上一轮审查卡住的就是它：页面一边渲染
 * 「已认证 · 校园身份已核验」，一边把主按钮写成「去校园认证」——同一屏自相矛盾。
 * 这里把该分支的四处文案逐条锁成**正向断言**：黑名单式断言（`not.toContain('去认证')`）
 * 挡不住改写，例如脚注写成「如需修改认证邮箱，请前往校园认证页」就绕得过去。
 *
 * 覆盖分两层：映射函数（下面的 describe）与**页面是否真的用它渲染**（最后一个 describe
 * 直接读 `index.tsx` 源码，同 `apps/web/src/profile-verification.test.ts` 的先例）。
 * 只测映射是不够的 —— 实测把页面改回硬编码 `去校园认证`，纯函数用例全绿。
 */
describe('registerSuccessView —— 未认证分支', () => {
  const view = registerSuccessView(false)

  test('描述拆成前缀 + 加重的「未认证」，胶囊是 warn 文案且不带 ok 配色', () => {
    expect(view.desc).toBe('账号已创建并自动登录。当前状态为')
    expect(view.emphasis).toBe('未认证')
    expect(view.badge).toBe('未认证 · 待完成校园认证')
    expect(view.ok).toBe(false)
  })

  test('主按钮请用户去认证，脚注指向「我的 → 校园认证」', () => {
    expect(view.primaryCta).toBe('去校园认证')
    expect(view.note).toBe('也可以稍后在「我的 → 校园认证」完成')
  })
})

describe('registerSuccessView —— 已认证分支（防御性）', () => {
  const view = registerSuccessView(true)

  test('描述、胶囊一律按已认证渲染，加粗词换成「已认证」并切 ok 配色', () => {
    expect(view.desc).toBe('账号已创建并自动登录。当前状态为')
    expect(view.emphasis).toBe('已认证')
    expect(view.badge).toBe('已认证 · 校园身份已核验')
    expect(view.ok).toBe(true)
  })

  test('主按钮不是「去校园认证」—— 与本页「已认证」徽章并存会自相矛盾', () => {
    expect(view.primaryCta).not.toBe(registerSuccessView(false).primaryCta)
    expect(view.primaryCta).not.toContain('去校园认证')
    expect(view.primaryCta).toBe('查看认证状态')
  })

  test('脚注只陈述现状：不导向「去认证 / 去完成」，也不暗示可自助解除认证 / 更换邮箱', () => {
    // 未认证分支那句「稍后去完成认证」对已认证用户同样不成立，必须逐字换掉
    expect(view.note).not.toBe(registerSuccessView(false).note)
    expect(view.note).toBe('认证信息可在「我的 → 校园认证」查看')
  })
})

/**
 * 页面接线：把 `view.*` 真正渲染出去，且不再有硬编码的「去校园认证」文本。
 *
 * 为什么要读源码：本仓 `tests/` 没有 Taro 组件渲染基建，纯函数用例锁不住 JSX。
 * 只断言「源码里出现过 `view.primaryCta`」会被注释里的同名文字骗过，所以再加一条
 * 「JSX 文本节点里不许出现 `去校园认证`」——它正是上一轮审查点名的那个矛盾。
 */
describe('register-success 页面接线', () => {
  const source = Bun.file(
    new URL('../src/pages/register-success/index.tsx', import.meta.url),
  ).text()

  test('主按钮与脚注取自 view，不是硬编码', async () => {
    const code = await source
    expect(code).toContain('{view.primaryCta}')
    expect(code).toContain('{view.note}')
    // 认证状态必须来自真实登录态，且方向不能反（`!== 'VERIFIED'` 会把两个分支整体换掉）
    expect(code).toContain("registerSuccessView(user?.authStatus === 'VERIFIED')")
  })

  test('JSX 文本节点里没有「去校园认证」这个字面量（注释里可以有）', async () => {
    const code = await source
    expect(code).not.toMatch(/>\s*去校园认证\s*</)
    // 页面不再自己判一次认证状态去选配色，改由 view.ok 提供
    expect(code).not.toMatch(/rs__badge.*authStatus/)
  })
})

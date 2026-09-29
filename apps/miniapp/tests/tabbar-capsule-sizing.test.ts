import { describe, expect, test } from 'bun:test'

/**
 * 底栏选中胶囊的**样式契约**（#321 复审 blocker 的防回归）。
 *
 * 胶囊的定位是「全显式 rpx」：槽宽 = 内容区 654rpx / 5 = 130.8rpx，胶囊 `width`
 * 必须与之严格相等、且按 **border-box** 计算外宽 —— 本组件在页面 `.page` 盒子之外，
 * `app.scss` 那条只给 `.page` 的 border-box reset 覆盖不到这里；一旦哪天改边框
 * （加粗 / 换成 outline 之外的真实描边）忘掉 box-sizing，外宽就会超过槽位、
 * 逐槽累积水平漂移，最后几槽肉眼可见地错位（编译期与功能测试都拦不住）。
 *
 * 本仓 `tests/` 没有 WXSS 渲染基建，只能读样式源码钉住（先例
 * `tests/back-top-scroll-source.test.ts`）：切到 `.tabbar__capsule` 规则块断言，
 * 不查整份文件。
 */
async function tabbarStyle(): Promise<string> {
  return await Bun.file(new URL('../src/custom-tab-bar/index.scss', import.meta.url)).text()
}

/** 取 `from` 到其后第一个 `}` 之间的规则块（含 `from`，不含 `}`） */
function ruleBlock(source: string, selector: string): string {
  const start = source.indexOf(selector)
  if (start === -1) return ''
  return source.slice(start, source.indexOf('}', start))
}

describe('custom-tab-bar 胶囊样式契约', () => {
  test('.tabbar__capsule 必须显式 border-box（外宽不得超出 130.8rpx 槽位）', async () => {
    const block = ruleBlock(await tabbarStyle(), '.tabbar__capsule {')
    expect(block).not.toBe('')
    expect(block).toContain('width: 130.8rpx')
    expect(block).toContain('box-sizing: border-box')
  })

  test('.tabbar 内容区推导的槽宽常量与胶囊宽度一致（654/5）', async () => {
    const style = await tabbarStyle()
    // .tabbar 主体的 padding（左右各 16rpx）+ border（2rpx×2）决定内容区 654rpx；
    // 这两个值若被改动，130.8rpx 的槽宽与 tsx 里的 TAB_SLOT_RPX 都要同步重算
    const barBlock = ruleBlock(style, '.tabbar {')
    expect(barBlock).toContain('left: 30px')
    expect(barBlock).toContain('right: 30px')
    expect(barBlock).toContain('padding: 8px 16px 10px')
  })
})

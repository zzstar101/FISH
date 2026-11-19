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

/** 去掉注释再断言：注释里写出某个声明，本身既不能算契约满足、也不算被破坏 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * 取**全部**匹配该选择器的规则块（含 `@media` 内的同名块）。
 * 只取第一处会漏掉后置同名规则 —— 后置规则在层叠里能把值盖回来，
 * 这是实测过的假绿路径（追加一条 `.tabbar__capsule { backdrop-filter: … }` 后旧断言仍通过）。
 */
function ruleBlocks(source: string, selector: string): string[] {
  const clean = stripComments(source)
  const head = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`, 'g')
  const blocks: string[] = []
  for (const match of clean.matchAll(head)) {
    const start = match.index ?? 0
    const end = clean.indexOf('}', start)
    if (end === -1) break
    blocks.push(clean.slice(start, end))
  }
  return blocks
}

/** 取第一处规则块；不存在时返回空串 */
function ruleBlock(source: string, selector: string): string {
  return ruleBlocks(source, selector)[0] ?? ''
}

describe('custom-tab-bar 胶囊样式契约', () => {
  test('.tabbar__capsule 必须显式 border-box（外宽不得超出 130.8rpx 槽位）', async () => {
    const block = ruleBlock(await tabbarStyle(), '.tabbar__capsule')
    expect(block).not.toBe('')
    expect(block).toContain('width: 130.8rpx')
    expect(block).toContain('box-sizing: border-box')
  })

  test('.tabbar 内容区推导的槽宽常量与胶囊宽度一致（654/5）', async () => {
    const style = await tabbarStyle()
    // .tabbar 主体的 padding（左右各 16rpx）+ border（2rpx×2）决定内容区 654rpx；
    // 这两个值若被改动，130.8rpx 的槽宽与 tsx 里的 TAB_SLOT_RPX 都要同步重算
    const barBlock = ruleBlock(style, '.tabbar')
    expect(barBlock).toContain('left: 30px')
    expect(barBlock).toContain('right: 30px')
    expect(barBlock).toContain('padding: 8px 16px 10px')
  })

  /**
   * #686：胶囊叠在已经过一次 `glass-bar` 模糊的栏体上，再加一层实时背景模糊意味着
   * 切 Tab 时每次重绘都要对胶囊区域重新采样合成，模拟器与真机上都能感到切页卡顿。
   * A/B 只去掉这两条声明即恢复流畅，所以胶囊规则块内**不许再出现**实时背景滤镜。
   *
   * 断言遍历**所有**同名规则块并大小写不敏感：`-webkit-backdrop-filter` 与后置同名规则
   * 都算命中，否则改一处写法就能绕过。
   */
  test('.tabbar__capsule 不得带第二层实时背景模糊（#686 切页卡顿）', async () => {
    const blocks = ruleBlocks(await tabbarStyle(), '.tabbar__capsule')
    expect(blocks.length).toBeGreaterThan(0)
    for (const block of blocks) {
      expect(block).not.toMatch(/backdrop-filter\s*:/i)
    }
  })

  /**
   * 同一验收项的另一半（Issue「底栏悬浮玻璃外观保留」）：#686 只许去掉**胶囊**的第二层模糊，
   * 栏体自己的 `glass-bar` 必须留着 —— 哪天为省性能把外层也删了，胶囊就只剩 22% 白底，
   * 底栏不再是悬浮玻璃。
   */
  test('.tabbar 栏体仍走 glass-bar（外层玻璃不得被顺手移除）', async () => {
    const barBlock = ruleBlock(await tabbarStyle(), '.tabbar')
    expect(barBlock).not.toBe('')
    expect(barBlock).toContain('@include glass-bar')
  })
})

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

async function mixinsSource(): Promise<string> {
  return await Bun.file(new URL('../src/styles/_mixins.scss', import.meta.url)).text()
}

/**
 * 去掉 scss 注释（`/* *​/` 与 `//` 行注释），保留字符串字面量。
 *
 * 两种注释都要去：块里写一行 `// 旧的 backdrop-filter 已移除` 只是说明，
 * 既不能被当成「契约被破坏」，也不能被当成「契约满足」。
 */
function stripComments(source: string): string {
  let out = ''
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 1
      continue
    }
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i + 2)
      i = end === -1 ? source.length : end - 1
      continue
    }
    if (ch === '"' || ch === "'") {
      const quote = ch
      i += 1
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i += 1
        i += 1
      }
      out += quote
      if (i < source.length) out += quote
      continue
    }
    out += ch
  }
  return out
}

/** 从 `open`（指向 `{`）做花括号深度扫描，返回配对的 `}` 下标；不配对返回 -1 */
function matchingBrace(source: string, open: number): number {
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '"' || ch === "'") {
      const quote = ch
      i += 1
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i += 1
        i += 1
      }
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * 取**全部**匹配该选择器的规则体（含 `@media` 内的同名块、含嵌套规则的整块内容）。
 *
 * 三处都是实测过的坑，不能退回「indexOf 首个 `}`」那种写法：
 * - 只取第一处会漏掉后置同名规则 —— 后置规则在层叠里能把值盖回来（假绿）。
 * - 首个 `}` 会被块内嵌套规则（`&:active {}`）截断，截断点之后的声明就查不到了（假绿）。
 * - 选择器必须整词匹配：`.tabbar__capsuleWrap` 只是前缀相同，不是同一个选择器。
 */
function ruleBlocks(source: string, selector: string): string[] {
  const clean = stripComments(source)
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 选择器之后允许复合选择器 / 伪类 / 选择器列表，直到开括号；`(?![\w-])` 挡前缀误配
  const head = new RegExp(`${escaped}(?![\\w-])[^{};]*\\{`, 'g')
  const blocks: string[] = []
  for (const match of clean.matchAll(head)) {
    const open = (match.index ?? 0) + match[0].length - 1
    const close = matchingBrace(clean, open)
    if (close === -1) continue
    blocks.push(clean.slice(open + 1, close))
  }
  return blocks
}

/** 取第一处规则体；不存在时返回空串 */
function ruleBlock(source: string, selector: string): string {
  return ruleBlocks(source, selector)[0] ?? ''
}

/** 取 `@mixin <name>` 的声明体（深度扫描，支持参数与块内嵌套） */
function mixinBody(style: string, name: string): string {
  const clean = stripComments(style)
  const head = new RegExp(`@mixin\\s+${name}(?![\\w-])[^{]*\\{`).exec(clean)
  if (!head) return ''
  const open = head.index + head[0].length - 1
  const close = matchingBrace(clean, open)
  return close === -1 ? '' : clean.slice(open + 1, close)
}

/** 把 `@include <name>;` / `@include <name>();` 就地展开成 mixin 声明体（不递归） */
function expandMixins(style: string, mixins: string): string {
  return style.replace(/@include\s+([\w-]+)\s*(?:\(\s*\))?\s*;/g, (whole, name: string) => {
    const body = mixinBody(mixins, name)
    return body === '' ? whole : body
  })
}

describe('custom-tab-bar 胶囊样式契约', () => {
  test('.tabbar__capsule 必须显式 border-box（外宽不得超出 130.8rpx 槽位）', async () => {
    // 主规则在文件里排在 `@media (prefers-reduced-motion)` 之前；取带 width 的那块，
    // 免得哪天把媒体查询挪到前面就误判
    const block = ruleBlocks(await tabbarStyle(), '.tabbar__capsule').find((body) =>
      body.includes('width:'),
    )
    expect(block).toBeDefined()
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
   * 断言覆盖所有同名规则体（含 `@media` 内、含嵌套规则）、大小写不敏感、并把
   * `@include` 展开 —— 换写法（后置规则 / 伪类 / 媒体查询 / `@include glass`）都绕不过去。
   */
  test('.tabbar__capsule 不得带第二层实时背景模糊（#686 切页卡顿）', async () => {
    const style = await tabbarStyle()
    const mixins = await mixinsSource()
    const blocks = ruleBlocks(style, '.tabbar__capsule')
    expect(blocks.length).toBeGreaterThan(0)
    for (const block of blocks) {
      expect(expandMixins(block, mixins)).not.toMatch(/backdrop-filter\s*:/i)
    }
  })

  /**
   * 同一验收项的另一半（Issue「底栏悬浮玻璃外观保留」）：#686 只许去掉**胶囊**的第二层模糊。
   * 栏体自己的 `glass-bar` 必须留着，而且 `glass-bar` 配方本身仍要带两层背景滤镜 ——
   * 只断言 `@include glass-bar` 这串 token 是守不住的：把 mixin 里的滤镜删掉同样能通过，
   * 那时胶囊只剩 22% 白底，底栏不再是悬浮玻璃。
   */
  test('.tabbar 栏体仍走 glass-bar，且该配方仍带两层背景滤镜', async () => {
    const barBlock = ruleBlock(await tabbarStyle(), '.tabbar')
    expect(barBlock).not.toBe('')
    expect(barBlock).toMatch(/@include\s+glass-bar\s*(?:\(\s*\))?\s*;/)

    const body = mixinBody(await mixinsSource(), 'glass-bar')
    expect(body).not.toBe('')
    expect(body).toMatch(/(?<!-webkit-)backdrop-filter\s*:\s*blur/)
    expect(body).toMatch(/-webkit-backdrop-filter\s*:\s*blur/)
  })
})

import { describe, expect, test } from 'bun:test'

/**
 * 首页吸顶分类条的三条行为，在**源码层**的接线（#320 审查 P1/P2 + 第二轮复查）。
 *
 * `tests/home-category-settle.test.ts` 锁的是纯判据（落点、要不要锁），锁不住下面这些 ——
 * 它们只在 `pages/home/index.tsx` / `index.scss` 的源码里可见，写错了不会有任何编译或
 * 运行时错误：
 *
 * 1. **`window.setTimeout` 不能用**：真机的小程序逻辑层没有浏览器 `window`，这一行会抛
 *    `ReferenceError`，分类切换在 `load()` / `pageScrollTo()` 之前就断掉。⚠️ 这条**端上
 *    演示测不出来** —— 开发者工具的模拟器自己注入了浏览器式全局（实测 `typeof window ===
 *    'object'`、`window === globalThis`、`window.setTimeout` 可用），只有真机才会炸。
 * 2. **锁必须真的合上**：`lockNavSettle` 里那句 `navSettleRef.current = true` 没了的话，
 *    防抖动整条失效 —— 而「解锁」「读锁」都还在，只看后两者会全绿。
 * 3. **锁的时长必须用常量**：换成字面量（尤其小于滚动时长）就等于没有余量，动画没跑完
 *    就松锁，判定在末尾翻面 = 要消除的那个抖动。
 * 4. **连点要换掉旧定时器**：A→B→C 连点时，A 的定时器会在 C 的动画没跑完时先解锁。
 * 5. **只在真的会滚动时才上锁**：页面还没过吸顶点时落点 = 当前位置，无条件上锁会让
 *    「点完立刻下滑」的 260ms 里吸顶条出不来。
 * 6. **卸载清定时器**：迟到的回调不该写回已销毁的页面。
 * 7. **`is-pinned` 过渡 + 隐藏态不挡点击**：常驻渲染后靠类名切显隐，`visibility: hidden`
 *    是「藏起来还不吃点击」的唯一保证；样式退回条件渲染 / 丢掉 `visibility` 都看不出来。
 *
 * 断言一律跑在 `code()` **去掉注释之后**的源码上，并切到具体片段：整份文件的子串命中挡
 * 不住「守卫挪到了 setter 之后」，而本页注释里正逐条解释着这些机制 —— 只在原文上查
 * `toContain`，把某行注释掉也能过。
 */

async function homeSource(): Promise<string> {
  return await Bun.file(new URL('../src/pages/home/index.tsx', import.meta.url)).text()
}

async function homeStyle(): Promise<string> {
  return await Bun.file(new URL('../src/pages/home/index.scss', import.meta.url)).text()
}

/**
 * 去掉注释后的源码：断言必须看**代码**。
 *
 * `//.*$` 也会切掉字符串里的 `//`（如 URL），本页没有这种字面量 —— 真加进来时这条
 * 注释就是提醒：届时换成 AST 或更保守的剥离。
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/** 取 `from` 到其后第一个 `to` 之间的**代码**（两端都不含） */
async function slice(from: string, to: string): Promise<string> {
  const text = code(await homeSource())
  const start = text.indexOf(from)
  expect(start, `代码里缺少片段：${from}`).toBeGreaterThanOrEqual(0)
  const end = text.indexOf(to, start + from.length)
  expect(end, `代码里缺少片段：${to}`).toBeGreaterThan(start)
  return text.slice(start + from.length, end)
}

describe('小程序运行时：不许用 browser-only 的 window', () => {
  test('页面源码里没有 window（原生小程序没有这个全局）', async () => {
    expect(code(await homeSource())).not.toContain('window')
  })

  test('解锁定时器走全局 setTimeout，且句柄存进 ref（可取消）', async () => {
    const lock = await slice('const lockNavSettle = ', 'const releaseNavSettle')
    expect(lock).toContain('navSettleTimerRef.current = setTimeout(')
    // 回调里把句柄归零：否则已释放的句柄留在 ref 上，下一次 clear 清的是空气
    expect(lock).toContain('navSettleTimerRef.current = null')
    expect(lock).toContain('navSettleRef.current = false')
  })
})

describe('归位锁：真的合上、用常量计时、连点换掉旧 timer', () => {
  test('上锁时把判定置 true —— 少了这句，防抖动整条失效', async () => {
    const lock = await slice('const lockNavSettle = ', 'const releaseNavSettle')
    expect(lock).toContain('navSettleRef.current = true')
  })

  test('锁时长取自 NAV_SETTLE_MS，不是字面量', async () => {
    const lock = await slice('const lockNavSettle = ', 'const releaseNavSettle')
    // 计时参数必须用常量：换成 `10` 这类字面量就等于没有余量（动画没跑完就松锁）
    const armed = /setTimeout\(\s*\(\)\s*=>\s*\{[\s\S]*?\}\s*,\s*([A-Za-z_$][\w$]*)\s*\)/.exec(lock)
    expect(armed, `setTimeout 的时长不是标识符：${lock}`).not.toBeNull()
    expect(armed?.[1]).toBe('NAV_SETTLE_MS')
  })

  test('解锁后按当前位置重算吸顶态（否则锁住的旧值会一直挂着）', async () => {
    const lock = await slice('const lockNavSettle = ', 'const releaseNavSettle')
    // 定时器回调里要补这一算：锁定期间那些滚动事件都被强制成旧值了
    expect(lock).toContain('syncCatsPinned()')
    // 「不需要归位」那一支也要重算 —— 否则上一轮的锁留下的判定无人纠正
    const release = await slice('const releaseNavSettle = ', 'useUnload(')
    expect(release).toContain('syncCatsPinned()')
    // 重算本身必须是「按当前位置比阈值」，不是把某个常量写死
    const sync = await slice('const syncCatsPinned = ', 'const clearNavSettle')
    expect(sync).toContain('scrollTopRef.current >= pinAt.current')
  })

  test('卸载路径只清账、不 setState（已销毁页面不该被写）', async () => {
    const clear = await slice('const clearNavSettle = ', 'const releaseNavSettle')
    expect(clear).toContain('clearTimeout(navSettleTimerRef.current)')
    expect(clear).toContain('navSettleRef.current = false')
    expect(clear).not.toContain('setCatsPinned')
    expect(code(await homeSource())).toContain('useUnload(clearNavSettle)')
  })

  test('上锁前先清掉上一轮的定时器', async () => {
    const lock = await slice('const lockNavSettle = ', 'const releaseNavSettle')
    // `clearTimeout` 必须出现在 `setTimeout` **之前** —— 挪到后面就等于没防住 A 的旧回调
    const cleared = lock.indexOf('clearTimeout(navSettleTimerRef.current)')
    const armed = lock.indexOf('navSettleTimerRef.current = setTimeout(')
    expect(cleared).toBeGreaterThanOrEqual(0)
    expect(armed).toBeGreaterThanOrEqual(0)
    expect(cleared).toBeLessThan(armed)
  })
})

describe('锁只跟真位移走（不然「点完立刻下滑」吸顶条出不来）', () => {
  test('onCategoryTap 用 resolveCategorySettle 的两个结果分别决定上锁与滚动', async () => {
    const handler = await slice('const onCategoryTap = ', 'const navHeight')
    expect(handler).toContain('resolveCategorySettle(scrollTopRef.current, pinAt.current)')
    expect(handler).toContain('if (repositions) lockNavSettle()')
    // 不需要归位那一支必须**主动解锁**：上一轮的锁若还挂着，判定会一直钉在旧值上
    expect(handler).toContain('else releaseNavSettle()')
    // 两次 `pageScrollTo`（重复点当前分类 / 换分类）都受同一个判据管。压掉空白再数：
    // biome 会把单行 `if` 折成两行，按原样匹配会把格式当成语义
    const flat = handler.replace(/\s+/g, ' ')
    expect((flat.match(/if \(repositions\) void Taro\.pageScrollTo\(/g) ?? []).length).toBe(2)
    expect((flat.match(/void Taro\.pageScrollTo\(/g) ?? []).length).toBe(2)
    // 常量从 nav-settle 来，不在页面里另写数字
    expect(handler).toContain('CATEGORY_SCROLL_DURATION')
    expect(await homeSource()).toContain("from './nav-settle'")
  })

  test('吸顶判定按锁分流，且判定取自 navSettleRef（不是 state）', async () => {
    const scroll = await slice('usePageScroll(({ scrollTop }) => {', 'const backToTop')
    expect(scroll).toContain('navSettleRef.current ? catsPinned : scrollTop >= pinAt.current')
  })
})

describe('卸载清理', () => {
  test('useUnload 接的是只清账的 clearNavSettle（不是会 setState 的 release）', async () => {
    expect(code(await homeSource())).toContain('useUnload(clearNavSettle)')
    // 卸载路径不能走 `releaseNavSettle`：它会补一次 `syncCatsPinned`（= setState），
    // 而卸载后的 setState 是往已销毁的页面写
    expect(code(await homeSource())).not.toContain('useUnload(releaseNavSettle)')
    // `useUnload` 得从 `@tarojs/taro` 真导入，不能只是写了个名字
    const importBlock = await slice('import Taro, {', "} from '@tarojs/taro'")
    expect(importBlock).toContain('useUnload')
  })

  test('clearNavSettle 同时清定时器与判定（只清一个都会留下脏状态）', async () => {
    const clear = await slice('const clearNavSettle = ', 'const releaseNavSettle')
    expect(clear).toContain('clearTimeout(navSettleTimerRef.current)')
    expect(clear).toContain('navSettleTimerRef.current = null')
    expect(clear).toContain('navSettleRef.current = false')
  })
})

describe('吸顶条的显隐：常驻渲染 + is-pinned 过渡', () => {
  test('吸顶条常驻渲染，靠 `is-pinned` 类切显隐（退回条件渲染就没有过渡了）', async () => {
    const source = code(await homeSource())
    // 拼接出来的类名：`home__catnav` + 条件后缀 `is-pinned`。写成普通字符串避免
    // biome 的 noTemplateCurlyInString 想看反引号
    const pinnedSuffix = '${' + "catsPinned ? ' is-pinned' : ''" + '}'
    expect(source).toContain(`home__catnav${pinnedSuffix}`)
    // 反面：不许再出现「按 catsPinned 决定渲不渲染整块」的写法
    expect(source).not.toContain('{catsPinned ? (')
  })

  /** 取 scss 里 `.home__catnav` 的基础规则（到 `&.is-pinned` 之前） */
  async function baseRule(): Promise<string> {
    const style = await homeStyle()
    const at = style.indexOf('.home__catnav {')
    expect(at, 'scss 里没有 .home__catnav').toBeGreaterThanOrEqual(0)
    return style.slice(at, style.indexOf('&.is-pinned', at))
  }

  test('隐藏态：位移 + 透明 + `visibility: hidden`（藏起来还要不吃下层点击）', async () => {
    const base = await baseRule()
    expect(base).toContain('translateY(-110%)')
    expect(base).toContain('opacity: 0')
    // 少了 `visibility: hidden`，隐藏的吸顶条会挡住顶栏下方那一行的点击
    expect(base).toContain('visibility: hidden')
  })

  test('过渡：滑出结束再生效 visibility（否则滑到一半就不可见了）', async () => {
    const base = await baseRule()
    const transition = /transition:\s*([\s\S]*?);/.exec(base)
    expect(transition, '基础规则没有 transition').not.toBeNull()
    // 延迟 = 位移时长，让「先滑出去、再彻底隐藏」
    expect(transition?.[1]).toContain('visibility 0s linear')
    expect(transition?.[1]).toMatch(/visibility 0s linear 0\.\d+s/)
  })

  test('is-pinned 态：归位、可见，且 transition 不再延迟 visibility', async () => {
    const style = await homeStyle()
    const at = style.indexOf('&.is-pinned')
    const pinned = style.slice(at, style.indexOf('}', style.indexOf('transition', at)))
    expect(pinned).toContain('transform: translateY(0)')
    expect(pinned).toContain('opacity: 1')
    expect(pinned).toContain('visibility: visible')
    expect(pinned).not.toContain('visibility 0s linear')
  })
})
